import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, estimateTokens, serializeConversation } from "@earendil-works/pi-coding-agent";
import { applyContextInjection } from "./composition.ts";
import type { RuntimeState } from "./types.ts";
import { truncateToTokenBudget } from "./util.ts";

/**
 * Claude-style sectioned summary prompt for custom compaction. Exported for tests.
 */
export const SUMMARIZE_PROMPT = `You are a conversation summarizer. Read the conversation wrapped in <conversation> tags and produce a structured markdown summary with EXACTLY these nine sections, in this order, each introduced by a "## " heading:

## Primary Request and Intent
## Key Technical Concepts
## Files and Code Sections
## Errors and fixes
## Problem Solving
## All user messages
## Pending Tasks
## Current Work
## Optional Next Step

Section content:
- Primary Request and Intent: the user's core requests and goals, stated precisely.
- Key Technical Concepts: technologies, libraries, APIs, patterns and constraints in play.
- Files and Code Sections: every file discussed or changed, with its full path, what it contains or what changed in it, and the important functions, signatures and code snippets.
- Errors and fixes: every error encountered, with the exact error text, and how it was or was not resolved.
- Problem Solving: problems tackled and solutions attempted or chosen, including dead ends.
- All user messages: every user message, preserved as verbatim as possible.
- Pending Tasks: incomplete tasks, TODOs and unanswered questions.
- Current Work: what was being worked on immediately before the summary, in enough detail to resume exactly.
- Optional Next Step: the logical next step derived from the current work, if any.

Use "(none)" for a section with nothing to report. The summary replaces the conversation history, so it must be self-contained. NEVER lose or paraphrase away exact file paths, function names, commands, code identifiers, or error texts: copy them verbatim.`;

/**
 * Registers the context-pruning, microcompact, summary and overflow handlers.
 */
export function registerCompaction(pi: ExtensionAPI, state: RuntimeState): void {
	pi.on("context", (event, ctx) => {
		const injected = applyContextInjection(event.messages, state);
		const pruned = applyContextTransform(injected, state, ctx);
		if (pruned === undefined && injected === event.messages) return undefined;
		return { messages: pruned ?? injected };
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const compaction = state.config.compaction;
		if (!compaction.customSummary || state.failures >= compaction.maxFailures) return undefined;

		let source = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
		if (source.length === 0) return undefined;

		const model = resolveSummaryModel(ctx, compaction.summaryModel);
		if (!model) return undefined;

		let firstKeptEntryId = event.preparation.firstKeptEntryId;
		if (event.reason === "overflow" && compaction.overflowAggressive) {
			// Overflow recovery: keep the latest user turn instead of the preparation cut point.
			for (let i = event.branchEntries.length - 1; i >= 0; i--) {
				const entry = event.branchEntries[i];
				if (entry?.type === "message" && entry.message.role === "user") {
					firstKeptEntryId = entry.id;
					break;
				}
			}
		}

		for (let attempt = 1; attempt <= 3; attempt++) {
			if (attempt > 1) {
				// Retry window: drop the oldest half, never below one message.
				source = source.slice(Math.min(Math.floor(source.length / 2), source.length - 1));
			}
			const conversation = serializeConversation(convertToLlm(source));
			const previousSummary = event.preparation.previousSummary;
			const previousBlock = previousSummary
				? `The conversation continues from the previous summary below. Merge it with the new conversation, keeping every prior detail that is still relevant.\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
				: "";
			const prompt = `${SUMMARIZE_PROMPT}\n\n${previousBlock}<conversation>\n${conversation}\n</conversation>`;

			try {
				const response = await ctx.modelRegistry.complete(
					model,
					{
						messages: [
							{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
						],
					},
					{
						maxTokens: compaction.maxSummaryTokens,
						signal: event.signal,
						cacheRetention: "none",
					},
				);
				const summary = response.content
					.filter((block): block is TextContent => block.type === "text")
					.map((block) => block.text)
					.join("\n")
					.trim();
				if (!summary || response.stopReason === "length" || response.stopReason === "error") continue;
				return {
					compaction: {
						summary,
						firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						usage: response.usage,
						// Same shape the host compaction produces, so post-compact
						// restore works for extension summaries too.
						details: {
							readFiles: [...event.preparation.fileOps.read],
							modifiedFiles: [...event.preparation.fileOps.written, ...event.preparation.fileOps.edited],
						},
					},
				};
			} catch {
				// Internal retry, not a breaker failure; the host falls back after the last attempt.
			}
		}
		return undefined;
	});

	pi.on("session_compact", async (event, ctx) => {
		state.failures = 0;
		state.compacting = false;
		ctx.ui.setStatus("context-equalizer", undefined);

		if (!state.config.restore.enabled) return;
		try {
			const blocks = await collectRestoredFiles(event.compactionEntry.details, state.config.restore);
			if (blocks.length === 0) return;
			pi.sendMessage(
				{
					customType: "context-equalizer-restore",
					content: `<restored-files>\n${blocks.join("\n")}\n</restored-files>`,
					display: false,
				},
				{ triggerTurn: false },
			);
		} catch {
			// Restore must never break the compact event.
		}
	});

	pi.on("session_compact_failed", (event, ctx) => {
		state.compacting = false;
		// User aborts are not failures: they must not spend breaker budget.
		if (event.aborted) return;
		state.failures++;
		if (state.failures > 0) ctx.ui.setStatus("context-equalizer", `failures:${state.failures}`);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const threshold = state.config.compaction.earlyTriggerPercent;
		if (threshold === null || state.compacting) return;
		const usage = ctx.getContextUsage();
		if (usage?.percent == null || usage.percent < threshold) return;
		state.compacting = true;
		try {
			ctx.compact({
				onComplete: () => {
					state.compacting = false;
				},
				onError: () => {
					state.compacting = false;
					ctx.ui.notify("Context equalizer compaction failed", "error");
				},
			});
		} catch {
			state.compacting = false;
		}
	});
}

/**
 * Applies L0 prune (truncate + dedupe) and L1 microcompact (clear old results) to the
 * outgoing message list. Returns undefined when nothing changed, so the cached prefix
 * stays intact; never mutates the input array or shared message objects.
 */
export function applyContextTransform(
	messages: AgentMessage[],
	state: RuntimeState,
	ctx: ExtensionContext,
): AgentMessage[] | undefined {
	const config = state.config.microcompact;
	if (!config.enabled) return undefined;
	// Current turn: everything after the last user message is never touched.
	const boundary = findCurrentTurnBoundary(messages);

	let output = messages;
	let truncated = 0;
	let deduped = 0;
	let savedTokens = 0;

	// L0 prune: truncate long text blocks, then dedupe identical results.
	const dedupeKeys = new Set<string>();
	for (let i = 0; i < boundary; i++) {
		const message = output[i];
		if (message?.role !== "toolResult") continue;
		const tokensBefore = estimateTokens(message);
		if (tokensBefore < config.minTokens) continue;

		let content = message.content;
		let changed = false;
		let clippedAny = false;
		const clipped = content.map((block) => {
			if (block.type !== "text" || block.text.length <= config.maxChars) return block;
			clippedAny = true;
			return {
				...block,
				text: `${block.text.slice(0, config.maxChars)}\n[... ${block.text.length - config.maxChars} characters truncated]`,
			};
		});
		if (clippedAny) {
			content = clipped;
			truncated++;
			changed = true;
		}

		if (config.dedupe) {
			// Key after truncation, so clipped twins still dedupe.
			const key = JSON.stringify(content);
			if (dedupeKeys.has(key)) {
				content = [{ type: "text", text: `[Duplicate of earlier ${message.toolName} result]` }];
				deduped++;
				changed = true;
			} else {
				dedupeKeys.add(key);
			}
		}

		if (changed) {
			const replacement: ToolResultMessage = { ...message, content };
			if (output === messages) output = messages.slice();
			output[i] = replacement;
			savedTokens += tokensBefore - estimateTokens(replacement);
		}
	}

	// L1 microcompact: clear old tool results once active.
	let cleared = 0;
	let mcSavedTokens = 0;
	if (microcompactActive(config, messages, ctx)) {
		const candidates: Array<{ index: number; message: ToolResultMessage }> = [];
		for (let i = 0; i < boundary; i++) {
			const message = output[i];
			if (message?.role === "toolResult") candidates.push({ index: i, message });
		}
		// Newest keepRecent results by array order stay untouched.
		const keptFrom = Math.max(0, candidates.length - config.keepRecent);
		for (const { index, message } of candidates.slice(0, keptFrom)) {
			if (config.keepErrors && message.isError) continue;
			const tokensBefore = estimateTokens(message);
			const replacement: ToolResultMessage = {
				...message,
				content: [{ type: "text", text: "[Old tool result content cleared]" }],
			};
			if (output === messages) output = messages.slice();
			output[index] = replacement;
			cleared++;
			mcSavedTokens += tokensBefore - estimateTokens(replacement);
		}
	}

	state.lastPrune = { truncated, deduped, droppedThinking: 0, savedTokens };
	state.lastMicrocompact = { cleared, savedTokens: mcSavedTokens };

	const parts: string[] = [];
	if (truncated > 0) parts.push(`prune:${truncated}`);
	if (deduped > 0) parts.push(`dedupe:${deduped}`);
	if (cleared > 0) parts.push(`mc:${cleared}`);
	if (parts.length > 0) ctx.ui.setStatus("context-equalizer", parts.join(" "));

	return output === messages ? undefined : output;
}

/** Index of the last user message (the current-turn boundary), or -1 when none. */
function findCurrentTurnBoundary(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return i;
	}
	return -1;
}

/** Whether L1 microcompact is active for this pass. */
function microcompactActive(
	config: RuntimeState["config"]["microcompact"],
	messages: AgentMessage[],
	ctx: ExtensionContext,
): boolean {
	if (config.mode === "threshold") {
		const usage = ctx.getContextUsage();
		return usage?.percent != null && usage.percent >= config.minPercent;
	}
	const last = messages.at(-1);
	return last !== undefined && Date.now() - last.timestamp >= config.gapMinutes * 60_000;
}

/** The summary model: configured "provider/modelId" when found, else the current model. */
function resolveSummaryModel(ctx: ExtensionContext, summaryModel: string | null): Model<Api> | undefined {
	if (summaryModel) {
		const separator = summaryModel.indexOf("/");
		if (separator > 0) {
			const found = ctx.modelRegistry.find(summaryModel.slice(0, separator), summaryModel.slice(separator + 1));
			if (found) return found;
		}
	}
	return ctx.model;
}

/**
 * Reads the post-compact restore files from a compaction entry's details, truncated to the
 * configured budgets. Returns one `<file>` block per file, modified files first.
 */
async function collectRestoredFiles(
	raw: unknown,
	config: RuntimeState["config"]["restore"],
): Promise<string[]> {
	// Session-format trust boundary: details cross the serialized session file.
	const details = (raw ?? {}) as { readFiles?: unknown; modifiedFiles?: unknown };
	const paths = [...stringArray(details.modifiedFiles), ...stringArray(details.readFiles)];
	const totalBudget = config.maxTokens * 4;
	let totalChars = 0;
	const blocks: string[] = [];
	for (const filePath of paths) {
		if (blocks.length >= config.maxFiles || totalChars >= totalBudget) break;
		let text: string;
		try {
			text = await readFile(filePath, "utf8");
		} catch {
			continue; // Missing or unreadable files are skipped.
		}
		const clipped = truncateToTokenBudget(text, config.maxTokensPerFile);
		blocks.push(`<file path="${filePath}">\n${clipped.text}\n</file>`);
		totalChars += clipped.text.length;
	}
	return blocks;
}

/** String elements of an untrusted value; non-arrays and non-strings are dropped. */
function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
