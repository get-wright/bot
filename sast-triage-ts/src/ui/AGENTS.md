# TUI Subsystem

Ink 6 + React 19 + `fullscreen-ink`. Three-panel layout with setup flow.

## Key Files

- `app.tsx` — `App` (screen routing, config state, provider switching) + `MainScreen` (findings, triaging, keybindings, cached-verdict loading + event synthesis)
- `components/setup-screen.tsx` — Step-by-step config: trust → provider → apikey → baseurl → model → effort → file. `startStep` prop for partial re-entry (provider switching). Auto-complete skipped when `startStepProp` is set.
- `components/agent-panel.tsx` — Event-partitioned rendering: tool calls as compact log (`● read path`), verdict as bordered card (colored by verdict type, with Reasoning/Evidence/Fix sections). Thinking text fully suppressed. `wrapText()`/`clip()` for width control.
- `components/findings-table.tsx` — Active findings with status badges, multi-select indicators
- `components/finding-detail.tsx` — Source code preview with context lines, highlighted flagged lines
- `components/sidebar.tsx` — Stats, provider info, queue progress, token usage (per-finding + session)

## App State Machine

```
Setup Screen ──(onComplete)──→ Main Screen
     ↑                              │
     └──(Ctrl+P, startStep=provider)┘
```

Initial load: if saved config + findings.json → auto-complete setup (skip to main).
Provider switch: Ctrl+P → setup at "provider" step → returns to main with new config, findings preserved.

## MainScreen Views

- **Active** (Tab 1): findings table + agent panel. Enter=triage, Space=select, a=select all, r=re-audit, f=follow-up
- **Filtered** (Tab 2): pre-filtered findings. Enter=promote+triage, d=dismiss, Space/a supported
- **Dismissed** (Tab 3): manually dismissed. Enter=restore to filtered, Space/a supported

Multi-select (Space toggles, `a` selects all) works in all three views; Enter processes all selected items.

## Cached Verdict Loading

On startup, `MainScreen` looks up each finding via `memory.lookupCached(fp)` and synthesizes events from the stored record:

1. One `tool_start` event per stored tool call (read/grep/glob/bash)
2. One `verdict` event
3. One `usage` event with stored token counts

The `cachedAt` timestamp (from `updated_at`) is stored on `FindingState` and rendered at the right edge of the usage line. Cleared on re-audit (`reauditCurrent` + `triageIndex` reset) and repopulated to `new Date().toISOString()` after `memory.store()` completes.

## Rendering Rules

- All `<Text>` must be wrapped in `<Box>` for block-level layout (not React fragments)
- Tab characters expanded to 4 spaces before truncating (`clip()`)
- `overflow="hidden"` on all panel Box containers
- Thinking blocks: **fully suppressed** (models echo tool output/markdown in thinking text, it's noise)
- Tool results: suppressed entirely (agent sees them internally; user only needs verdict)
- `useTerminalSize()` hook for reactive dimensions

## Agent Panel Architecture

Events are **partitioned by type** before rendering (not streamed sequentially). For each finding:

- **Investigation log** (top): tool calls with `●` prefix, dimmed bullet, bold name, cyan detail. `verdict` tool call suppressed (redundant with card).
- **Verdict card** (middle): bordered box with `borderColor` matching verdict type (red=TP, green=FP, yellow=NR). Sections: label header → reasoning (wrapped) → Evidence (dimmed `·` bullets, wrapped) → Fix (wrapped).
- **Usage line** (below card, `justifyContent="space-between"`): token count on left, cached-at timestamp on right (`HH:MM - DD/MM/YYYY`).
- **Permission prompt** (conditional): yellow header, path, keyboard shortcuts.
- **Follow-up input** (conditional): cyan `>` prompt with TextInput.
