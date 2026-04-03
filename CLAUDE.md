# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

SAST Triage — CLI tool + library that triages Semgrep findings via deterministic context assembly + single LLM call.

**Two implementations:**
- **Python** (`sast_triage/`): Original. Python 3.12+, Pydantic v2, tree-sitter, OpenAI SDK, Click. Deterministic pipeline: parse → context assembly → single LLM call.
- **TypeScript** (`sast-triage-ts/`): Agentic rewrite. Node/Bun, AI SDK v5, Ink 6 TUI. The LLM drives its own investigation via read/grep/glob/bash tools and delivers a verdict.

## Commands

```bash
pip install -e ".[dev]"                    # install with dev deps
python3 -m pytest tests/ -v               # all tests (~130, ~0.9s, no network)
python3 -m pytest tests/test_parser.py -v  # single test file
python3 -m pytest tests/ -v -k "test_name" # single test by name
sast-triage triage findings.json --no-llm  # dry run (pre-filter + context only)
sast-triage triage findings.json --model o3-mini  # with LLM
```

No linter, formatter, or type-checker is configured.

## Architecture

```
Semgrep JSON → Parser → Pre-filter → Context Assembler → LLM → Memory
                │            │              │               │
          SemgrepFinding  filter out:    Branch A (taint)  structured output
                          test files,    Branch B (pattern) → fallback chain
                          generated,     framework KB         → regex extract
                          cached,        tree-sitter           → needs_review
                          INFO sev
```

**Pipeline flow** (`pipeline.py:TriagePipeline`): parse → fingerprint → classify → prefilter → assemble context → LLM call → store verdict in memory. Each step is a separate module with a clean boundary.

**Two context branches** in `context/assembler.py`:
- **Branch A (taint)**: Finding has `dataflow_trace` — extracts source→sink trace, function bodies at source/sink, intermediate vars
- **Branch B (pattern)**: No dataflow trace — extracts function containing finding + callers of that function

**LLM fallback chain** in `llm/client.py`: structured output (Pydantic schema) → raw JSON parsing (bracket-matching) → regex extraction → `needs_review` at 0% confidence. `OPENAI_COMPATIBLE` provider skips structured output entirely.

**Provider system** (`llm/client.py:Provider` enum): `OPENAI`, `OPENAI_REASONING` (o1/o3/o4 — uses `developer` role + `reasoning_effort`), `ANTHROPIC`, `OPENAI_COMPATIBLE` (OpenRouter/Ollama). Provider determines API behavior, not model name.

## Conventions

- `from __future__ import annotations` on every file with type hints
- Named imports only — `from sast_triage.models import SemgrepFinding`
- Empty `__init__.py` in subpackages — no barrel exports
- `TYPE_CHECKING` guard for circular imports
- `@dataclass` for value objects; plain `class` for service objects
- Constants: `SCREAMING_SNAKE_CASE` at module level
- Private: single `_underscore` prefix
- Logging: `logger = logging.getLogger(__name__)` with `%s` format (not f-strings)
- Pydantic: `ConfigDict(extra="allow")` on models wrapping external data; `Field(default_factory=list)` for lists
- Tests: `unittest.mock.MagicMock` (no pytest-mock), private `_make_*()` factories per file, `class Test<Concept>` for multi-scenario suites, `tmp_path` for SQLite

## Key Gotchas

- **CliLoc normalization**: Semgrep registry rules return taint nodes as `["CliLoc", [{loc}, "content"]]`. The `DataflowTrace.model_validator` normalizes this — never construct `DataflowTrace` from raw JSON without Pydantic validation.
- **Fingerprint includes `lines` field**: Different fingerprints with/without `SEMGREP_APP_TOKEN` auth. Cache misses across authenticated vs unauthenticated runs.
- **Cache threshold 0.8 is hard-coded** in `prefilter.py` — no CLI override.
- **No `__main__.py`** — entry is exclusively via installed `sast-triage` CLI script.
- **Tree-sitter parsers init eagerly** — all 4 languages parse at `CodeExtractor()` construction.
- **`reasoning_effort` is provider-specific** — only `OPENAI_REASONING` sends it. Other APIs reject unknown parameters.

## Where to Look

| Task | Location |
|------|----------|
| Add vulnerability class | `context/framework_kb.py` → `FRAMEWORK_SANITIZERS`, `llm/prompts.py` → `VULN_CLASS_CONTEXT`, `context/assembler.py` → `_classify_vuln()` |
| Add language support | `context/code_extractor.py` → `LANG_MAP` + `_init_languages()`, add `tree-sitter-<lang>` in pyproject.toml |
| Add CLI command | `cli.py` → `@main.command()` |
| Change pre-filter rules | `prefilter.py` → `TEST_DIR_PATTERNS`, `GENERATED_PATH_PATTERNS` |
| Add LLM provider | `llm/client.py` → `Provider` enum + `_PROVIDER_BASE_URLS` + `_PROVIDER_API_KEY_ENVS` |
| Add framework hints | `context/framework_kb.py` → `FRAMEWORK_SANITIZERS` + `FRAMEWORK_DETECTION` |
| Programmatic usage | `pipeline.py` → `TriagePipeline` (accepts optional `file_reader`, `llm_client`, `memory`) |

## TUI

Interactive terminal UI launched via `sast-triage ui`. Built with Textual ≥8.0.0.

**Install:** `pip install -e ".[tui]"` (textual is an optional dependency)

**Architecture:** Direct orchestration — TUI calls engine modules in sequence with UI updates between steps. Engine code is unchanged. `AuditOrchestrator` in `tui/orchestrator.py` is the glue layer.

**Screen flow:** TrustScreen → ConfigScreen → MainScreen ⇄ AuditScreen (push/pop)

**Key files:**
- `tui/app.py` — `SastTriageApp` entry point
- `tui/orchestrator.py` — calls parser/prefilter/assembler/LLM, yields `AuditStepResult` per step
- `tui/config.py` — `ProjectConfig` reads/writes `.sast-triage.toml`
- `tui/screens/` — one file per screen
- `tui/widgets/` — `FindingsTable`, `ThinkingLog`, `VerdictPanel`, `SessionSidebar`
- `tui/tui.tcss` — shared CSS (sidebar dock, responsive hiding, verdict colors)

**Threading:** OpenAI client is synchronous → audit worker uses `@work(thread=True)` + `call_from_thread()` for UI updates.

## TypeScript Rewrite (`sast-triage-ts/`)

**Branch:** `feat/TS-rewrite` — 87 tests, zero type errors.

### Commands

```bash
cd sast-triage-ts
npm install                                # install deps
npx vitest run                             # all tests (87, ~0.5s, no network)
npx tsc --noEmit                           # type check
bun build src/index.ts --compile --outfile sast-triage  # compile binary
./sast-triage                              # interactive TUI
./sast-triage findings.json --provider openai --model gpt-4o --headless  # NDJSON
```

### Architecture

```
Semgrep JSON → Parser → Pre-filter → Agent Loop (LLM + tools) → Verdict → Memory
                │            │              │                       │
          Finding model  filter out:    streamText + tools       TriageVerdict
                         test files,    read/grep/glob/bash      → SQLite cache
                         generated,     doom loop detection
                         cached,        stopWhen(stepCount)
                         INFO sev
```

**Key difference from Python:** The Python version assembles context deterministically then makes one LLM call. The TS version gives the LLM tools (read, grep, glob, bash, verdict) and lets it investigate autonomously via AI SDK's `streamText` agentic loop.

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

### Conventions

- Zod for validation schemas (Finding, Verdict, Events)
- Named imports, no barrel exports
- `vitest` for tests, `tmp_path` pattern via `import.meta.dirname`
- `smol-toml` for TOML config persistence
- Agent panel lines manually truncated to panel width (Ink `wrap="truncate"` unreliable in nested layouts)

### Key Gotchas

- **AI SDK v5 uses `inputSchema`** not `parameters` in `tool()` calls
- **OpenRouter must use `.chat(model)`** not `provider(model)` — the default hits the Responses API (`/responses`) which OpenRouter doesn't support
- **`bun:sqlite` vs `better-sqlite3`** — runtime detection via `typeof globalThis.Bun`. Binary uses bun:sqlite, vitest uses better-sqlite3.
- **`react-devtools-core` stub needed** for bun binary builds — Ink imports it optionally
- **Thinking tokens arrive word-by-word** — must collapse consecutive thinking events into paragraphs before rendering
- **`overflow="hidden"`** required on all Ink Box panels to prevent content overflow
