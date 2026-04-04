# TUI Subsystem

Ink 6 + React 19 + `fullscreen-ink`. Three-panel layout with setup flow.

## Key Files

- `app.tsx` — `App` (screen routing, config state, provider switching) + `MainScreen` (findings, triaging, keybindings)
- `components/setup-screen.tsx` — Step-by-step config: trust → provider → apikey → baseurl → model → effort → file. `startStep` prop for partial re-entry (provider switching). Auto-complete skipped when `startStepProp` is set.
- `components/agent-panel.tsx` — Agent output rendering. `L` component for block-level Text. `collapseEvents()` merges thinking deltas. Tool calls as bold(name) + cyan(detail). Tool results suppressed. `wrapText()`/`clip()` for width control.
- `components/findings-table.tsx` — Active findings with status badges, multi-select indicators
- `components/finding-detail.tsx` — Source code preview with context lines, highlighted flagged lines
- `components/sidebar.tsx` — Stats, provider info, queue progress, token usage (per-finding + session)
- `components/verdict-banner.tsx` — Verdict display

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
- **Filtered** (Tab 2): pre-filtered findings. Enter=promote+triage, d=dismiss
- **Dismissed** (Tab 3): manually dismissed. Enter=restore to filtered

## Rendering Rules

- All `<Text>` must be wrapped in `<Box>` for block-level layout (not React fragments)
- Tab characters expanded to 4 spaces before truncating (`clip()`)
- `overflow="hidden"` on all panel Box containers
- Thinking blocks: first line only (models may echo tool output in thinking)
- Tool results: suppressed entirely
- `useTerminalSize()` hook for reactive dimensions
