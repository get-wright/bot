# sast-triage

Agentic SAST finding triage. Feed it Semgrep JSON, it investigates each finding by reading code, grepping for context, and delivers a verdict: **true positive**, **false positive**, or **needs review**.

Unlike traditional SAST triage tools that use fixed heuristics, sast-triage gives the LLM read-only tools (read, grep, glob, bash) and lets it investigate autonomously — following data flows, checking sanitizers, reading configs — then call a `verdict` tool when it has enough evidence.

## Quick Start

```bash
# From source
cd sast-triage-ts
npm install
bun build src/index.ts --compile --outfile sast-triage

# Run on a repo with Semgrep findings
cd /path/to/your/repo
semgrep scan --json -o findings.json
/path/to/sast-triage
```

First launch walks you through setup (provider, API key, model). Config saves to `.sast-triage.toml` — subsequent launches skip straight to triage.

## Usage

```
sast-triage [options] [findings]

Arguments:
  findings               Path to Semgrep JSON output file

Options:
  --provider <provider>  LLM provider (openai, anthropic, google, openrouter)
  --model <model>        Model ID
  --headless             Output NDJSON to stdout instead of TUI
  --allow-bash           Enable bash tool for agent
  --max-steps <n>        Max agent loop steps per finding (default: 15)
  --memory-db <path>     SQLite memory DB path
```

### Interactive TUI

```bash
./sast-triage                    # setup wizard on first run
./sast-triage findings.json      # skip to triage if config saved
```

Three-panel layout: findings list | agent investigation | stats sidebar.

**Navigation**
- **↑ / ↓** — move selection in findings list
- **Tab** — cycle views: Active → Filtered → Dismissed
- **Space** — toggle multi-select on current finding
- **a** — select all (in current view)
- **q** — quit

**Active view**
- **Enter** — triage selected finding(s); with multi-select, batches them
- **r** — re-audit current finding (clears cached verdict)
- **f** — ask a follow-up question about the current verdict
- **Esc** — stop a running batch queue

**Filtered view**
- **Enter** — promote selected finding(s) to Active and triage
- **d** — dismiss current finding (moves to Dismissed)

**Dismissed view**
- **Enter** — restore selected finding(s) back to Filtered

**Agent panel scroll** (middle panel, when content exceeds the viewport)
- **PgUp / PgDn** — scroll by page
- **Shift + ↑ / Shift + ↓** — also scroll by page
- **Home / End** — jump to top / bottom (End resumes auto-follow)

The agent panel auto-follows new output as the agent investigates. Scrolling up pauses auto-follow; pressing End (or scrolling back to the bottom) resumes it.

**Other**
- **Ctrl+P** — switch provider (re-enters setup)

### Headless (CI/scripts)

```bash
./sast-triage findings.json \
  --provider openai --model gpt-4o \
  --headless
```

Outputs one NDJSON line per event (tool calls, thinking, verdicts). Pipe to `jq` or ingest into dashboards.

## Providers

| Provider | Model examples | Notes |
|----------|---------------|-------|
| `openai` | `gpt-4o`, `gpt-4.1` | Direct OpenAI API |
| `anthropic` | `claude-sonnet-4-20250514` | Direct Anthropic API |
| `google` | `gemini-2.5-pro` | Google AI Studio |
| `openrouter` | `anthropic/claude-sonnet-4`, `z-ai/glm-4.7` | Any model via OpenRouter |
| `fpt` | `DeepSeek-R1`, `Qwen2.5-Coder-32B-Instruct` | FPT AI Marketplace |

API keys: set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, or `FPT_API_KEY` — or enter in the TUI setup.

## How It Works

```
Semgrep JSON → Parse → Pre-filter → Agent Loop → Verdict → Memory
```

1. **Parse** — Extract findings from Semgrep JSON, fingerprint each one, classify as taint/pattern
2. **Pre-filter** — Remove test files, generated code, INFO severity, previously cached verdicts
3. **Agent Loop** — LLM gets the finding + tools, investigates autonomously:
   - `read` — read files with line numbers
   - `grep` — regex search across codebase
   - `glob` — find files by pattern
   - `bash` — run read-only shell commands (git log, git blame, etc.)
   - `verdict` — deliver final triage decision (ends investigation)
4. **Memory** — Cache verdicts in SQLite for future runs

### Pre-filter

Automatically skips findings in:
- Test files (`tests/`, `test_`, `.spec.`, `conftest.`)
- Generated files (`migrations/`, `node_modules/`, `dist/`, `.min.js`)
- INFO severity findings
- Previously triaged findings (cached in SQLite)

### Config Persistence

On first run, the TUI saves your choices to `.sast-triage.toml` in the working directory:

```toml
[provider]
name = "openrouter"
model = "anthropic/claude-sonnet-4"
base_url = "https://openrouter.ai/api/v1"

[provider.api_keys]
openrouter = "sk-or-..."

[memory]
db_path = ".sast-triage/memory.db"
```

Subsequent runs auto-load this config. Add `.sast-triage.toml` to `.gitignore` (contains API keys).

## Development

```bash
cd sast-triage-ts
npm install
npx vitest run           # 112 tests, ~0.7s
npx tsc --noEmit         # type check
```

### Compile Binary

```bash
bun build src/index.ts --compile --outfile sast-triage
```

Produces a ~63MB standalone binary (macOS arm64). No Node.js or Bun runtime needed to run it.

## Tech Stack

- **TypeScript** + **Zod** for models
- **AI SDK v5** (`ai` package) for LLM interaction with `streamText` agentic loop
- **Ink 6** + **React 19** for terminal UI
- **fullscreen-ink** for alternate screen buffer
- **better-sqlite3** / **bun:sqlite** for verdict caching
- **Commander** for CLI
- **smol-toml** for config persistence
- **Vitest** for tests
