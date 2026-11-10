import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { ContextEqualizerConfig, InjectedContext, RuntimeState } from "./types.ts";
import { CONTEXT_META_CUSTOM_TYPE } from "./types.ts";
import { estimateTextTokens, truncateToTokenBudget } from "./util.ts";

/**
 * Composes the prompt before each run: moves memory files and the skill
 * catalog out of the system prompt into a meta-message (claude layout), adds
 * a git snapshot section, and applies the configured tool set.
 */
export function registerComposition(pi: ExtensionAPI, state: RuntimeState): void {
	pi.on("before_agent_start", async (event) => {
		const cfg = state.config.composition;
		const o = event.systemPromptOptions;

		if (cfg.layout === "claude") {
			const injected = buildInjectedContext(o, cfg);
			state.composition.injected = injected;
			state.composition.lastInjected = injected;
		}

		if (cfg.gitSnapshot) {
			try {
				const status = await pi.exec("git", ["status", "--short", "-b"], { cwd: o.cwd });
				const log = await pi.exec("git", ["log", "-5", "--oneline"], { cwd: o.cwd });
				if (status.code === 0 && log.code === 0) {
					o.sections = {
						...o.sections,
						git_context: `branch/status block:\n${status.stdout.trim()}\n\nrecent commits:\n${log.stdout.trim()}`,
					};
				}
			} catch {
				// No git, no repo, or exec failure: skip the snapshot for this run.
			}
		}

		if (cfg.tools.active !== null) {
			o.selectedTools = [...cfg.tools.active];
		}
		for (const name of cfg.tools.hidden) {
			if (!o.hiddenTools.includes(name)) {
				o.hiddenTools.push(name);
			}
		}
	});
}

/**
 * Moves the memory and skills layers out of `o` and returns their texts and
 * metrics for the meta-message. Returns null when nothing was moved.
 */
function buildInjectedContext(
	o: NormalizedBuildSystemPromptOptions,
	cfg: ContextEqualizerConfig["composition"],
): InjectedContext | null {
	let memoryText = "";
	let memoryFiles: InjectedContext["memoryFiles"] = [];
	if (cfg.memory.enabled) {
		const joined = o.contextFiles
			.map((file) => `<file path="${file.path}">\n${file.content}\n</file>`)
			.join("\n\n");
		memoryText = truncateToTokenBudget(joined, cfg.memory.maxTokens).text;
		memoryFiles = o.contextFiles.map((file) => ({ path: file.path, tokens: estimateTextTokens(file.content) }));
		o.contextFiles = [];
	}

	let skillsText = "";
	let skills: InjectedContext["skills"] = [];
	if (cfg.skills.enabled) {
		const lines = o.skills.map((skill) => `- ${skill.name}: ${skill.description}`);
		skillsText = truncateToTokenBudget(lines.join("\n"), cfg.skills.maxCatalogTokens).text;
		skills = o.skills.map((skill) => ({
			name: skill.name,
			tokens: estimateTextTokens(`- ${skill.name}: ${skill.description}`),
		}));
		o.skills = [];
	}

	if (!memoryText && !skillsText) return null;
	return { memoryText, skillsText, memoryFiles, skills };
}

/**
 * Prepends the Claude-style meta-message carrying the injected memory and
 * skills text when layout is "claude" and a payload was built for the current
 * run. The input is the non-system message list from the `context` event.
 */
export function applyContextInjection(
	messages: AgentMessage[],
	state: RuntimeState,
): AgentMessage[] {
	const injected = state.composition.injected;
	if (state.config.composition.layout !== "claude" || injected === null) {
		return messages;
	}

	const parts: string[] = [];
	if (injected.memoryText) parts.push(injected.memoryText);
	if (injected.skillsText) parts.push(injected.skillsText);
	const text = `<system-reminder>\n${parts.join("\n\n")}\n</system-reminder>`;

	const first = messages[0];
	if (first?.role === "custom" && first.customType === CONTEXT_META_CUSTOM_TYPE) {
		first.content = text;
		return messages;
	}
	return [
		{
			role: "custom",
			customType: CONTEXT_META_CUSTOM_TYPE,
			content: text,
			display: false,
			timestamp: Date.now(),
		},
		...messages,
	];
}
