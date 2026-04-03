# SAST Triage — TypeScript Agentic Rewrite

**Date:** 2026-04-03
**Branch:** `feat/TS-rewrite`
**Status:** Design approved, pending implementation plan

---

## Problem

The current Python system is a deterministic pipeline: parse Semgrep JSON, fingerprint, classify, pre-compute context via tree-sitter extraction and framework KB lookup, send a single LLM call, done. The LLM cannot explore the codebase, request additional files, follow references, or decide when it has enough context. The "thinking log" in the TUI displays predetermined steps, not actual agent reasoning.

## Solution

Full TypeScript rewrite using the Vercel AI SDK. Replace the deterministic pipeline middle (context assembler, code extractor, framework KB) with an agentic loop where the LLM gets codebase exploration tools and drives its own investigation. Keep the deterministic bookends (parser, prefilter, fingerprint, memory).

## Architecture Overview

```
semgrep.json → parse → prefilter → for each finding:
  → agent loop:
      LLM sees: system prompt + finding summary + dataflow trace (if any)
      LLM calls tools: read, grep, glob, bash
      LLM calls tools: (as many rounds as needed)
      LLM calls verdict tool → loop exits
  → store verdict in memory
  → render in TUI
```

**What's gone (replaced by agent exploration):**
- Context assembler (Branch A/B logic)
- Code extractor (tree-sitter function body/callers/imports extraction)
- Framework KB (hardcoded sanitizer/detection lists)
- LLM fallback chain (structured → raw → regex)

**What's ported from Python:**
- Semgrep JSON parser
- Fingerprinter (SHA-256 hash)
- Prefilter (test files, generated code, INFO severity, cached verdicts)
- Memory store (SQLite verdict cache)

**What's new:**
- Agentic loop (Vercel AI SDK `streamText()` with tool callbacks)
- Tool definitions (read, grep, glob, bash, verdict)
- Agent event stream for TUI rendering
- Ink-based TUI
- Multi-provider support via Vercel AI SDK

---

## 1. Agent Loop

### Entry

For each finding that passes prefilter, start an agent loop. The loop is managed by `streamText()` from the Vercel AI SDK with tools registered as callbacks.

### Initial Context

The LLM receives:

```markdown
## Finding
Rule: {check_id}
Severity: {severity}
CWE: {cwe list}
File: {path}, line {start.line}
Message: {extra.message}

## Dataflow (if present)
Source: {taint_source.content} at {taint_source.location.path}:{line}
Sink: {taint_sink.content} at {taint_sink.location.path}:{line}
Intermediates: {intermediate_vars with locations}

## Your Task
Investigate this finding. Read the relevant files, trace the data flow,
check for sanitization, framework protections, and whether the code is
reachable. Use your tools. When you have enough evidence, call the
verdict tool with your determination.
```

No pre-computed context. The LLM decides what to read.

### Loop Mechanics

1. Build messages array: system prompt + finding summary
2. Call `streamText()` with tools
3. SDK streams events: text deltas, tool calls, tool results
4. Tool calls execute via callbacks, results feed back automatically
5. Loop continues until:
   - LLM calls the `verdict` tool → normal exit
   - Max steps reached (default 15) → force `needs_review` verdict
   - Doom loop detected → warn once, then force exit
   - Unrecoverable error → `needs_review` with error message

### Doom Loop Detection

Track the last 3 tool calls. If the same tool is called with identical arguments 3 times consecutively, inject a warning message: "You've called {tool} with the same arguments 3 times. Please try a different approach or deliver your verdict." If it happens again after the warning, force exit with `needs_review`.

### Event Stream

The loop emits typed events for the TUI:

```typescript
type AgentEvent =
  | { type: "tool_start"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; summary: string; full: string }
  | { type: "thinking"; delta: string }
  | { type: "verdict"; verdict: TriageVerdict }
  | { type: "error"; message: string }
```

---

## 2. Tools

Five tools. All file-system tools operate relative to the project root and reject paths outside it.

### read

Read file contents with line numbers.

- **Params:** `path` (relative), `offset?` (1-indexed, default 1), `limit?` (default 200 lines)
- **Returns:** File content prefixed with line numbers
- **Constraints:** Rejects binary files. Output capped at 50KB. 200-line default keeps agent context lean.

### grep

Regex search via ripgrep.

- **Params:** `pattern` (regex), `path?` (subdirectory), `include?` (glob filter)
- **Returns:** Up to 50 matches as `file:line:content`, grouped by file
- **Constraints:** 50-match cap forces the agent to write narrow searches.

### glob

File pattern discovery via ripgrep `--files`.

- **Params:** `pattern` (glob), `path?` (search root)
- **Returns:** Up to 50 file paths, sorted by modification time
- **Constraints:** Auto-ignores `node_modules/`, `.git/`, `dist/`, `__pycache__/`, `venv/`, `build/`

### bash

Shell command execution for read-only exploration.

- **Params:** `command`, `timeout?` (default 30s)
- **Returns:** stdout + stderr, truncated at 50KB
- **Constraints:** Blocked commands: `rm`, `mv`, `cp`, `chmod`, `chown`, `curl`, `wget`, `nc`. Read-only exploration only. Opt-in via `--allow-bash` CLI flag — disabled by default.

### verdict

Structured output tool — how the agent delivers its answer.

- **Params (Zod schema):**
  - `verdict`: `"true_positive" | "false_positive" | "needs_review"`
  - `reasoning`: string — step-by-step analysis
  - `key_evidence`: string[] — specific code patterns/facts
  - `suggested_fix?`: string — remediation if true_positive
- **Effect:** Calling this tool exits the agent loop. No confidence score — the verdict is categorical.

---

## 3. Provider System

Vercel AI SDK provider abstraction. Each provider is a config object — the SDK handles wire protocol, message formatting, tool serialization.

### Supported Providers

| Provider | Package | Models |
|----------|---------|--------|
| OpenAI | `@ai-sdk/openai` | gpt-4o, o3-mini, o4-mini |
| Anthropic | `@ai-sdk/anthropic` | claude-sonnet, claude-opus |
| Google | `@ai-sdk/google` | gemini-2.5-pro, gemini-2.5-flash |
| OpenRouter | `@openrouter/ai-sdk-provider` | Any model via OpenRouter |

### Configuration

CLI flags `--provider` and `--model` are both required. API keys from environment variables: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`.

### Provider-Specific Handling

Minimal. The SDK normalizes most differences. Only:
- **Reasoning models** (o3/o4/Claude with thinking): SDK handles role mapping internally
- **Cache control**: Anthropic cache headers on system prompt via SDK's native support

The `verdict` tool approach (vs `response_format`) ensures universal structured output across all providers — tool calling is supported everywhere.

---

## 4. Parser, Prefilter, Memory

Deterministic modules ported from Python. No agent involvement.

### Parser (`parser/semgrep.ts`)

- Parses Semgrep JSON `results` array into typed `Finding` objects
- Zod schema with `.passthrough()` for unknown extra fields
- CliLoc normalization in a Zod `.transform()` — Semgrep registry rules return taint nodes as `["CliLoc", [{loc}, "content"]]`
- Exports: `parseSemgrepOutput()`, `fingerprintFinding()`, `classifyFinding()`

### Fingerprint (`parser/fingerprint.ts`)

- SHA-256 of `check_id + path + start.line + start.col + lines`
- Same logic as Python version
- Known gotcha: `lines` field differs with/without `SEMGREP_APP_TOKEN` auth

### Prefilter (`parser/prefilter.ts`)

Skip rules:
- Test files: `**/test_*`, `**/tests/**`, `**/__tests__/**`, `**/*.test.*`, `**/*.spec.*`
- Generated files: `**/generated/**`, `**/migrations/**`, `**/*.min.js`
- INFO severity
- Cached verdicts (fingerprint exists in memory store, only when memory DB is configured)

Returns `{ passed: boolean; reason?: string }`.

### Memory (`memory/store.ts`)

- SQLite via `better-sqlite3` (synchronous, simple)
- Schema: fingerprint (PK), check_id, path, verdict, reasoning, created_at, updated_at
- `getHints(checkId, fingerprint)`: returns prior verdicts as string hints for system prompt
- `store(record)`: upsert by fingerprint
- Default path: `.sast-triage/memory.db` in project root, configurable via `--memory-db`

### Zod Models

**Finding** (`models/finding.ts`):
- Mirrors Python `SemgrepFinding`: `check_id`, `path`, `start`/`end` positions, `extra` with `message`, `severity`, `metadata` (CWE, vulnerability_class, technology), `dataflow_trace`

**TriageVerdict** (`models/verdict.ts`):
- `verdict`: enum `true_positive | false_positive | needs_review`
- `reasoning`: string
- `key_evidence`: string[]
- `suggested_fix?`: string

No confidence field.

---

## 5. Ink TUI

React-based terminal UI using Ink. Single screen with three panels.

### Layout

```
┌─────────────────┬──────────────────────────────────┬──────────┐
│  FindingsTable  │         AgentPanel               │ Sidebar  │
│  (left, 25%)    │         (center, 55%)            │ (20%)    │
│                 │                                   │          │
│  ▸ sql-inject   │  ● Reading src/api/views.py      │ Total: 17│
│    xss-reflect  │    → def search(request): ...    │ Done: 3  │
│    path-travers │                                   │ TP: 1    │
│    ssrf-fetch   │  ● Grepping "sanitize" in src/   │ FP: 1    │
│    ...          │    → 0 matches                    │ NR: 1    │
│                 │                                   │          │
│                 │  💭 No sanitization found...      │ Model:   │
│                 │                                   │  gpt-4o  │
│                 │  ■ TRUE POSITIVE                  │          │
│                 │    Reasoning: ...                  │ Tokens:  │
│                 │    Evidence: ...                   │  12,450  │
│                 │    Fix: ...                        │          │
└─────────────────┴──────────────────────────────────┴──────────┘
```

### Components

**FindingsTable** (left panel)
- Post-prefilter findings list: rule_id (truncated), file:line, severity
- Color-coded: pending (dim), in-progress (yellow), true_positive (red), false_positive (green), needs_review (orange)
- Arrow keys to navigate. Selected finding shows its agent session in AgentPanel.
- Progress indicator: `3/17 triaged`

**AgentPanel** (center)
- Live stream of agent events for the selected finding
- `tool_start`: spinner icon ● + tool name + readable arg summary (`Reading src/api/views.py lines 30-60`)
- `tool_result`: indented below, condensed output (first few lines or match count summary). Expandable with Enter.
- `thinking`: 💭 icon, LLM reasoning streamed character by character
- `verdict`: colored banner (red/green/orange) with reasoning, evidence bullets, suggested fix
- ScrollView, auto-follows bottom during active investigation

**Sidebar** (right panel)
- Session stats: total findings, triaged count, TP/FP/NR breakdown
- Current provider/model
- Running token usage total
- Elapsed time

### Responsive Behavior

- Terminal < 100 cols: sidebar hidden
- Terminal < 80 cols: findings table collapses to icons only, agent panel gets full width

### Permissions Inline

No separate trust/config screens. When the agent tries to read a file outside project root or use bash, a prompt appears inline in the AgentPanel: "Agent wants to run `git blame src/api/views.py`. Allow? [y/n/always]"

---

## 6. CLI Interface

Commander-based. Single command, positional arg for findings file.

### Usage

```bash
# Interactive TUI (default)
sast-triage findings.json --provider openai --model gpt-4o

# Headless — NDJSON to stdout
sast-triage findings.json --headless --provider anthropic --model claude-sonnet-4-20250514

# Pipe from stdin
cat findings.json | sast-triage --provider openai --model gpt-4o
```

### Flags

| Flag | Default | Required | Description |
|------|---------|----------|-------------|
| `--provider` | — | yes | openai, anthropic, google, openrouter |
| `--model` | — | yes | Model ID |
| `--headless` | false | no | NDJSON output, no TUI |
| `--allow-bash` | false | no | Enable bash tool |
| `--max-steps` | 15 | no | Max agent loop iterations per finding |
| `--memory-db` | `.sast-triage/memory.db` | no | SQLite path |
| `--concurrency` | 1 | no | Parallel finding triage (future) |

### Headless Output

NDJSON — one JSON line per agent event, final line is the verdict. Compatible with `jq`, CI pipelines, and other tooling.

---

## File Structure

```
src/
  index.ts                  — CLI entry (commander)
  config.ts                 — provider config, env resolution
  parser/
    semgrep.ts              — parse Semgrep JSON, fingerprint, classify
    prefilter.ts            — cheap skip rules
  agent/
    loop.ts                 — agentic loop (streamText + tools + events)
    system-prompt.ts        — security analyst system prompt
    doom-loop.ts            — repeated call detection
    tools/
      index.ts              — tool registry
      read.ts               — read file with line numbers
      grep.ts               — ripgrep wrapper
      glob.ts               — file pattern discovery
      bash.ts               — sandboxed shell execution
      verdict.ts            — structured verdict output
  provider/
    registry.ts             — provider factory
  memory/
    store.ts                — SQLite verdict cache (better-sqlite3)
  models/
    finding.ts              — Zod: Finding, DataflowTrace, etc.
    verdict.ts              — Zod: TriageVerdict
    events.ts               — AgentEvent union type
  ui/
    app.tsx                 — Ink app root
    components/
      findings-table.tsx    — left panel
      agent-panel.tsx       — center panel (event stream)
      verdict-banner.tsx    — colored verdict display
      sidebar.tsx           — stats panel
      permission-prompt.tsx — inline permission dialog
  headless/
    reporter.ts             — NDJSON output for --headless mode
```

---

## Non-Goals (v1)

- LSP tool (requires running language servers per target project)
- MCP server mode (expose as tool server for other agents)
- Sub-agents (parallel investigation of related findings)
- Custom tool plugins
- Web UI
- Embedding-based code search
