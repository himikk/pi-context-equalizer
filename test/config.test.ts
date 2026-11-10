import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, mergeConfig } from "../src/config.ts";
import { estimateTextTokens, formatTokens, truncateToTokenBudget } from "../src/util.ts";

describe("estimateTextTokens", () => {
	it("uses ceil(length / 4)", () => {
		expect(estimateTextTokens("")).toBe(0);
		expect(estimateTextTokens("abcd")).toBe(1);
		expect(estimateTextTokens("abcde")).toBe(2);
	});
});

describe("truncateToTokenBudget", () => {
	it("keeps short text intact", () => {
		const result = truncateToTokenBudget("abc", 10);
		expect(result).toEqual({ text: "abc", truncated: false });
	});

	it("truncates long text with a marker", () => {
		const result = truncateToTokenBudget("x".repeat(100), 10);
		expect(result.truncated).toBe(true);
		expect(result.text.length).toBe(40 + "\n[... 60 characters truncated]".length);
	});
});

describe("formatTokens", () => {
	it("formats magnitudes", () => {
		expect(formatTokens(500)).toBe("500");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(12_340)).toBe("12k");
		expect(formatTokens(1_234_567)).toBe("1.2M");
	});
});

describe("mergeConfig", () => {
	it("deep-merges overrides over defaults", () => {
		const merged = mergeConfig(DEFAULT_CONFIG, {
			composition: { layout: "pi" },
			microcompact: { keepRecent: 3 },
		});
		expect(merged.composition.layout).toBe("pi");
		expect(merged.microcompact.keepRecent).toBe(3);
		expect(merged.microcompact.gapMinutes).toBe(60);
		expect(merged.composition.gitSnapshot).toBe(true);
	});

	it("ignores unknown keys", () => {
		const merged = mergeConfig(DEFAULT_CONFIG, { unknown: { nested: 1 } });
		expect(merged).toEqual(DEFAULT_CONFIG);
	});
});

describe("loadConfig", () => {
	it("returns defaults when no files exist", () => {
		const result = loadConfig("/nonexistent-cwd");
		expect(result.config).toEqual(DEFAULT_CONFIG);
		expect(result.diagnostics).toEqual([]);
	});
});
