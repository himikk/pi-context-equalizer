/** Same chars-per-token heuristic pi's compaction estimator uses for prose. */
export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export interface TruncatedText {
	text: string;
	truncated: boolean;
}

export function truncateToTokenBudget(text: string, maxTokens: number): TruncatedText {
	const maxChars = maxTokens * 4;
	if (text.length <= maxChars) {
		return { text, truncated: false };
	}
	return {
		text: `${text.slice(0, maxChars)}\n[... ${text.length - maxChars} characters truncated]`,
		truncated: true,
	};
}

export function formatTokens(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}
