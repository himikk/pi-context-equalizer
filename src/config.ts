import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ContextEqualizerConfig } from "./types.ts";

export const DEFAULT_CONFIG: ContextEqualizerConfig = {
	composition: {
		layout: "claude",
		gitSnapshot: true,
		memory: { enabled: true, maxTokens: 12_000 },
		skills: { enabled: true, maxCatalogTokens: 2_000 },
		tools: { active: null, hidden: [] },
	},
	microcompact: {
		enabled: true,
		mode: "time",
		gapMinutes: 60,
		minPercent: 50,
		keepRecent: 5,
		keepErrors: true,
		minTokens: 100,
		maxChars: 2_000,
		dedupe: true,
	},
	compaction: {
		customSummary: true,
		earlyTriggerPercent: 80,
		summaryModel: null,
		maxSummaryTokens: 8_192,
		maxFailures: 3,
		overflowAggressive: true,
	},
	collapse: {
		enabled: false,
		triggerPercent: 60,
		keepTurns: 2,
		maxTokens: 1_500,
	},
	restore: {
		enabled: false,
		maxFiles: 5,
		maxTokens: 20_000,
		maxTokensPerFile: 4_000,
	},
};

export interface ConfigPaths {
	global: string;
	project: string;
}

export interface ConfigLoadResult {
	config: ContextEqualizerConfig;
	paths: ConfigPaths;
	diagnostics: string[];
}

export function configPaths(cwd: string): ConfigPaths {
	return {
		global: path.join(os.homedir(), CONFIG_DIR_NAME, "agent", "context-equalizer.json"),
		project: path.join(cwd, CONFIG_DIR_NAME, "context-equalizer.json"),
	};
}

export function loadConfig(cwd: string): ConfigLoadResult {
	const paths = configPaths(cwd);
	const diagnostics: string[] = [];
	let config = structuredClone(DEFAULT_CONFIG);

	for (const file of [paths.global, paths.project]) {
		const parsed = readJson(file, diagnostics);
		if (parsed !== undefined) {
			config = mergeConfig(config, parsed);
		}
	}

	config = sanitizeConfig(config);
	return { config, paths, diagnostics };
}

function readJson(file: string, diagnostics: string[]): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return undefined;
		}
		diagnostics.push(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge a user config over defaults. Unknown keys are ignored; arrays replace.
 */
export function mergeConfig(base: ContextEqualizerConfig, input: unknown): ContextEqualizerConfig {
	if (!isRecord(input)) return base;
	const output = structuredClone(base) as unknown as Record<string, unknown>;
	mergeInto(output, input);
	return output as unknown as ContextEqualizerConfig;
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(source)) {
		const current = target[key];
		// Unknown keys are ignored: only defaults define the accepted shape.
		if (current === undefined) continue;
		if (isRecord(value) && isRecord(current)) {
			mergeInto(current, value);
			continue;
		}
		if (value !== undefined) {
			target[key] = value;
		}
	}
}

function sanitizeConfig(config: ContextEqualizerConfig): ContextEqualizerConfig {
	const number = (value: number, fallback: number, min = 0): number =>
		Number.isFinite(value) ? Math.max(min, value) : fallback;
	const percent = (value: number, fallback: number): number => Math.min(100, number(value, fallback));

	config.microcompact.gapMinutes = number(config.microcompact.gapMinutes, 60);
	config.microcompact.minPercent = percent(config.microcompact.minPercent, 50);
	config.microcompact.keepRecent = Math.floor(number(config.microcompact.keepRecent, 5));
	config.microcompact.minTokens = Math.floor(number(config.microcompact.minTokens, 100));
	config.microcompact.maxChars = Math.floor(number(config.microcompact.maxChars, 2_000));

	config.compaction.earlyTriggerPercent =
		config.compaction.earlyTriggerPercent === null
			? null
			: percent(config.compaction.earlyTriggerPercent, 80);
	config.compaction.maxSummaryTokens = Math.floor(number(config.compaction.maxSummaryTokens, 8_192));
	config.compaction.maxFailures = Math.floor(number(config.compaction.maxFailures, 3));

	config.collapse.triggerPercent = percent(config.collapse.triggerPercent, 60);
	config.collapse.keepTurns = Math.floor(number(config.collapse.keepTurns, 2));
	config.collapse.maxTokens = Math.floor(number(config.collapse.maxTokens, 1_500));

	config.restore.maxFiles = Math.floor(number(config.restore.maxFiles, 5));
	config.restore.maxTokens = Math.floor(number(config.restore.maxTokens, 20_000));
	config.restore.maxTokensPerFile = Math.floor(number(config.restore.maxTokensPerFile, 4_000));

	config.composition.memory.maxTokens = Math.floor(number(config.composition.memory.maxTokens, 12_000));
	config.composition.skills.maxCatalogTokens = Math.floor(
		number(config.composition.skills.maxCatalogTokens, 2_000),
	);

	return config;
}
