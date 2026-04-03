# PROJECT KNOWLEDGE BASE

**Generated:** 2026-04-03
**Commit:** a295199
**Branch:** main

## OVERVIEW

SAST Triage — CLI tool + library + interactive TUI that triages Semgrep findings via deterministic context assembly + single LLM call. Python 3.12+, Pydantic v2, tree-sitter, OpenAI SDK, Click, Textual.

## STRUCTURE

```
sast_triage/
├── models.py           # ALL domain types (Pydantic v2) — single source of truth
├── parser.py           # Semgrep JSON → SemgrepFinding + classification + fingerprinting
├── prefilter.py        # Deterministic noise reduction BEFORE LLM (test/generated/cached/INFO)
├── pipeline.py         # TriagePipeline orchestrator — the public API
├── cli.py              # Click CLI: `triage` and `feedback` commands
├── context/            # Tree-sitter extraction + framework KB + context assembly (see context/AGENTS.md)
├── llm/                # OpenAI client with fallback chain + prompt templates (see llm/AGENTS.md)
├── memory/             # SQLite verdict cache (MemoryStore) — context manager protocol
└── tui/                # Interactive Textual TUI — `sast-triage ui` (see tui/AGENTS.md)
tests/
├── conftest.py         # Shared fixtures (JSON payloads + source file bytes)
├── fixtures/           # 3 Semgrep JSON outputs + 3 sample source files (py/js/ts)
└── test_*.py           # 1:1 mapping to source modules + test_integration.py
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add vulnerability class | `context/framework_kb.py` → `FRAMEWORK_SANITIZERS`, `llm/prompts.py` → `VULN_CLASS_CONTEXT` | Also add CWE mapping in `context/assembler.py` → `_classify_vuln()` |
| Add language support | `context/code_extractor.py` → `LANG_MAP` + `_init_languages()` | Install `tree-sitter-<lang>` in pyproject.toml |
| Add CLI command | `cli.py` → `@main.command()` | Follow Click group pattern |
| Change pre-filter rules | `prefilter.py` → `TEST_DIR_PATTERNS`, `GENERATED_PATH_PATTERNS` | Hard-coded, no override flag |
| Add new LLM provider | `llm/client.py` → `Provider` enum | Add enum value + base URL + env key mapping |
| Programmatic usage | `pipeline.py` → `TriagePipeline` | Accepts optional `file_reader`, `llm_client`, `memory` |
| Add framework hints | `context/framework_kb.py` | Dict-based — add to `FRAMEWORK_SANITIZERS` + `FRAMEWORK_DETECTION` |

## CONVENTIONS

- `from __future__ import annotations` on every file with type hints
- Named imports only, no wildcards — `from sast_triage.models import SemgrepFinding`
- Empty `__init__.py` in subpackages — no barrel exports
- `TYPE_CHECKING` guard for circular imports; deferred imports inside functions as fallback
- `@dataclass` for value/result objects; plain `class` for service/behavior objects
- Constants: `SCREAMING_SNAKE_CASE` at module level
- Private: single `_underscore` prefix (methods and module helpers)
- Logging: `logger = logging.getLogger(__name__)`, format strings not f-strings — `logger.warning("msg %s", val)`
- Pydantic: `ConfigDict(extra="allow")` on models wrapping external data; `Field(default_factory=list)` for lists
- No linter/formatter/type-checker configured — no ruff, mypy, black, or pyright

## ANTI-PATTERNS (THIS PROJECT)

- **Never construct `DataflowTrace` from raw Semgrep JSON without Pydantic validation** — CliLoc format (`["CliLoc", [{loc}, "content"]]`) is normalized by `model_validator`. Bypassing it = silent None fields.
- **Cache threshold 0.8 is hard-coded** in `prefilter.py:72` — no CLI override. Only workaround: delete SQLite row manually.
- **Fingerprint includes `lines` field** — depends on `SEMGREP_APP_TOKEN`. Same finding produces different fingerprints with/without auth. Cache misses across authenticated vs unauthenticated runs.
- **No `__main__.py`** — cannot run as `python -m sast_triage`. Entry is exclusively via installed `sast-triage` CLI script.

## TESTING

```bash
pip install -e ".[dev]"
python3 -m pytest tests/ -v        # 130 tests, ~0.9s, no network/API keys (TUI widget tests require textual)
```

- Separate `tests/` dir, 1:1 file-per-module + `test_integration.py` + `test_cli.py`
- LLM always mocked via `unittest.mock.MagicMock` — no `pytest-mock` or external mocking libs
- Private `_make_*()` factory functions per test file — not shared fixtures unless used across 3+ files
- `tmp_path` for SQLite in memory/pipeline tests
- `class Test<Concept>` for multi-scenario suites; flat `def test_*` for simple modules
- No `@pytest.mark.parametrize`, no coverage config, no CI test automation
- TUI tests (`test_tui_widgets.py`, `test_tui_orchestrator.py`, `test_tui_config.py`) require `pip install -e ".[tui]"`

## COMMANDS

```bash
pip install -e ".[dev]"                          # install with dev deps
python3 -m pytest tests/ -v                      # run tests
sast-triage triage findings.json --no-llm        # dry run (no LLM)
sast-triage triage findings.json --model o3-mini  # with LLM (OpenAI reasoning)
sast-triage triage findings.json --provider openai-compatible --model qwen/qwq-32b --base-url https://openrouter.ai/api/v1  # OpenRouter
sast-triage feedback <fingerprint> "note"        # annotate stored record
sast-triage ui                                   # interactive TUI (requires pip install -e ".[tui]")
```

## NOTES

- `sast_triage.egg-info/` is committed — should be gitignored
- `.sisyphus/` exists but is empty — placeholder
- `.github/workflows/opencode.yml` uses `actions/checkout@v6` — may be a typo (latest stable is v4)
- CI only has an opencode bot trigger — no automated test/lint/build pipeline
- Tree-sitter parsers initialize eagerly at `TriagePipeline` construction — all 4 languages parse even if only 1 is needed