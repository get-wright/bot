> **This branch is an archived TUI snapshot.** Active development happens on `main` (headless-only).
> Last sync with `main`: 0d535de on 2026-04-28.
> To revive: rebase or cherry-pick from `main` manually. No CI runs against this branch.

# sast-triage

Agentic SAST finding triage. Feed it Semgrep JSON, it investigates each finding by reading code, grepping for context, and delivers a verdict: **true positive**, **false positive**, or **needs review**.

Unlike traditional SAST triage tools that use fixed heuristics, sast-triage gives the LLM read-only tools (`read`, `grep`, `glob`, `bash`) and lets it investigate autonomously — following data flows, checking sanitizers, reading configs — then call a `verdict` tool when it has enough evidence.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Building from Source](#building-from-source)
- [Usage](#usage)
  - [Interactive TUI](#interactive-tui)
  - [Headless Mode](#headless-mode-ciscripts)
  - [CLI Reference](#cli-reference)
- [Providers](#providers)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Development](#development)
- [Tech Stack](#tech-stack)

---

## Quick Start

```bash
cd sast-triage-ts
npm install
bun build src/index.ts --compile --outfile sast-triage

# Run on a repo with Semgrep findings
cd /path/to/your/repo
semgrep scan --json -o findings.json
/path/to/sast-triage
```

First launch walks you through setup (provider, API key, model). Config saves to `.sast-triage.toml` — subsequent launches skip straight to triage.

---

## Building from Source

### Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| [Node.js](https://nodejs.org/) | >= 20 | Install dependencies, run tests |
| [Bun](https://bun.sh/) | >= 1.0 | Compile standalone binary |

### Build

```bash
cd sast-triage-ts

# Install dependencies
npm install

# Compile standalone binary (~63 MB, macOS arm64)
bun build src/index.ts --compile --outfile sast-triage
```

The binary is self-contained — no Node.js or Bun runtime needed to run it. Copy it anywhere on your `PATH`:

```bash
cp sast-triage /usr/local/bin/
```

### Cross-compilation

Bun supports cross-compiling to other targets:

```bash
# Linux x64
bun build src/index.ts --compile --target=bun-linux-x64 --outfile sast-triage-linux

# macOS x64
bun build src/index.ts --compile --target=bun-darwin-x64 --outfile sast-triage-x64
```

---

## Usage

### Interactive TUI

```bash
sast-triage                       # setup wizard on first run
sast-triage findings.json         # skip setup if config saved
sast-triage --effort high         # enable extended reasoning
sast-triage --no-log              # disable debug logging
```

Three-panel layout: findings list | agent investigation | stats sidebar.

**Navigation**

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move selection in findings list |
| `Tab` | Cycle views: Active → Filtered → Dismissed |
| `Space` | Toggle multi-select on current finding |
| `a` | Select all in current view |
| `q` | Quit |

**Active view**

| Key | Action |
|-----|--------|
| `Enter` | Triage selected finding(s); batches with multi-select |
| `r` | Re-audit current finding (clears cached verdict) |
| `f` | Ask a follow-up question about the current verdict |
| `Esc` | Stop a running batch queue |

**Filtered view**

| Key | Action |
|-----|--------|
| `Enter` | Promote selected finding(s) to Active and triage |
| `d` | Dismiss current finding (moves to Dismissed) |

**Dismissed view**

| Key | Action |
|-----|--------|
| `Enter` | Restore selected finding(s) back to Filtered |

**Agent panel scroll** (middle panel, when content exceeds viewport)

| Key | Action |
|-----|--------|
| `PgUp` / `PgDn` | Scroll by page |
| `Shift+↑` / `Shift+↓` | Scroll by page |
| `Home` / `End` | Jump to top / bottom (End resumes auto-follow) |

The agent panel auto-follows new output during investigation. Scrolling up pauses auto-follow; pressing `End` or scrolling back to the bottom resumes it.

**Other**

| Key | Action |
|-----|--------|
| `Ctrl+P` | Switch provider mid-session (re-enters setup) |

### Headless Mode (CI/scripts)

```bash
sast-triage findings.json \
  --provider openai --model gpt-4o \
  --headless
```

Outputs one NDJSON line per event (tool calls, verdicts). Pipe to `jq` or ingest into dashboards:

```bash
# Extract just the verdicts
sast-triage findings.json --provider anthropic --model claude-sonnet-4-20250514 --headless \
  | jq 'select(.type == "verdict")'

# Count true positives
sast-triage findings.json --provider openai --model gpt-4o --headless \
  | jq -s '[.[] | select(.type == "verdict" and .verdict.verdict == "true_positive")] | length'
```

### CLI Reference

```
sast-triage [options] [findings]

Arguments:
  findings                Path to Semgrep JSON output file

Options:
  -V, --version           Show version number
  --provider <provider>   LLM provider (openai, anthropic, google, openrouter, fpt)
  --model <model>         Model ID
  --headless              Output NDJSON instead of TUI
  --allow-bash            Enable bash tool for agent
  --max-steps <n>         Max agent loop steps per finding (default: 15)
  --memory-db <path>      SQLite memory DB path (default: .sast-triage/memory.db)
  --effort <level>        Reasoning effort: low, medium, high
  --no-log                Disable debug logging (enabled by default)
  -h, --help              Show help
```

---

## Providers

| Provider | Display Name | Model Examples | Notes |
|----------|-------------|----------------|-------|
| `openai` | OpenAI | `gpt-4o`, `gpt-4.1` | Direct OpenAI API |
| `anthropic` | Anthropic | `claude-sonnet-4-20250514` | Direct Anthropic API |
| `google` | Google AI | `gemini-2.5-pro` | Google AI Studio |
| `openrouter` | OpenRouter | `anthropic/claude-sonnet-4`, `z-ai/glm-4.7` | Any model via OpenRouter |
| `fpt` | FPT AI Marketplace | `DeepSeek-R1`, `Qwen2.5-Coder-32B-Instruct` | FPT Cloud AI Marketplace |

### API Keys

Set via environment variable or enter in the TUI setup wizard:

| Provider | Environment Variable |
|----------|---------------------|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Google AI | `GOOGLE_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| FPT AI | `FPT_API_KEY` |

Keys entered in the TUI are saved to `.sast-triage.toml` and persist across sessions.

---

## How It Works

```
Semgrep JSON → Parse → Pre-filter → Agent Loop → Verdict → Memory
```

1. **Parse** — Extract findings from Semgrep JSON, fingerprint each one, classify as taint/pattern.
2. **Pre-filter** — Remove test files, generated code, and INFO severity. Previously cached verdicts are preserved (they're completed work, not noise).
3. **Agent Loop** — The LLM gets the finding + tools, investigates autonomously:
   - `read` — read source files with line numbers
   - `grep` — regex search across codebase
   - `glob` — find files by pattern
   - `bash` — run read-only shell commands (optional, `--allow-bash`)
   - `verdict` — deliver final triage decision (ends investigation)
4. **Memory** — Cache verdicts in SQLite. On next run, cached findings reload with their full audit history.

### Pre-filter Rules

Automatically skips findings in:

- **Test files** — `tests/`, `test_`, `.spec.`, `conftest.py`
- **Generated code** — `migrations/`, `node_modules/`, `dist/`, `.min.js`
- **INFO severity** — low-signal findings filtered by default

### Reasoning Effort

The `--effort` flag controls thinking budget for reasoning-capable models:

| Level | OpenAI / OpenRouter / FPT | Anthropic | Google |
|-------|---------------------------|-----------|--------|
| `low` | `reasoningEffort: low` | 4K thinking tokens | 4K thinking budget |
| `medium` | `reasoningEffort: medium` | 10K thinking tokens | 10K thinking budget |
| `high` | `reasoningEffort: high` | 32K thinking tokens | 32K thinking budget |

Models that don't support reasoning silently ignore this setting.

---

## Configuration

On first run, the TUI saves your choices to `.sast-triage.toml` in the working directory:

```toml
[provider]
name = "openrouter"
model = "anthropic/claude-sonnet-4"
base_url = "https://openrouter.ai/api/v1"
reasoning_effort = "medium"

[provider.api_keys]
openrouter = "sk-or-..."

[memory]
db_path = ".sast-triage/memory.db"
```

Subsequent runs auto-load this config. Add `.sast-triage.toml` to your `.gitignore` (it may contain API keys).

---

## Development

```bash
cd sast-triage-ts
npm install

# Run tests (115 tests, ~0.7s, no network)
npx vitest run

# Type check
npx tsc --noEmit

# Run in dev mode (without compiling)
npx tsx src/index.ts

# Compile binary
bun build src/index.ts --compile --outfile sast-triage
```

### Project Structure

```
sast-triage-ts/
├── src/
│   ├── index.ts              # CLI entry (commander)
│   ├── agent/
│   │   ├── loop.ts           # Agent loop (streamText + tools)
│   │   ├── follow-up.ts      # Conversational follow-up on verdicts
│   │   ├── system-prompt.ts  # System prompt + finding formatter
│   │   └── tools/            # read, grep, glob, bash, verdict
│   ├── config/
│   │   └── project-config.ts # .sast-triage.toml persistence
│   ├── memory/
│   │   └── store.ts          # SQLite verdict cache
│   ├── models/
│   │   ├── finding.ts        # Finding schema (Zod)
│   │   ├── verdict.ts        # Verdict schema (Zod)
│   │   └── events.ts         # Agent event types
│   ├── parser/
│   │   ├── semgrep.ts        # Parse + fingerprint
│   │   └── prefilter.ts      # Test/generated/INFO filter
│   ├── provider/
│   │   ├── registry.ts       # Multi-provider resolution
│   │   └── reasoning.ts      # Reasoning effort mapping
│   ├── ui/
│   │   ├── app.tsx           # Main TUI (Ink)
│   │   └── components/       # SetupScreen, FindingsTable, AgentPanel, Sidebar
│   └── logger.ts             # File-based debug logger
└── tests/                    # Vitest, mirrors src/ structure
```

---

## Tech Stack

- **TypeScript** + **Zod** — models and validation
- **AI SDK v5** — multi-provider LLM interaction with `streamText` agentic loop
- **Ink 6** + **React 19** — terminal UI
- **fullscreen-ink** — alternate screen buffer with responsive resize
- **better-sqlite3** / **bun:sqlite** — verdict caching (runtime detection)
- **Commander** — CLI parsing
- **smol-toml** — config persistence
- **Vitest** — test runner
