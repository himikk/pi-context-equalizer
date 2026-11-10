import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	estimateTokens,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { applyContextInjection } from "./composition.ts";
import { clampPercent, estimateTextTokens, formatTokens } from "./util.ts";
import {
	CONTEXT_META_CUSTOM_TYPE,
	type ContextCategory,
	type ContextFileMetric,
	type ContextGridSquare,
	type ContextUsageData,
	type RuntimeState,
	type SkillMetric,
	type ToolMetric,
} from "./types.ts";

const GRID_SQUARES = 100;
const GRID_WIDTH = 10;
const DEFAULT_RESERVE_TOKENS = 16_384;
const TOOL_RESULT_SUGGESTION_SHARE = 0.25;
const CATEGORY_SUGGESTION_SHARE = 0.1;
const MAX_SUGGESTIONS = 3;

/**
 * Collects the context usage snapshot shown by /context: category estimates
 * from the composed message list, tool declarations, memory and skills,
 * plus the reserve-aware grid.
 */
export function collectContextData(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	state: RuntimeState,
): ContextUsageData {
	const usage = ctx.getContextUsage();
	const model = ctx.model;
	const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;

	const layout = state.config.composition.layout;
	const claudeLayout = layout === "claude";
	const injected = claudeLayout
		? (state.composition.injected ?? state.composition.lastInjected)
		: null;

	const displayed = applyContextInjection(ctx.sessionManager.buildSessionProjection().messages, state);
	const { systemTokens, userMessageTokens, assistantMessageTokens, toolResultTokens, messageTokens } =
		countMessageTokens(displayed);

	const { memoryFiles, skills, memoryTokens, skillTokens } = collectMemoryAndSkills(ctx, injected);

	const { tools, toolDeclarationTokens, mcpToolTokens } = collectTools(pi);
	const systemPromptTokens = Math.max(
		0,
		systemTokens - toolDeclarationTokens - mcpToolTokens - (claudeLayout ? memoryTokens + skillTokens : 0),
	);

	const systemPromptCategory: ContextCategory = {
		name: "System prompt",
		tokens: systemPromptTokens,
		color: "accent",
	};
	const systemToolsCategory: ContextCategory = {
		name: "System tools",
		tokens: toolDeclarationTokens,
		color: "syntaxFunction",
	};
	const mcpToolsCategory: ContextCategory = { name: "MCP tools", tokens: mcpToolTokens, color: "syntaxType" };
	const memoryCategory: ContextCategory = { name: "Memory files", tokens: memoryTokens, color: "success" };
	const skillsCategory: ContextCategory = { name: "Skills", tokens: skillTokens, color: "syntaxKeyword" };
	const messagesCategory: ContextCategory = { name: "Messages", tokens: messageTokens, color: "warning" };
	const categories: ContextCategory[] = [
		systemPromptCategory,
		systemToolsCategory,
		mcpToolsCategory,
		memoryCategory,
		skillsCategory,
		messagesCategory,
	];

	const estimated = categories.reduce((sum, category) => sum + category.tokens, 0);
	const usedTokens = usage?.tokens ?? estimated;
	const percent = contextWindow > 0 ? clampPercent((usedTokens / contextWindow) * 100) : 0;
	if (usage?.tokens != null && estimated > 0 && usedTokens !== estimated) {
		scaleCategories(categories, usedTokens, estimated);
	}

	const settings = pi.getSettings();
	const modelKey = model ? `${model.provider}/${model.id}` : undefined;
	const modelOverride = modelKey !== undefined ? settings.compaction?.modelOverrides?.[modelKey] : undefined;
	const reserveTokens = modelOverride?.reserveTokens ?? settings.compaction?.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
	const freeTokens = Math.max(0, contextWindow - usedTokens - reserveTokens);

	const suggestions = buildSuggestions({
		percent,
		contextWindow,
		toolResultTokens,
		mcpToolTokens: mcpToolsCategory.tokens,
		memoryTokens: memoryCategory.tokens,
	});

	return {
		timestamp: Date.now(),
		model: model ? `${model.provider}/${model.id}` : "unknown",
		cwd: ctx.cwd,
		contextWindow,
		usedTokens,
		percent,
		reserveTokens,
		freeTokens,
		categories,
		gridRows: buildGrid(categories, contextWindow, reserveTokens),
		systemPromptTokens: systemPromptCategory.tokens,
		toolDeclarationTokens: systemToolsCategory.tokens,
		mcpToolTokens: mcpToolsCategory.tokens,
		memoryFileTokens: memoryCategory.tokens,
		skillTokens: skillsCategory.tokens,
		messageTokens: messagesCategory.tokens,
		userMessageTokens,
		assistantMessageTokens,
		toolResultTokens,
		memoryFiles,
		tools,
		skills,
		suggestions,
		layout,
	};
}

interface MessageTokenBreakdown {
	systemTokens: number;
	userMessageTokens: number;
	assistantMessageTokens: number;
	toolResultTokens: number;
	messageTokens: number;
}

function countMessageTokens(messages: AgentMessage[]): MessageTokenBreakdown {
	let systemTokens = 0;
	let userMessageTokens = 0;
	let assistantMessageTokens = 0;
	let toolResultTokens = 0;
	let otherMessageTokens = 0;
	for (const message of messages) {
		if (message.role === "system") {
			systemTokens += estimateTokens(message);
			continue;
		}
		// The meta message carries the memory/skills payload, counted in those categories instead.
		if (message.role === "custom" && message.customType === CONTEXT_META_CUSTOM_TYPE) {
			continue;
		}
		const tokens = estimateTokens(message);
		if (message.role === "user") userMessageTokens += tokens;
		else if (message.role === "assistant") assistantMessageTokens += tokens;
		else if (message.role === "toolResult") toolResultTokens += tokens;
		else otherMessageTokens += tokens;
	}
	return {
		systemTokens,
		userMessageTokens,
		assistantMessageTokens,
		toolResultTokens,
		messageTokens: userMessageTokens + assistantMessageTokens + toolResultTokens + otherMessageTokens,
	};
}

interface MemoryAndSkills {
	memoryFiles: ContextFileMetric[];
	skills: SkillMetric[];
	memoryTokens: number;
	skillTokens: number;
}

function collectMemoryAndSkills(
	ctx: ExtensionCommandContext,
	injected: RuntimeState["composition"]["injected"],
): MemoryAndSkills {
	if (injected) {
		return {
			memoryFiles: injected.memoryFiles,
			skills: injected.skills,
			memoryTokens: estimateTextTokens(injected.memoryText),
			skillTokens: estimateTextTokens(injected.skillsText),
		};
	}
	const options = ctx.getSystemPromptOptions();
	const memoryFiles = (options?.contextFiles ?? []).map((file) => ({
		path: file.path,
		tokens: estimateTextTokens(file.content),
	}));
	const skills = (options?.skills ?? []).map((skill) => ({
		name: skill.name,
		tokens: estimateTextTokens(`- ${skill.name}: ${skill.description}`),
	}));
	return {
		memoryFiles,
		skills,
		memoryTokens: memoryFiles.reduce((sum, file) => sum + file.tokens, 0),
		skillTokens: skills.reduce((sum, skill) => sum + skill.tokens, 0),
	};
}

interface ToolBreakdown {
	tools: ToolMetric[];
	toolDeclarationTokens: number;
	mcpToolTokens: number;
}

function collectTools(pi: ExtensionAPI): ToolBreakdown {
	const tools: ToolMetric[] = [];
	let toolDeclarationTokens = 0;
	let mcpToolTokens = 0;
	for (const tool of pi.getAllTools()) {
		const text =
			tool.name +
			tool.description +
			JSON.stringify(tool.parameters) +
			(tool.promptGuidelines ?? []).join("\n");
		const tokens = estimateTextTokens(text);
		const path = tool.sourceInfo.path;
		const group = path === "builtin:mcp" ? "mcp" : path.startsWith("builtin:") ? "builtin" : "extension";
		tools.push({ name: tool.name, tokens, group });
		if (group === "mcp") mcpToolTokens += tokens;
		else toolDeclarationTokens += tokens;
	}
	return { tools, toolDeclarationTokens, mcpToolTokens };
}

/** Scales the category estimates so they sum to the measured usage. */
function scaleCategories(categories: ContextCategory[], usedTokens: number, estimated: number): void {
	const factor = usedTokens / estimated;
	let scaled = 0;
	for (const category of categories) {
		category.tokens = Math.round(category.tokens * factor);
		scaled += category.tokens;
	}
	const largest = categories.reduce((max, category) => (category.tokens > max.tokens ? category : max));
	largest.tokens = Math.max(0, largest.tokens + usedTokens - scaled);
}

function buildSuggestions(input: {
	percent: number;
	contextWindow: number;
	toolResultTokens: number;
	mcpToolTokens: number;
	memoryTokens: number;
}): string[] {
	const suggestions: string[] = [];
	if (input.percent >= 80) {
		suggestions.push("Context is above 80% — run /compact or lower compaction.earlyTriggerPercent.");
	}
	if (input.contextWindow > 0 && input.toolResultTokens > input.contextWindow * TOOL_RESULT_SUGGESTION_SHARE) {
		suggestions.push("Tool results dominate — enable microcompact to clear old results.");
	}
	if (input.contextWindow > 0 && input.mcpToolTokens > input.contextWindow * CATEGORY_SUGGESTION_SHARE) {
		suggestions.push("MCP tool declarations are large — disable unused MCP servers.");
	}
	if (input.contextWindow > 0 && input.memoryTokens > input.contextWindow * CATEGORY_SUGGESTION_SHARE) {
		suggestions.push("Memory files are heavy — trim context files.");
	}
	return suggestions.slice(0, MAX_SUGGESTIONS);
}

/**
 * Builds the 10x10 grid: squares allocated to the categories proportionally
 * to their share of the window (min 1 per non-empty category), free space in
 * between, and the compaction reserve at the end.
 */
export function buildGrid(
	categories: ContextCategory[],
	contextWindow: number,
	reserveTokens: number,
): ContextGridSquare[][] {
	if (contextWindow <= 0) return [];
	const reservedSquares = Math.min(99, Math.max(0, Math.round((reserveTokens / contextWindow) * 100)));
	const usedSquares = GRID_SQUARES - reservedSquares;

	const squares: ContextGridSquare[] = [];
	let remaining = usedSquares;
	for (const category of categories) {
		if (category.tokens <= 0) continue;
		const exact = (category.tokens / contextWindow) * 100;
		const fraction = exact - Math.floor(exact);
		const fullness = fraction === 0 ? 1 : fraction;
		const count = Math.min(Math.max(1, Math.round(exact)), remaining);
		remaining -= count;
		for (let i = 0; i < count; i++) {
			squares.push({ category: category.name, color: category.color, fullness });
		}
	}
	for (let i = 0; i < remaining; i++) {
		squares.push({ category: "Free space", color: "dim", fullness: 1 });
	}
	for (let i = 0; i < reservedSquares; i++) {
		squares.push({ category: "Autocompact buffer", color: "dim", fullness: 1 });
	}

	const rows: ContextGridSquare[][] = [];
	for (let i = 0; i < squares.length; i += GRID_WIDTH) {
		rows.push(squares.slice(i, i + GRID_WIDTH));
	}
	return rows;
}

/** Formats a share of the context window, or "N/A" when the window is unknown. */
export function formatContextPercent(tokens: number, contextWindow: number): string {
	if (contextWindow <= 0) return "N/A";
	return `${((tokens / contextWindow) * 100).toFixed(1)}%`;
}

/** One-line context summary for non-TUI modes. */
export function formatContextLine(data: ContextUsageData): string {
	return `Context: ${formatTokens(data.usedTokens)}/${formatTokens(data.contextWindow)} (${Math.round(data.percent)}%)`;
}

/** Claude-style markdown report of the context usage snapshot. */
export function formatContextMarkdown(data: ContextUsageData): string {
	const lines: string[] = ["## Context Usage", ""];
	lines.push(
		`${data.model} · ${formatTokens(data.usedTokens)}/${formatTokens(data.contextWindow)} tokens (${Math.round(data.percent)}%)`,
	);
	lines.push("");
	lines.push("| Category | Tokens | Share |");
	lines.push("| --- | ---: | ---: |");
	for (const category of data.categories) {
		if (category.tokens <= 0) continue;
		lines.push(`| ${category.name} | ${formatTokens(category.tokens)} | ${formatContextPercent(category.tokens, data.contextWindow)} |`);
	}
	lines.push(`| Free space | ${formatTokens(data.freeTokens)} | ${formatContextPercent(data.freeTokens, data.contextWindow)} |`);
	lines.push(
		`| Autocompact buffer | ${formatTokens(data.reserveTokens)} | ${formatContextPercent(data.reserveTokens, data.contextWindow)} |`,
	);

	const mcpTools = data.tools.filter((tool) => tool.group === "mcp");
	if (mcpTools.length > 0) {
		lines.push("", "| MCP tool | Tokens |", "| --- | ---: |");
		for (const tool of mcpTools) {
			lines.push(`| ${tool.name} | ${formatTokens(tool.tokens)} |`);
		}
	}
	if (data.memoryFiles.length > 0) {
		lines.push("", "| Memory file | Tokens |", "| --- | ---: |");
		for (const file of data.memoryFiles) {
			lines.push(`| ${file.path} | ${formatTokens(file.tokens)} |`);
		}
	}
	if (data.skills.length > 0) {
		lines.push("", "| Skill | Tokens |", "| --- | ---: |");
		for (const skill of data.skills) {
			lines.push(`| ${skill.name} | ${formatTokens(skill.tokens)} |`);
		}
	}
	return lines.join("\n");
}
