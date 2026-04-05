# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

SAST Triage — agentic CLI tool that triages Semgrep findings via LLM-driven codebase exploration. TypeScript, AI SDK v5, Ink 6 TUI, Bun-compiled binary.

The LLM drives its own investigation via read/grep/glob/bash tools and delivers a verdict.

## Commands

```bash
cd sast-triage-ts
npm install                                # install deps
npx vitest run                             # all tests (112, ~0.7s, no network)
npx tsc --noEmit                           # type check
bun build src/index.ts --compile --outfile sast-triage  # compile binary
./sast-triage                              # interactive TUI (debug log on by default)
./sast-triage findings.json --provider openai --model gpt-4o --headless  # NDJSON
./sast-triage --effort high                # reasoning effort
./sast-triage --no-log                     # disable debug logging
```

## Architecture

```
Semgrep JSON → Parser → Pre-filter → Agent Loop (LLM + tools) → Verdict → Memory
                │            │              │                       │
          Finding model  filter out:    streamText + tools    TriageVerdict +
                         test files,    read/grep/glob/bash   tool_calls + tokens
                         generated,     doom loop detection   → SQLite cache
                         INFO sev       prepareStep (force verdict)
                                        generateObject fallback (lenient schema)
                                        accumulatedText backfill
                                        providerOptions (reasoning)
                                        permission callbacks

  Cached findings → reload on startup → synthesize events → full activity log
```

### Provider System

Multi-provider via AI SDK v5: `openai`, `anthropic`, `google`, `openrouter`. OpenRouter uses `createOpenAI` with `baseURL` (Chat Completions API, not Responses API). Each provider resolved via `resolveProvider(provider, model, apiKey?, baseUrl?)`.

Unified reasoning effort control via `resolveProviderOptions(provider, effort)` — maps `"low"|"medium"|"high"` to provider-specific `providerOptions`: OpenAI/OpenRouter `reasoningEffort`, Anthropic `thinking.budgetTokens`, Google `thinkingConfig.thinkingBudget`.

### TUI

Built with Ink 6 + React 19 + `fullscreen-ink`. Three-panel layout: findings table | agent panel | sidebar.

**Setup flow:** TrustScreen → Provider → API Key → Base URL → Model → Effort → File → Main Screen. Config persisted to `.sast-triage.toml` per repo. On relaunch with saved config + `findings.json` present, skips setup entirely.

**Views:** Tab cycles active → filtered → dismissed. Active findings can be triaged (Enter), re-audited (r), or followed up (f). Filtered findings can be promoted to active (Enter) or dismissed (d). Dismissed findings can be restored (Enter). Multi-select (Space/a) works in ALL views for batch operations.

**Cached findings:** Previously audited findings from prior sessions reload into the Active view on startup with their full verdict, tool-call history, token usage, and timestamp. The prefilter only rejects test/generated/INFO — it never filters cached verdicts. Press `r` to re-audit.

**Mid-session features:** Ctrl+P switches provider (re-enters setup at provider step). Batch audit via multi-select (Space/a) then Enter. Follow-up asks conversational questions about a verdict.

**Key files:**
- `src/index.ts` — CLI entry (commander), headless + TUI modes, `--effort`, `--no-log` flags (logging on by default)
- `src/agent/loop.ts` — `runAgentLoop()` returns `AgentLoopResult = { verdict, toolCalls, inputTokens, outputTokens }`. Uses `streamText` + `prepareStep` (force verdict), `generateObject` lenient-schema fallback for weak models, `accumulatedText` backfill for empty tool-call verdict fields, permission callbacks, error extraction (rate limits, auth)
- `src/agent/follow-up.ts` — `runFollowUp()` for conversational follow-up on verdicts (no tools)
- `src/agent/tools/` — read (with permission callbacks), grep, glob, bash, verdict tools
- `src/agent/system-prompt.ts` — system prompt + finding message formatter
- `src/provider/registry.ts` — multi-provider resolution with optional apiKey/baseUrl
- `src/provider/reasoning.ts` — unified reasoning effort mapping across providers
- `src/config/project-config.ts` — `.sast-triage.toml` read/write (`reasoningEffort`, `allowedPaths`, per-provider `savedApiKeys`)
- `src/logger.ts` — file-based debug logger, writes to `.sast-triage/debug.log` by default
- `src/memory/store.ts` — SQLite via `bun:sqlite` (binary) / `better-sqlite3` (Node). `lookupCached()` returns full audit record (verdict + tool_calls + tokens + updated_at). Idempotent schema migrations.
- `src/models/events.ts` — agent events including `permission_request`, `usage`, `followup_start`
- `src/models/verdict.ts` — tolerant schema (`key_evidence` accepts string, string[], or JSON-stringified array)
- `src/parser/semgrep.ts` — parse, fingerprint, classify
- `src/parser/prefilter.ts` — test/generated/INFO filters only (no memory dependency; cached verdicts are completed work, not noise)
- `src/ui/app.tsx` — Ink app, three views (active/filtered/dismissed), batch queue, provider switching, follow-up. Synthesizes tool_start + verdict + usage events from cached records on startup so AgentPanel renders the full history.
- `src/ui/components/` — SetupScreen, FindingsTable, AgentPanel (event-partitioned: log + verdict card), Sidebar, FindingDetail, VerdictBanner

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
- **Thinking text fully suppressed in agent panel** — models echo tool output/markdown in thinking, it's noise; investigation log shows only tool calls
- **`overflow="hidden"`** required on all Ink Box panels to prevent content overflow
- **Ink `<Text>` in fragments renders inline** — always wrap in `<Box>` for block-level layout
- **Agent panel architecture** — events partitioned by type (tool calls, verdict, usage, error) and rendered in fixed layout, not streamed sequentially
- **Tab characters in tool output** — `\t` counts as 1 char but renders as 8; expand tabs to 4 spaces before truncating
- **Verdict schema tolerance** — some models (Nemotron, GLM) send `key_evidence` as string or JSON-stringified array `'["a","b"]'`; Zod union handles all shapes
- **`prepareStep` for forced verdict is model-dependent** — strong models comply; weak models (gpt-oss-120b, nemotron, glm-4.7) ignore `toolChoice`. Two failure modes: (1) no tool call, stream ends → `generateObject` fallback recovers verdict from conversation history; (2) tool call with empty fields → `accumulatedText` backfill from text-delta stream.
- **Empty verdict fields are filled from `accumulatedText`** — weak models emit `{verdict:"X", reasoning:"", key_evidence:[]}` after writing the analysis as text. The streamed text is buffered and used to backfill empty fields at end-of-stream. Verdict emission is **delayed** until after stream ends for this reason.
- **Fallback schema must be lenient** — strict Zod constraints (`min(20)`, `min(1)`) cause `generateObject` to throw on weak models that emit only `{verdict:"..."}`, losing even the verdict. Use optional fields + `.describe()` + text-synthesis backfill.
- **Rate limit detection** — `extractErrorMessage()` in loop.ts walks cause chain, parses HTTP status (429/401/402/5xx) and OpenRouter `metadata.retry_after`
- **SetupScreen auto-complete** — `useEffect` skips auto-complete when `startStepProp` is set (provider switching)
- **Read tool metadata footers** — every read ends with `[End of file — N lines total]` or `[Showing lines X-Y of N — use offset=Y+1 to continue]` so the agent knows where it is
- **Long-line truncation in read** — lines >2000 chars clipped with `… [line truncated, N chars total]` (minified JS, SVG data URIs, base64)
- **Per-provider key persistence** — `savedApiKeys` on ProjectConfig stores all provider keys; `detectedProviders()` checks env vars OR saved keys
- **Cached findings include tool calls + tokens + timestamp** — `lookupCached()` returns `{verdict, tool_calls, input_tokens, output_tokens, updated_at}`. App synthesizes `tool_start` + `verdict` + `usage` events on startup so AgentPanel renders the full history for past audits.
- **`cachedAt` must be cleared on re-audit AND set after fresh audit** — cleared in `reauditCurrent` + `triageIndex` to avoid showing stale timestamp during "Investigating..."; then set to `new Date().toISOString()` after `memory.store()` completes.

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
