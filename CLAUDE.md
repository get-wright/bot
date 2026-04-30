# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

SAST Triage — agentic CLI tool that triages Semgrep findings via LLM-driven codebase exploration. TypeScript, AI SDK v5, Bun-compiled binary.

The LLM drives its own investigation via read/grep/glob/bash tools and delivers a verdict.

## Commands

```bash
bun install                                # install deps
bunx vitest run                            # all tests (143, no network)
bunx tsc --noEmit                          # type check
bun build src/index.ts --compile --outfile sast-triage  # compile binary
./sast-triage findings.json --provider openai --model gpt-4o  # NDJSON
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
```

### Provider System

Multi-provider via AI SDK v5: `openai`, `anthropic`, `google`, `openrouter`, `fpt`. OpenRouter uses `createOpenAI` with `baseURL` (Chat Completions API, not Responses API). FPT AI Marketplace (`fpt`) uses the same `createOpenAI` pattern with `baseURL` `https://mkp-api.fptcloud.com/v1`. Each provider resolved via `resolveProvider(provider, model, apiKey?, baseUrl?)`.

Unified reasoning effort control via `resolveProviderOptions(provider, effort)` — maps `"low"|"medium"|"high"` to provider-specific `providerOptions`: OpenAI/OpenRouter `reasoningEffort`, Anthropic `thinking.budgetTokens`, Google `thinkingConfig.thinkingBudget`.

**Key files:**
- `src/index.ts` — entry shim into `src/cli/cli.ts`
- `src/cli/cli.ts` — commander setup, action handler, headless mode
- `src/cli/config.ts` — `resolveConfig` + `validateConfig`
- `src/cli/project-config.ts` — `.sast-triage.toml` reader/writer (`reasoningEffort`, `allowedPaths`, per-provider `savedApiKeys`)
- `src/core/agent/loop.ts` — `runAgentLoop()` returns `AgentLoopResult = { verdict, toolCalls, inputTokens, outputTokens }`. Uses `streamText` + `prepareStep` (force verdict), `generateObject` lenient-schema fallback for weak models, `accumulatedText` backfill for empty tool-call verdict fields, error extraction (rate limits, auth)
- `src/core/agent/follow-up.ts` — `runFollowUp()` for conversational follow-up on verdicts (no tools)
- `src/core/agent/tools/` — read, grep, glob, bash, verdict tools
- `src/core/agent/system-prompt.ts` — system prompt + finding message formatter
- `src/core/parser/semgrep.ts` — parse, fingerprint, classify
- `src/core/parser/prefilter.ts` — test/generated/INFO filters only
- `src/core/models/finding.ts` — Finding schema (Zod)
- `src/core/models/verdict.ts` — Verdict schema (Zod, tolerant `key_evidence`)
- `src/core/models/events.ts` — agent events including `permission_request`, `usage`, `followup_start`
- `src/core/triage/orchestrator.ts` — `TriageOrchestrator` runs the headless flow (parse + prefilter + agent loop + cache + emit NDJSON)
- `src/infra/providers/registry.ts` — multi-provider resolution with optional apiKey/baseUrl
- `src/infra/providers/reasoning.ts` — unified reasoning effort mapping across providers
- `src/infra/memory/store.ts` — SQLite via `bun:sqlite` (binary) / `better-sqlite3` (Node). `lookupCached()` returns full audit record. Idempotent schema migrations.
- `src/infra/output/writer.ts` — NDJSON writer + consolidated `findings-out.json`
- `src/infra/output/reporter.ts` — formats agent events for stderr stream
- `src/infra/tracing.ts` — LangSmith tracing init
- `src/infra/logger.ts` — file-based debug logger, writes to `.sast-triage/debug.log` by default

## Conventions

- Zod for validation schemas (Finding, Verdict, Events)
- Named imports, no barrel exports
- `vitest` for tests, `tmp_path` pattern via `import.meta.dirname`
- `smol-toml` for TOML config persistence

## Key Gotchas

- **AI SDK v5 uses `inputSchema`** not `parameters` in `tool()` calls
- **OpenRouter must use `.chat(model)`** not `provider(model)` — the default hits the Responses API (`/responses`) which OpenRouter doesn't support
- **`bun:sqlite` vs `better-sqlite3`** — runtime detection via `typeof globalThis.Bun`. Binary uses bun:sqlite, vitest uses better-sqlite3.
- **Tab characters in tool output** — `\t` counts as 1 char but renders as 8; expand tabs to 4 spaces before truncating
- **Verdict schema tolerance** — some models (Nemotron, GLM) send `key_evidence` as string or JSON-stringified array `'["a","b"]'`; Zod union handles all shapes
- **`prepareStep` for forced verdict is model-dependent** — strong models comply; weak models (gpt-oss-120b, nemotron, glm-4.7) ignore `toolChoice`. Two failure modes: (1) no tool call, stream ends → `generateObject` fallback recovers verdict from conversation history; (2) tool call with empty fields → `accumulatedText` backfill from text-delta stream.
- **Empty verdict fields are filled from `accumulatedText`** — weak models emit `{verdict:"X", reasoning:"", key_evidence:[]}` after writing the analysis as text. The streamed text is buffered and used to backfill empty fields at end-of-stream. Verdict emission is **delayed** until after stream ends for this reason.
- **Fallback schema must be lenient** — strict Zod constraints (`min(20)`, `min(1)`) cause `generateObject` to throw on weak models that emit only `{verdict:"..."}`, losing even the verdict. Use optional fields + `.describe()` + text-synthesis backfill.
- **Rate limit detection** — `extractErrorMessage()` in loop.ts walks cause chain, parses HTTP status (429/401/402/5xx) and OpenRouter `metadata.retry_after`
- **Read tool metadata footers** — every read ends with `[End of file — N lines total]` or `[Showing lines X-Y of N — use offset=Y+1 to continue]` so the agent knows where it is
- **Long-line truncation in read** — lines >2000 chars clipped with `… [line truncated, N chars total]` (minified JS, SVG data URIs, base64)
- **Per-provider key persistence** — `savedApiKeys` on ProjectConfig stores all provider keys; `detectedProviders()` checks env vars OR saved keys
- **Cached findings include tool calls + tokens + timestamp** — `lookupCached()` returns `{verdict, tool_calls, input_tokens, output_tokens, updated_at}`.
- **Read registry dedups by content hash + range coverage** — `runAgentLoop` allocates a per-call `ReadRegistry`; the read tool stubs subsequent reads of the same file when the requested `[offset, offset+limit]` range is already covered. Critical: the gate uses raw `input.offset` / `input.limit` (not destructure defaults), so a partial read does NOT block a later full-file read. See `src/core/agent/tools/read.ts`.
- **Read tool path-not-found suggestions** — when a path doesn't exist, the read tool calls `rg --files --glob '**/<basename>'` (5s timeout, ignores `node_modules`/`.git`/`dist`/`__pycache__`/`venv`/`build`) and appends up to 5 closest matches. If `rg` is missing or times out, degrades to plain "File not found".
- **Graph integration is gated** — `code-review-graph` MCP only attaches when `SAST_USE_GRAPH=1` env var is set AND the `code-review-graph` binary is on PATH. Otherwise `graphClient` is `null` and `query_graph` / `search_symbol` tools are NOT registered.
- **Graph build is idempotent** — first run takes ~10s for a 500-file repo; subsequent runs use incremental updates (<2s). 24h staleness threshold; check at `<repo>/.code-review-graph/graph.db`. See `isGraphStale` in `src/infra/graph/index.ts`.
- **Graph build failures don't block triage** — if `code-review-graph build` errors, `graphClient` is set to `null` and the agent runs without graph tools. Failure surfaces as a single stderr line `[graph] build failed: ...`.
- **Graph MCP envelope is `results`, not `nodes`** — upstream `code-review-graph` returns query results under `{results: [...]}`. The client also accepts `{nodes: [...]}` for forward-compat. `semantic_search_nodes_tool` parameter is `limit`, not `top_k`.
- **Graph subprocess is closed in `try/finally`** — `TriageOrchestrator.run` opens the MCP client once, runs the entire batch, and closes in `finally` so even errors reap the child process. Per-call clients are NOT supported.

## Where to Look

| Task | Location |
|------|----------|
| Add LLM provider | `src/infra/providers/registry.ts` → `SUPPORTED_PROVIDERS` + switch case |
| Add reasoning effort for new provider | `src/infra/providers/reasoning.ts` → `resolveProviderOptions` switch case |
| Change pre-filter rules | `src/core/parser/prefilter.ts` → `TEST_DIR_PATTERNS`, `GENERATED_PATH_PATTERNS` |
| Add agent tool | `src/core/agent/tools/` → new file + register in `src/core/agent/tools/index.ts` |
| Change system prompt | `src/core/agent/system-prompt.ts` |
| Change agent loop behavior | `src/core/agent/loop.ts` → `prepareStep`, `extractErrorMessage` |
| Change config persistence | `src/cli/project-config.ts` (TOML fields) |
| Change follow-up behavior | `src/core/agent/follow-up.ts` |
| Change debug logging | `src/infra/logger.ts` |
| Change error display | `src/core/agent/loop.ts` → `extractErrorMessage()` |
| Change NDJSON output | `src/infra/output/writer.ts` |
| Change orchestration / batching | `src/core/triage/orchestrator.ts` |
| Add graph-tool behavior | `src/core/agent/tools/query-graph.ts` |
| Change graph client / discovery | `src/infra/graph/index.ts`, `src/infra/graph/mcp-client.ts` |
| Toggle graph integration | env var `SAST_USE_GRAPH=1` (default off) |
| Tune read-dedup behavior | `src/core/agent/tools/read.ts` → `DEDUP_MIN_BYTES`, `mergeRanges` |
