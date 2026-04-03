# TUI MODULE

Interactive Textual TUI for step-by-step finding triage with live thinking log and verdict display.

## OVERVIEW

`sast-triage ui` launches a multi-screen Textual app. `AuditOrchestrator` reimplements the pipeline as a synchronous generator (NOT `TriagePipeline`) so each step can update the UI incrementally.

## STRUCTURE

```
tui/
├── app.py              # SastTriageApp — entry point, CSS path, global bindings
├── config.py           # ProjectConfig — reads/writes .sast-triage.toml
├── messages.py         # Message types (DECLARED BUT NEVER POSTED — dead code)
├── orchestrator.py     # AuditOrchestrator — sync generator, yields AuditStepResult per step
├── tui.tcss            # Shared Textual CSS — layout, sidebar dock, verdict colors
├── screens/
│   ├── trust.py        # TrustScreen — gate screen (y/n)
│   ├── config.py       # ConfigScreen — provider/model/API key form → .sast-triage.toml
│   ├── main.py         # MainScreen — tabbed findings browser (Actionable/Filtered/Saved)
│   └── audit.py        # AuditScreen — runs orchestrator in @work thread, drives ThinkingLog/VerdictPanel
└── widgets/
    ├── findings_table.py  # FindingsTable(DataTable) — multi-select via marker column
    ├── sidebar.py         # SessionSidebar(VerticalScroll) — 5 sections (SESSION, MEMORY, SELECTED, QUEUE, FINISHED)
    ├── thinking_log.py    # ThinkingLog(RichLog) — append-only step log
    └── verdict_panel.py   # VerdictPanel(VerticalScroll) — verdict banner + reasoning + evidence
```

## SCREEN FLOW

```
TrustScreen ──switch──► ConfigScreen ──switch──► MainScreen ◄──push/pop──► AuditScreen
     │                       ▲                       │                          │
     n → exit           ctrl+p (push)            enter (push)              esc (pop)
```

`switch_screen` = linear navigation (destroys previous). `push_screen` = overlay/drilldown (preserves caller). All transitions use deferred imports inside action methods to avoid circular imports.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add a screen | `screens/` + wire in action method on calling screen | Deferred import pattern |
| Add a widget | `widgets/` + compose in target screen | Follow existing `query_one` pattern |
| Change layout/colors | `tui.tcss` | Textual CSS variables only, no hardcoded hex |
| Change config schema | `config.py` → `ProjectConfig` | Also update `ConfigScreen` form fields |
| Change audit step flow | `orchestrator.py` → `audit_finding_iter()` | Yields `AuditStepResult` per step |
| Add keybinding | Target screen `BINDINGS` list + action method | Check `Footer` displays it |
| Add sidebar section | `widgets/sidebar.py` → `SECTIONS` tuple + `compose()` | Add helper method for updates |

## THREADING MODEL

- `AuditOrchestrator.audit_finding_iter()` is **synchronous** — blocks until complete
- `AuditScreen._audit_worker` runs it inside `@work(exclusive=True, group="audit", thread=True)`
- UI updates via `self.app.call_from_thread(widget.method, ...)` — NOT Textual messages
- `action_back` cancels via `self.workers.cancel_group(self, "audit")` + checks `worker.is_cancelled`
- **Two MemoryStore connections** during audit: worker thread (store/hints) + main thread (star actions)

## CONFIG FORMAT (`.sast-triage.toml`)

```toml
[provider]
name = "openai-reasoning"
model = "o3-mini"
reasoning_effort = "medium"
base_url = ""                    # only for openai-compatible

[provider.api_keys]
openai = "sk-..."                # fallback: OPENAI_API_KEY env var

[memory]
db_path = "./triage.db"          # relative to workspace

[workspace]
allowed_paths = ["/data/repos"]  # extra readable paths beyond workspace
```

## ENGINE INTEGRATION

TUI does NOT use `TriagePipeline`. The orchestrator calls engine modules directly:

| Engine module | Used by | How |
|---|---|---|
| `parser.parse_semgrep_output` | `MainScreen._import_findings` | Parse JSON |
| `parser.classify_finding` | Orchestrator step 2 | Taint vs pattern |
| `parser.fingerprint_finding` | Orchestrator step 1 | MD5 hash |
| `prefilter.prefilter_finding` | `MainScreen._import_findings` | Split actionable/filtered |
| `context.assembler.ContextAssembler` | Orchestrator step 4 | Context assembly |
| `context.code_extractor.CodeExtractor` | Orchestrator init | Passed to assembler |
| `llm.client.TriageLLMClient` | `AuditScreen.__init__` | LLM call in step 5 |
| `memory.store.MemoryStore` | 3 instances (see anti-patterns) | Cache + star + list |

## ANTI-PATTERNS

- **`messages.py` is dead code** — all 6 Message subclasses are declared but never posted. Cross-thread communication uses `call_from_thread` exclusively. Do not add new Messages expecting them to be handled.
- **`query_one` called from worker thread** (`audit.py:~166`) — Textual DOM queries are not thread-safe. Works in practice (read-only reference), but technically a race condition.
- **`__setattr__` dispatch trick** (`audit.py:~213`) — `call_from_thread(widget.__setattr__, "active", "verdict")` bypasses reactive property machinery. Fragile if Textual changes reactive semantics.
- **`MainScreen._memory` is never closed** — MemoryStore opened in `on_mount` with no `on_unmount` cleanup. SQLite connection leaks on screen switch.
- **`action_filter_findings` is a stub** — the `/` keybinding exists in Footer but shows "not yet implemented".
- **No workspace CLI flag for `ui` command** — always uses `Path.cwd()`. Unlike `triage` which takes a positional argument.
