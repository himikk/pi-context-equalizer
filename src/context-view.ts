import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { formatContextPercent } from "./context-data.ts";
import { formatTokens } from "./util.ts";
import {
	CONTEXT_USAGE_ENTRY_TYPE,
	type CategoryName,
	type ContextGridSquare,
	type ContextUsageData,
} from "./types.ts";

const GRID_WIDTH = 10;
/** Two visible characters per square: the glyph plus one space. */
const GRID_VISIBLE_WIDTH = GRID_WIDTH * 2;
/** Visible columns the grid occupies in side-by-side layout, legend starts after it. */
const SIDE_BY_SIDE_GRID_COLUMNS = 22;
const SIDE_BY_SIDE_MIN_WIDTH = 80;
const PARTIAL_FULLNESS_THRESHOLD = 0.7;

const FULL_SQUARE = "\u26C1";
const PARTIAL_SQUARE = "\u26C0";
const FREE_SQUARE = "\u26F6";
const RESERVED_SQUARE = "\u26DD";

/** Renders the persisted /context snapshot as an interactive transcript entry. */
export class ContextUsageView implements Component {
	private readonly data: ContextUsageData;
	private readonly theme: Theme;

	constructor(data: ContextUsageData, theme: Theme) {
		this.data = data;
		this.theme = theme;
	}

	render(width: number): string[] {
		const lines: string[] = [this.theme.bold("Context Usage")];
		const gridLines = this.renderGrid();
		const legendLines = this.renderLegend();
		if (width >= SIDE_BY_SIDE_MIN_WIDTH) {
			const gap = " ".repeat(SIDE_BY_SIDE_GRID_COLUMNS - GRID_VISIBLE_WIDTH);
			const rowCount = Math.max(gridLines.length, legendLines.length);
			for (let i = 0; i < rowCount; i++) {
				const grid = gridLines[i] ?? "";
				const legend = legendLines[i] ?? "";
				lines.push(grid + (grid === "" ? "" : gap) + legend);
			}
		} else {
			lines.push(...gridLines, ...legendLines);
		}
		for (const suggestion of this.data.suggestions) {
			lines.push(this.theme.fg("dim", this.theme.italic(`hint: ${suggestion}`)));
		}
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}

	private renderGrid(): string[] {
		return this.data.gridRows.map((row) => row.map((square) => this.renderSquare(square)).join(""));
	}

	private renderSquare(square: ContextGridSquare): string {
		const glyph = squareGlyph(square);
		if (square.category === "Free space") {
			return this.theme.fg("dim", glyph + " ");
		}
		return this.theme.fg(square.color, glyph + " ");
	}

	private renderLegend(): string[] {
		const lines: string[] = [];
		for (const category of this.data.categories) {
			if (category.tokens <= 0) continue;
			const glyph = this.categoryGlyph(category.name);
			lines.push(
				`${this.theme.fg(category.color, glyph)} ${category.name}: ${formatTokens(category.tokens)} (${formatContextPercent(category.tokens, this.data.contextWindow)})`,
			);
		}
		lines.push(
			`${this.theme.fg("dim", FREE_SQUARE)} Free space: ${formatTokens(this.data.freeTokens)} (${formatContextPercent(this.data.freeTokens, this.data.contextWindow)})`,
		);
		lines.push(
			`${this.theme.fg("dim", RESERVED_SQUARE)} Autocompact buffer: ${formatTokens(this.data.reserveTokens)} (${formatContextPercent(this.data.reserveTokens, this.data.contextWindow)})`,
		);
		return lines;
	}

	/** The grid glyph for a category, taken from its first grid square. */
	private categoryGlyph(name: CategoryName): string {
		for (const row of this.data.gridRows) {
			for (const square of row) {
				if (square.category === name) {
					return square.fullness < PARTIAL_FULLNESS_THRESHOLD ? PARTIAL_SQUARE : FULL_SQUARE;
				}
			}
		}
		return FULL_SQUARE;
	}
}

function squareGlyph(square: ContextGridSquare): string {
	if (square.category === "Free space") return FREE_SQUARE;
	if (square.category === "Autocompact buffer") return RESERVED_SQUARE;
	return square.fullness < PARTIAL_FULLNESS_THRESHOLD ? PARTIAL_SQUARE : FULL_SQUARE;
}

/** Registers the renderer for persisted context-usage entries. */
export function registerContextView(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<ContextUsageData>(CONTEXT_USAGE_ENTRY_TYPE, (entry, _options, theme) =>
		new ContextUsageView(entry.data as ContextUsageData, theme),
	);
}
