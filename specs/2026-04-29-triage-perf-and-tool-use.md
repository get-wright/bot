# Triage Performance + Tool-Use Investigation (2026-04-29)

> Source data: `/tmp/sast-test/nodegoat/findings-out.json` — OWASP NodeGoat run, FPT GLM-5.1, `--effort medium`, 36 semgrep findings (34 after prefilter).

## TL;DR

Two distinct issues found:

1. **`--concurrency 20` silently fell back to `1`.** A clamp in `src/cli/cli.ts:68` discards any value `> 10` to `undefined`, and the orchestrator default is `1`. 10 fresh findings ran serially in 10:30 instead of in ~max(per-finding) ≈ 1:30. **~7× speedup left on the table.**
2. **The agent investigates inefficiently.** 108 reads across 34 findings, but **101 of them are full-file (no offset/limit)**, several files are pulled 3-7× per finding, and shotgun reads on guessed-but-nonexistent paths (`app/server.js`, `app/index.js`, `index.js`, …) account for double-digit wasted calls. The system prompt does not steer the model toward bounded reads or pre-glob discovery.

---

## 1. Silent concurrency cap

### The bug

`src/cli/cli.ts:68`:
```typescript
concurrency: (concurrency !== undefined && concurrency >= 1 && concurrency <= 10) ? concurrency : undefined,
```

If the user passes `--concurrency 20`, the `<= 10` branch is false → `concurrency: undefined` is forwarded to `resolveConfig`. The orchestrator's only default is `config.concurrency ?? 1` at `src/core/triage/orchestrator.ts:185`, so the actual concurrency is **1**.

There is no warning, no clamp message, no error. The user gets serial execution and no signal that their flag was discarded.

### Evidence

Wall-clock distribution of `audited_at` in the run output, grouped by `cached`:

| group | count | first audit | last audit | span |
|---|---|---|---|---|
| `cached: true` (loaded from prior run's memory.db, no fresh audit) | 24 | 05:43:07Z | 06:07:04Z | (these are prior run's timestamps; cache emit was instant) |
| `cached: false` (fresh audits this run) | 10 | 06:10:18Z | 06:20:48Z | **10:30** |

Inter-finding gap median for the fresh batch ≈ 60s, range 25-194s. Linear, not batched. With concurrency=1 this matches exactly: each finding waits for the prior to flush its agent loop before the next starts.

If concurrency=20 had taken effect (or even concurrency=10, the cap), all 10 fresh findings would have run in one batch and completed in roughly the time of the slowest single finding (~90-100s). Wall-clock would have been **~1:30 instead of ~10:30**.

### Compounding factors (unrelated to the cap, but related to perceived slowness)

- 24 entries marked `cached: true` are emitted instantly from `memory.db` — they don't call the LLM in this run. Their `tool_calls`/`input_tokens`/`output_tokens` shown in output are the **prior run's** stored values. So the run only did 10 fresh audits; the perceived "34 findings in 37 minutes" was wrong — it was "10 fresh audits in 10 minutes, sequentially, plus prior cached emit."
- `cached:true` audited_at timestamps in the output reflect the prior store time, not "now." The output's `audited_at` field is therefore mixed-temporal across cached and fresh entries; this is by design (orchestrator.ts:168) but easy to misread.

### Fix options (in order of preference)

1. **Clamp + warn**: `Math.max(1, Math.min(opts.concurrency, MAX_CONCURRENCY))`, log a one-line warning to stderr if the input was clamped. Keep `MAX_CONCURRENCY` provider-aware (e.g. 10 default, raise to 30+ for FPT/OpenRouter where rate limits are looser, lower for tier-1 OpenAI).
2. **Hard error**: refuse `--concurrency 20` if the cap is 10, with a message naming the cap. Worse UX than (1) but never silent.
3. **Remove the cap entirely**: trust the user; let provider rate limits surface naturally as backoff. Cleanest but loses the safety rail.

The current `<= 10 || undefined` pattern is the worst combination: silent + lossy + opinionated.

### Where else the same pattern may exist

- `src/cli/project-config.ts` reads `concurrency` from TOML — verify it has matching (or absent) clamping. If TOML accepts 20 but CLI clamps it, results differ depending on how the value is supplied.
- The `findings.length <= 0 || > 10` pattern doesn't appear elsewhere (grep shows the cap is unique to this line), but worth a sweep when fixing.

---

## 2. Tool-use efficiency

### Aggregate stats (34 findings, 197 tool calls total)

| metric | value |
|---|---|
| reads | 108 (avg 3.2/finding) |
| greps | 41 (avg 1.2/finding) |
| globs | 48 (avg 1.4/finding) |
| bash | 0 |
| reads with `offset` or `limit` set | **7 of 108 (6%)** |
| reads on a path that doesn't exist in the repo | ≥ 6 unique paths (sum across calls is higher) |
| reads where the same path is read ≥ 2× in the same finding | 4 distinct cases, up to 3× |
| highest call count for a single finding | 17 (`benefits.html:54`, django-csrf rule on a Node.js project) |

### Pattern 1 — Full-file reads dominate

101/108 reads use no `offset`/`limit`. Every call ships the full file content into context. For files like `server.js` (~150 lines) read 14× across the run, that's massive token waste. Specifically:
- `server.js`: 14 reads, 0 used offset/limit.
- `config/config.js`: 10 reads.
- `config/env/all.js`: 9 reads.
- `app/routes/contributions.js`: 9 reads.

The `read` tool already supports offset/limit (verified in `src/core/agent/tools/read.ts`) and the CLAUDE.md gotcha "Read tool metadata footers" indicates the tool emits `[Showing lines X-Y of N — use offset=Y+1 to continue]` to teach the model to paginate. The model rarely uses it. **The system prompt isn't pushing hard enough on bounded reads, or the model treats the 6% of paginated reads as edge cases.**

### Pattern 2 — Same file read multiple times within one finding

Examples:
- `a2.html:209` finding → `app/views/tutorial/a2.html` read 3×.
- `memos.html:15` finding → `app/server.js` read 2×.
- `a2.html:207` finding → `app/views/tutorial/a2.html` read 2×.

Each repeat is a full-file pull. The model is effectively re-fetching content it already had in context, presumably because the earlier output scrolled out of its working window or it forgot it had the data.

### Pattern 3 — Shotgun reads on guessed paths

For a single finding (`benefits.html:54`, django-csrf rule), the model blasted through:
```
read("app")              ← directory, fails
read(".")                ← directory, fails
read("app/server.js")    ← doesn't exist
read("app/app.js")       ← doesn't exist
read("app/index.js")     ← doesn't exist
read("server.js")        ← exists ✓
read("index.js")         ← doesn't exist
read("app/routes.js")    ← doesn't exist
read("app/routes/index.js")  ← exists ✓
read("app/routes/benefits.js")  ← exists ✓
```

Six of those ten reads were misses. The model could have prefixed with one `glob("**/*.{js,ts}")` to know what exists; some siblings did exactly that, finishing in 5-7 calls instead of 17.

### Pattern 4 — Cross-language false-trail

Several Django/Python rules (`python.django.security.django-no-csrf-token`) fire on a Node.js codebase (NodeGoat). The model dutifully runs `glob("**/*.py")` and `grep("CsrfViewMiddleware")` — finds nothing — then pivots. **One glob proves the absence of Python; the model often runs three before giving up.** Could be short-circuited if the system prompt told it: "the rule's language is X; if `glob('**/*.{matching ext}')` returns empty, treat that as conclusive and skip the language-specific search."

### Pattern 5 — Directory reads

`read(".")` and `read("app")` are called as directory probes. The `read` tool errors on directories (it's a file reader, not `ls`). Each directory read is a wasted round trip. The model should be using `glob` for discovery, not `read`. **`read` should reject directory paths up-front with a structured "use glob/ls instead" message** (it may already; would need to verify the response format) — but the model still tries occasionally, suggesting the error message isn't being remembered turn-to-turn.

### Net effect on per-finding cost

Average per-fresh-finding: **6 tool calls × ~16K input tokens** + thinking deltas. With ~50% read waste (101 unbounded full-files where bounded ranges would've sufficed) and shotgun overhead, a realistic post-fix target is **3-4 tool calls × ~5-8K input tokens** — a 2-3× reduction in latency and tokens per finding.

### Fix options

1. **System prompt pressure**: add a hard rule like "Never call `read` without `offset` and `limit` unless the file is < 50 lines. Glob first to know which files exist." Cheap, may help.
2. **Tool-side enforcement**: have `read` refuse paths > 200 lines without offset/limit (return an error: "file is N lines; pass offset+limit"). Forces pagination.
3. **Read-cache within a finding**: orchestrator-level memoization: if the same path is requested twice in one agent loop, return a "you already read this at step K, scroll back" pointer instead of re-pulling content. Reduces token-per-finding without changing model behavior.
4. **Project-tree primer in system prompt**: emit a `tree` of the project (depth 3, files only) once at session start and prepend to every finding's prompt. Eliminates shotgun reads. Cost: ~500-2000 tokens fixed; saves ~3K tokens per finding × 34 = ~100K total. Net win.
5. **Rule-language gate**: when the rule's `check_id` namespace doesn't match any file extension present in the repo, short-circuit to "rule language not present, evaluating manually" without globbing. Save 1-3 calls per cross-language false-trail.

The cheapest high-leverage move is **(4) project-tree primer**. The most architecturally sound is **(2) read-side enforcement** combined with **(3) per-finding read cache** — both put the discipline in the harness, not in the prompt where it's negotiable.

---

## Tracking

- Concurrency cap fix: needs a small CLI patch + test. Estimated effort: 1-2 hours.
- Tool-use harness improvements: pick one of (2)/(3)/(4); each is ~2-4 hours plus a regression test against a captured findings.json.
- Out of scope here: changing the FPT GLM-5.1 reasoning effort or the agent loop's verdict-extraction logic — both worked fine in this run.
