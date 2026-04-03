# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

SAST Triage — agentic CLI tool that triages Semgrep findings via LLM-driven codebase exploration. TypeScript, AI SDK v5, Ink 6 TUI, Bun-compiled binary.

The LLM drives its own investigation via read/grep/glob/bash tools and delivers a verdict.

## Commands

```bash
cd sast-triage-ts
npm install                                # install deps
npx vitest run                             # all tests (87, ~0.5s, no network)
npx tsc --noEmit                           # type check
bun build src/index.ts --compile --outfile sast-triage  # compile binary
./sast-triage                              # interactive TUI
./sast-triage findings.json --provider openai --model gpt-4o --headless  # NDJSON
```

## Architecture

```
Semgrep JSON → Parser → Pre-filter → Agent Loop (LLM + tools) → Verdict → Memory
                │            │              │                       │
          Finding model  filter out:    streamText + tools       TriageVerdict
                         test files,    read/grep/glob/bash      → SQLite cache
                         generated,     doom loop detection
                         cached,        stopWhen(stepCount)
                         INFO sev
```

### Provider System

Multi-provider via AI SDK v5: `openai`, `anthropic`, `google`, `openrouter`. OpenRouter uses `createOpenAI` with `baseURL` (Chat Completions API, not Responses API). Each provider resolved via `resolveProvider(provider, model, apiKey?, baseUrl?)`.

### TUI

Built with Ink 6 + React 19 + `fullscreen-ink`. Three-panel layout: findings table | agent panel | sidebar.

**Setup flow:** TrustScreen → Provider → API Key → Base URL → Model → File → Main Screen. Config persisted to `.sast-triage.toml` per repo. On relaunch with saved config + `findings.json` present, skips setup entirely.

**Key files:**
- `src/index.ts` — CLI entry (commander), headless + TUI modes
- `src/agent/loop.ts` — `runAgentLoop()` with `streamText`, tool dispatch, doom loop detection
- `src/agent/tools/` — read, grep, glob, bash, verdict tools
- `src/agent/system-prompt.ts` — system prompt + finding message formatter
- `src/provider/registry.ts` — multi-provider resolution with optional apiKey/baseUrl
- `src/config/project-config.ts` — `.sast-triage.toml` read/write
- `src/memory/store.ts` — SQLite via `bun:sqlite` (binary) / `better-sqlite3` (Node)
- `src/parser/semgrep.ts` — parse, fingerprint, classify
- `src/parser/prefilter.ts` — test/generated/cached/INFO filters
- `src/ui/app.tsx` — Ink app, main screen, setup → main flow
- `src/ui/components/` — SetupScreen, FindingsTable, AgentPanel, Sidebar, VerdictBanner

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
- **Thinking tokens arrive word-by-word** — must collapse consecutive thinking events into paragraphs before rendering
- **`overflow="hidden"`** required on all Ink Box panels to prevent content overflow

## Where to Look

| Task | Location |
|------|----------|
| Add LLM provider | `src/provider/registry.ts` → `SUPPORTED_PROVIDERS` + switch case |
| Change pre-filter rules | `src/parser/prefilter.ts` → `TEST_DIR_PATTERNS`, `GENERATED_PATH_PATTERNS` |
| Add agent tool | `src/agent/tools/` → new file + register in `src/agent/tools/index.ts` |
| Change system prompt | `src/agent/system-prompt.ts` |
| Change TUI layout | `src/ui/app.tsx` (main screen), `src/ui/components/` |
| Change setup flow | `src/ui/components/setup-screen.tsx` |
| Change config persistence | `src/config/project-config.ts` |
