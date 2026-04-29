# sast-triage

Agentic SAST finding triage. Feed it Semgrep JSON, it investigates each finding by reading code, grepping for context, and delivers a verdict: **true positive**, **false positive**, or **needs review**.

Unlike traditional SAST triage tools that use fixed heuristics, sast-triage gives the LLM read-only tools (`read`, `grep`, `glob`, `bash`) and lets it investigate autonomously — following data flows, checking sanitizers, reading configs — then call a `verdict` tool when it has enough evidence.

---

## Table of Contents

- [Quickstart (Docker)](#quickstart-docker)
- [Providers](#providers)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Development](#development)
- [Tech Stack](#tech-stack)

---

## Quickstart (Docker)

```bash
# One-time: log in with a PAT that has read:packages scope
echo "$GHCR_PAT" | docker login ghcr.io -u <your-github-username> --password-stdin

docker run --rm \
  -v "$PWD:/work" \
  -e SAST_API_KEY=sk-... \
  ghcr.io/get-wright/sast-triage:latest \
  --provider openai --model gpt-4o
```

Replace `<your-github-username>` with the GitHub username that owns the PAT. Output is written to `findings-out.json` in the mounted volume.

### Local development

```bash
cd sast-triage-ts
bun install              # use bun, not npm — bun.lock is the source of truth
bunx vitest run          # 143 tests
bunx tsc --noEmit        # type check
bun run src/index.ts findings.json --provider openai --model gpt-4o
```

### TUI

Archived on the `tui-snapshot` branch — no longer maintained on `main`.

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

Set via environment variable or the `--api-key` flag:

| Provider | Environment Variable |
|----------|---------------------|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Google AI | `GOOGLE_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| FPT AI | `FPT_API_KEY` |

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

Config is saved to `.sast-triage.toml` in the working directory:

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

Add `.sast-triage.toml` to your `.gitignore` (it may contain API keys).

---

## Development

```bash
cd sast-triage-ts
bun install

# Run tests (143 tests, ~0.7s, no network)
bunx vitest run

# Type check
bunx tsc --noEmit

# Run in dev mode
bun run src/index.ts findings.json --provider openai --model gpt-4o
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
│   └── provider/
│       ├── registry.ts       # Multi-provider resolution
│       └── reasoning.ts      # Reasoning effort mapping
└── tests/                    # Vitest, mirrors src/ structure
```

---

## Tech Stack

- **TypeScript** + **Zod** — models and validation
- **AI SDK v5** — multi-provider LLM interaction with `streamText` agentic loop
- **better-sqlite3** / **bun:sqlite** — verdict caching (runtime detection)
- **Commander** — CLI parsing
- **smol-toml** — config persistence
- **Vitest** — test runner
