import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export type CompositionLayout = "claude" | "pi";

export type MicrocompactMode = "time" | "threshold";

export interface ContextEqualizerConfig {
	composition: {
		layout: CompositionLayout;
		gitSnapshot: boolean;
		memory: {
			enabled: boolean;
			maxTokens: number;
		};
		skills: {
			enabled: boolean;
			maxCatalogTokens: number;
		};
		tools: {
			active: string[] | null;
			hidden: string[];
		};
	};
	microcompact: {
		enabled: boolean;
		mode: MicrocompactMode;
		gapMinutes: number;
		minPercent: number;
		keepRecent: number;
		keepErrors: boolean;
		minTokens: number;
		maxChars: number;
		dedupe: boolean;
	};
	compaction: {
		customSummary: boolean;
		earlyTriggerPercent: number | null;
		summaryModel: string | null;
		maxSummaryTokens: number;
		maxFailures: number;
		overflowAggressive: boolean;
	};
	collapse: {
		enabled: boolean;
		triggerPercent: number;
		keepTurns: number;
		maxTokens: number;
	};
	restore: {
		enabled: boolean;
		maxFiles: number;
		maxTokens: number;
		maxTokensPerFile: number;
	};
}

export type CategoryName =
	| "System prompt"
	| "System tools"
	| "MCP tools"
	| "Memory files"
	| "Skills"
	| "Messages"
	| "Free space"
	| "Autocompact buffer";

export interface ContextCategory {
	name: CategoryName;
	tokens: number;
	color: ThemeColor;
}

export interface ContextGridSquare {
	category: CategoryName;
	color: ThemeColor;
	/** 0..1. Only tool/MCP categories use a partial square. */
	fullness: number;
}

export interface ContextFileMetric {
	path: string;
	tokens: number;
}

export interface ToolMetric {
	name: string;
	tokens: number;
	group: "builtin" | "extension" | "mcp";
}

export interface SkillMetric {
	name: string;
	tokens: number;
}

export interface ContextUsageData {
	timestamp: number;
	model: string;
	cwd: string;
	contextWindow: number;
	usedTokens: number;
	percent: number;
	reserveTokens: number;
	freeTokens: number;
	categories: ContextCategory[];
	gridRows: ContextGridSquare[][];
	systemPromptTokens: number;
	toolDeclarationTokens: number;
	mcpToolTokens: number;
	memoryFileTokens: number;
	skillTokens: number;
	messageTokens: number;
	userMessageTokens: number;
	assistantMessageTokens: number;
	toolResultTokens: number;
	memoryFiles: ContextFileMetric[];
	tools: ToolMetric[];
	skills: SkillMetric[];
	suggestions: string[];
	layout: CompositionLayout;
}

export interface InjectedContext {
	memoryText: string;
	skillsText: string;
	memoryFiles: ContextFileMetric[];
	skills: SkillMetric[];
}

export interface CompositionState {
	/** Built during before_agent_start for the current run. */
	injected: InjectedContext | null;
	/** Snapshot used by /context between runs. */
	lastInjected: InjectedContext | null;
}

export interface PruneResult {
	truncated: number;
	deduped: number;
	droppedThinking: number;
	savedTokens: number;
}

export interface MicrocompactResult {
	cleared: number;
	savedTokens: number;
}

export interface RuntimeState {
	config: ContextEqualizerConfig;
	composition: CompositionState;
	failures: number;
	compacting: boolean;
	lastPrune: PruneResult | null;
	lastMicrocompact: MicrocompactResult | null;
	sessionId: string | null;
}

export interface ContextMessageMarker {
	role: "custom";
	customType: string;
	content: Array<{ type: "text"; text: string }>;
	display: boolean;
	timestamp: number;
}

export type AnyAgentMessage = AgentMessage;

export const CONTEXT_META_CUSTOM_TYPE = "context-equalizer-meta";
export const CONTEXT_USAGE_ENTRY_TYPE = "context-usage";
export const CONTEXT_COLLAPSE_ENTRY_TYPE = "context-collapse";
