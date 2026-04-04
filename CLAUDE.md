# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

SAST Triage — agentic CLI tool that triages Semgrep findings via LLM-driven codebase exploration. TypeScript, AI SDK v5, Ink 6 TUI, Bun-compiled binary.

The LLM drives its own investigation via read/grep/glob/bash tools and delivers a verdict.

## Commands

```bash
cd sast-triage-ts
npm install                                # install deps
npx vitest run                             # all tests (107, ~0.7s, no network)
npx tsc --noEmit                           # type check
bun build src/index.ts --compile --outfile sast-triage  # compile binary
./sast-triage                              # interactive TUI
./sast-triage findings.json --provider openai --model gpt-4o --headless  # NDJSON
./sast-triage --effort high -v             # reasoning effort + debug logging
```

## Architecture

```
Semgrep JSON → Parser → Pre-filter → Agent Loop (LLM + tools) → Verdict → Memory
                │            │              │                       │
          Finding model  filter out:    streamText + tools       TriageVerdict
                         test files,    read/grep/glob/bash      → SQLite cache
                         generated,     doom loop detection
                         cached,        prepareStep (force verdict)
                         INFO sev       providerOptions (reasoning)
                                        permission callbacks
```

### Provider System

Multi-provider via AI SDK v5: `openai`, `anthropic`, `google`, `openrouter`. OpenRouter uses `createOpenAI` with `baseURL` (Chat Completions API, not Responses API). Each provider resolved via `resolveProvider(provider, model, apiKey?, baseUrl?)`.

Unified reasoning effort control via `resolveProviderOptions(provider, effort)` — maps `"low"|"medium"|"high"` to provider-specific `providerOptions`: OpenAI/OpenRouter `reasoningEffort`, Anthropic `thinking.budgetTokens`, Google `thinkingConfig.thinkingBudget`.

### TUI

Built with Ink 6 + React 19 + `fullscreen-ink`. Three-panel layout: findings table | agent panel | sidebar.

**Setup flow:** TrustScreen → Provider → API Key → Base URL → Model → Effort → File → Main Screen. Config persisted to `.sast-triage.toml` per repo. On relaunch with saved config + `findings.json` present, skips setup entirely.

**Views:** Tab cycles active → filtered → dismissed. Active findings can be triaged (Enter), re-audited (r), or followed up (f). Filtered findings can be promoted to active (Enter) or dismissed (d). Dismissed findings can be restored (Enter).

**Mid-session features:** Ctrl+P switches provider (re-enters setup at provider step). Batch audit via multi-select (Space/a) then Enter. Follow-up asks conversational questions about a verdict.

**Key files:**
- `src/index.ts` — CLI entry (commander), headless + TUI modes, `--effort`, `-v` flags
- `src/agent/loop.ts` — `runAgentLoop()` with `streamText`, `prepareStep` (force verdict), permission callbacks, error extraction (rate limits, auth)
- `src/agent/follow-up.ts` — `runFollowUp()` for conversational follow-up on verdicts (no tools)
- `src/agent/tools/` — read (with permission callbacks), grep, glob, bash, verdict tools
- `src/agent/system-prompt.ts` — system prompt + finding message formatter
- `src/provider/registry.ts` — multi-provider resolution with optional apiKey/baseUrl
- `src/provider/reasoning.ts` — unified reasoning effort mapping across providers
- `src/config/project-config.ts` — `.sast-triage.toml` read/write (`reasoningEffort`, `allowedPaths`)
- `src/logger.ts` — file-based debug logger (`-v` flag writes to `.sast-triage/debug.log`)
- `src/memory/store.ts` — SQLite via `bun:sqlite` (binary) / `better-sqlite3` (Node)
- `src/models/events.ts` — agent events including `permission_request`, `usage`, `followup_start`
- `src/models/verdict.ts` — tolerant schema (`key_evidence` accepts string or string[])
- `src/parser/semgrep.ts` — parse, fingerprint, classify
- `src/parser/prefilter.ts` — test/generated/cached/INFO filters
- `src/ui/app.tsx` — Ink app, three views (active/filtered/dismissed), batch queue, provider switching, follow-up
- `src/ui/components/` — SetupScreen, FindingsTable, AgentPanel, Sidebar, FindingDetail, VerdictBanner

## Conventions

- Zod for validation schemas (Finding, Verdict, Events)
- Named imports, no barrel exports
- `vitest` for tests, `tmp_path` pattern via `import.meta.dirname`
- `smol-toml` for TOML config persistence
- Agent panel lines manually truncated to panel width (Ink `wrap="truncate"` unreliable in nested layouts)

## Key Gotchas

- **AI SDK v5 uses `inputSchema`** not `parameters` in `tool()` calls
- **OpenRouter must use `.chat(model)`** not `provider(model)` — the default hits the Responses API (`/responses`) which OpenRouter doesn't support
- **`bun:sqlite` vs `better-sqlite3`** — runtime detection via `typeof globalThis.Bun`. Binary uses bun:sqlite, vitest uses better-sqlite3.
- **`react-devtools-core` stub needed** for bun binary builds — Ink imports it optionally
- **Thinking tokens arrive word-by-word** — must collapse consecutive thinking events into paragraphs, show first line only (some models echo tool results in thinking)
- **`overflow="hidden"`** required on all Ink Box panels to prevent content overflow
- **Ink `<Text>` in fragments renders inline** — always wrap in `<Box>` for block-level layout (the `L` component in agent-panel)
- **Tab characters in tool output** — `\t` counts as 1 char but renders as 8; expand tabs to 4 spaces before truncating
- **Verdict schema tolerance** — some models (Nemotron, GLM) send `key_evidence` as string instead of array; Zod union handles both
- **`prepareStep` for forced verdict** — warns agent on step N-2, forces verdict-only on step N-1; guard with `if (finalVerdict) return` to avoid redundant calls
- **Rate limit detection** — `extractErrorMessage()` in loop.ts walks cause chain, parses HTTP status (429/401/402/5xx) and OpenRouter `metadata.retry_after`
- **SetupScreen auto-complete** — `useEffect` skips auto-complete when `startStepProp` is set (provider switching)

## Where to Look

| Task | Location |
|------|----------|
| Add LLM provider | `src/provider/registry.ts` → `SUPPORTED_PROVIDERS` + switch case |
| Add reasoning effort for new provider | `src/provider/reasoning.ts` → `resolveProviderOptions` switch case |
| Change pre-filter rules | `src/parser/prefilter.ts` → `TEST_DIR_PATTERNS`, `GENERATED_PATH_PATTERNS` |
| Add agent tool | `src/agent/tools/` → new file + register in `src/agent/tools/index.ts` |
| Change system prompt | `src/agent/system-prompt.ts` |
| Change agent loop behavior | `src/agent/loop.ts` → `prepareStep`, `extractErrorMessage`, permission flow |
| Change TUI layout | `src/ui/app.tsx` (main screen), `src/ui/components/` |
| Change setup flow | `src/ui/components/setup-screen.tsx` (steps, auto-complete, `startStep`) |
| Change config persistence | `src/config/project-config.ts` (TOML fields) |
| Change follow-up behavior | `src/agent/follow-up.ts` |
| Change debug logging | `src/logger.ts` |
| Change error display | `src/agent/loop.ts` → `extractErrorMessage()` |
