# Context Equalizer

Context composition, budgets and compaction for [pi](https://github.com/earendil-works/pi).

`/context` shows what the model actually sees: system prompt, tool declarations,
MCP tools, memory files, skills, messages, free space and the autocompact
reserve. Compaction follows a Claude-like ladder: prune, microcompact, optional
collapse, threshold summary, overflow recovery and post-compact restore.

## Install

```bash
pi install npm:pi-context-equalizer
```

Or load a checkout directly:

```bash
pi -e /path/to/pi-context-equalizer/src/index.ts
```

## Commands

| Command | Description |
|---|---|
| `/context` | Read-only context composition and usage view |

## How it works

**Composition** (`composition.layout`):

- `"claude"` (default) — memory files and the skill catalog are moved out of the
  system prompt into a `<system-reminder>` user meta-message before each run;
  a git snapshot section is appended when `gitSnapshot` is enabled.
- `"pi"` — layers stay where pi puts them.

**Compaction ladder** (runs in this order):

| Step | What it does | Config |
|---|---|---|
| L0 prune | Truncates old tool results, dedupes identical ones | `microcompact.maxChars`, `microcompact.dedupe` |
| L1 microcompact | Clears old tool results beyond the last N | `microcompact.mode` (`time`/`threshold`), `keepRecent` |
| L4 summary | Claude-style 9-section summary on `/compact` or the threshold trigger | `compaction.customSummary` |
| L5 overflow | Aggressive cut and summary retry on overflow | `compaction.overflowAggressive` |
| L7 guard | Early trigger, failure breaker (3), status line | `compaction.earlyTriggerPercent`, `maxFailures` |
| L6 restore | Re-injects recently touched files after compaction | `restore.enabled` |
| L2 collapse | Reserved, not implemented yet | `collapse.enabled` (no-op in 0.1) |


## Configuration

Global: `~/.pi/agent/context-equalizer.json`
Project override: `.pi/context-equalizer.json`

```json
{
  "composition": {
    "layout": "claude",
    "gitSnapshot": true,
    "memory": { "enabled": true, "maxTokens": 12000 },
    "skills": { "enabled": true, "maxCatalogTokens": 2000 },
    "tools": { "active": null, "hidden": [] }
  },
  "microcompact": {
    "enabled": true,
    "mode": "time",
    "gapMinutes": 60,
    "keepRecent": 5
  },
  "compaction": {
    "customSummary": true,
    "earlyTriggerPercent": 80,
    "maxFailures": 3
  },
  "restore": {
    "enabled": false
  }
}
```

## Development

```bash
npm install
npm run check
npm test
```
