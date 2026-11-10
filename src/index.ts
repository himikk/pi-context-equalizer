import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompaction } from "./compaction.ts";
import { loadConfig } from "./config.ts";
import { registerComposition } from "./composition.ts";
import { collectContextData, formatContextLine } from "./context-data.ts";
import { registerContextView } from "./context-view.ts";
import type { RuntimeState } from "./types.ts";
import { CONTEXT_USAGE_ENTRY_TYPE } from "./types.ts";

export default function contextEqualizer(pi: ExtensionAPI): void {
	const initial = loadConfig(process.cwd());
	const state: RuntimeState = {
		config: initial.config,
		composition: { injected: null, lastInjected: null },
		failures: 0,
		compacting: false,
		lastPrune: null,
		lastMicrocompact: null,
		sessionId: null,
	};

	registerComposition(pi, state);
	registerCompaction(pi, state);
	registerContextView(pi);

	pi.registerCommand("context", {
		description: "Visualize current context usage",
		handler: async (_args, ctx) => {
			const data = collectContextData(pi, ctx, state);
			if (ctx.mode !== "tui") {
				ctx.ui.notify(formatContextLine(data), "info");
				return;
			}
			pi.appendEntry(CONTEXT_USAGE_ENTRY_TYPE, data);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const loaded = loadConfig(ctx.cwd);
		state.config = loaded.config;
		state.sessionId = ctx.sessionManager.getSessionId();
		for (const diagnostic of loaded.diagnostics) {
			ctx.ui.notify(diagnostic, "warning");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("context-equalizer", undefined);
	});
}
