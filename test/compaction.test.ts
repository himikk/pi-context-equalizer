import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { applyContextTransform, SUMMARIZE_PROMPT } from "../src/compaction.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { RuntimeState } from "../src/types.ts";

const OLD = Date.now() - 61 * 60_000;
const NOW = Date.now();

function user(timestamp: number): UserMessage {
	return { role: "user", content: "do the thing", timestamp };
}

function toolResult(text: string, timestamp: number, isError = false, id = "call-1"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError,
		timestamp,
	};
}

function state(): RuntimeState {
	return {
		config: structuredClone(DEFAULT_CONFIG),
		composition: { injected: null, lastInjected: null },
		failures: 0,
		compacting: false,
		lastPrune: null,
		lastMicrocompact: null,
		sessionId: null,
	};
}

function ctx(percent: number | null): ExtensionContext {
	return {
		getContextUsage: () =>
			percent === null ? undefined : { tokens: null, contextWindow: 200_000, percent },
		ui: { setStatus: () => {} },
	} as unknown as ExtensionContext;
}

function asMessages(items: Array<UserMessage | ToolResultMessage>): AgentMessage[] {
	return items;
}

describe("applyContextTransform", () => {
	it("returns undefined when microcompact is disabled", () => {
		const s = state();
		s.config.microcompact.enabled = false;
		const messages = asMessages([user(OLD), toolResult("x".repeat(5000), OLD), user(NOW)]);
		expect(applyContextTransform(messages, s, ctx(null))).toBeUndefined();
	});

	it("returns undefined when nothing needs pruning", () => {
		const messages = asMessages([user(OLD), toolResult("short", OLD), user(NOW)]);
		expect(applyContextTransform(messages, state(), ctx(null))).toBeUndefined();
	});

	it("truncates long old tool results", () => {
		const messages = asMessages([user(OLD), toolResult("x".repeat(5000), OLD), user(NOW)]);
		const result = applyContextTransform(messages, state(), ctx(null));
		expect(result).toBeDefined();
		const first = result![1] as ToolResultMessage;
		expect(first.content[0]).toMatchObject({ type: "text" });
		const text = (first.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("[... 3000 characters truncated]");
		expect(text.length).toBeLessThan(5000);
		expect(first.toolCallId).toBe("call-1");
	});

	it("dedupes identical old results after truncation", () => {
		const messages = asMessages([
			user(OLD),
			toolResult("y".repeat(5000), OLD, false, "call-1"),
			toolResult("y".repeat(5000), OLD, false, "call-2"),
			user(NOW),
		]);
		const result = applyContextTransform(messages, state(), ctx(null))!;
		const second = result[2] as ToolResultMessage;
		expect(second.toolCallId).toBe("call-2");
		expect((second.content[0] as { text: string }).text).toContain("[Duplicate of earlier bash result]");
	});

	it("clears old results beyond keepRecent when the gap is long", () => {
		const s = state();
		s.config.microcompact.keepRecent = 2;
		const messages = asMessages([
			user(OLD),
			toolResult("old one", OLD, false, "call-1"),
			toolResult("old two", OLD, false, "call-2"),
			toolResult("old three", OLD, false, "call-3"),
			user(OLD),
		]);
		const result = applyContextTransform(messages, s, ctx(null))!;
		expect((result[1] as ToolResultMessage).content[0]).toMatchObject({
			text: "[Old tool result content cleared]",
		});
		// Newest keepRecent results stay untouched.
		expect((result[2] as ToolResultMessage).content[0]).toMatchObject({ text: "old two" });
		expect((result[3] as ToolResultMessage).content[0]).toMatchObject({ text: "old three" });
	});

	it("keeps error results when keepErrors is set", () => {
		const s = state();
		s.config.microcompact.keepRecent = 0;
		const messages = asMessages([
			user(OLD),
			toolResult("boom", OLD, true, "call-1"),
			toolResult("ok", OLD, false, "call-2"),
			user(OLD),
		]);
		const result = applyContextTransform(messages, s, ctx(null))!;
		expect((result[1] as ToolResultMessage).content[0]).toMatchObject({ text: "boom" });
		expect((result[2] as ToolResultMessage).content[0]).toMatchObject({
			text: "[Old tool result content cleared]",
		});
	});

	it("does not clear when the gap is short", () => {
		const s = state();
		s.config.microcompact.keepRecent = 0;
		const messages = asMessages([user(OLD), toolResult("recent run", OLD, false, "call-1"), user(NOW)]);
		expect(applyContextTransform(messages, s, ctx(null))).toBeUndefined();
	});

	it("uses the threshold mode from context usage", () => {
		const s = state();
		s.config.microcompact.mode = "threshold";
		s.config.microcompact.minPercent = 50;
		s.config.microcompact.keepRecent = 0;
		const messages = asMessages([user(OLD), toolResult("big", OLD, false, "call-1"), user(OLD)]);
		expect(applyContextTransform(messages, s, ctx(40))).toBeUndefined();
		const cleared = applyContextTransform(messages, s, ctx(60))!;
		expect((cleared[1] as ToolResultMessage).content[0]).toMatchObject({
			text: "[Old tool result content cleared]",
		});
	});
});

describe("SUMMARIZE_PROMPT", () => {
	it("requires the nine Claude sections", () => {
		const sections = [
			"Primary Request and Intent",
			"Key Technical Concepts",
			"Files and Code Sections",
			"Errors and fixes",
			"Problem Solving",
			"All user messages",
			"Pending Tasks",
			"Current Work",
			"Optional Next Step",
		];
		for (const section of sections) {
			expect(SUMMARIZE_PROMPT).toContain(section);
		}
	});
});
