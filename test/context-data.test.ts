import { describe, expect, it } from "vitest";
import { buildGrid, formatContextLine } from "../src/context-data.ts";
import type { CategoryName, ContextCategory } from "../src/types.ts";

function categories(tokens: number[]): ContextCategory[] {
	const names: CategoryName[] = [
		"System prompt",
		"System tools",
		"MCP tools",
		"Memory files",
		"Skills",
		"Messages",
	];
	const colors = ["accent", "syntaxFunction", "syntaxType", "success", "syntaxKeyword", "warning"] as const;
	return tokens.map((value, index) => ({
		name: names[index]!,
		tokens: value,
		color: colors[index]!,
	}));
}

function flatten(rows: ReturnType<typeof buildGrid>) {
	return rows.flat();
}

describe("buildGrid", () => {
	it("returns an empty grid when the window is unknown", () => {
		expect(buildGrid(categories([100, 200]), 0, 16_384)).toEqual([]);
	});

	it("keeps 100 squares in 10 rows of 10", () => {
		const rows = buildGrid(categories([10_000, 20_000, 5_000, 1_000, 500, 30_000]), 200_000, 16_384);
		expect(rows).toHaveLength(10);
		expect(flatten(rows)).toHaveLength(100);
	});

	it("allocates the reserve at the end", () => {
		const rows = buildGrid(categories([10_000]), 200_000, 16_384);
		const squares = flatten(rows);
		const reserved = squares.filter((square) => square.category === "Autocompact buffer");
		expect(reserved).toHaveLength(Math.round((16_384 / 200_000) * 100));
		// The reserve is the tail of the grid.
		expect(squares.slice(-reserved.length).every((square) => square.category === "Autocompact buffer")).toBe(
			true,
		);
	});

	it("gives every non-empty category at least one square", () => {
		const rows = buildGrid(categories([1, 1, 1, 1, 1, 1]), 200_000, 0);
		const squares = flatten(rows);
		for (const name of ["System prompt", "System tools", "MCP tools", "Memory files", "Skills", "Messages"]) {
			expect(squares.some((square) => square.category === name)).toBe(true);
		}
	});

	it("fills the rest with free space", () => {
		const rows = buildGrid(categories([1_000]), 200_000, 0);
		const squares = flatten(rows);
		const used = squares.filter((square) => square.category === "System prompt").length;
		const free = squares.filter((square) => square.category === "Free space").length;
		expect(used + free).toBe(100);
		expect(free).toBe(99);
	});

	it("caps allocation when categories exceed the window", () => {
		const rows = buildGrid(categories([150_000, 100_000]), 200_000, 0);
		const squares = flatten(rows);
		const used = squares.filter((square) => square.category !== "Free space").length;
		expect(used).toBeLessThanOrEqual(100);
	});
});

describe("formatContextLine", () => {
	it("renders the one-line summary", () => {
		const data = {
			usedTokens: 84_000,
			contextWindow: 200_000,
			percent: 42,
		} as Parameters<typeof formatContextLine>[0];
		expect(formatContextLine(data)).toBe("Context: 84k/200k (42%)");
	});
});
