# Read-Efficiency Techniques for the Triage Agent Loop

> **Source notes** (verbatim research, kept locally for traceability):
> - `/tmp/sast-test/research-harness-patterns.md` — survey of Claude Code, Aider, Cline, SWE-agent, OpenHands, Continue.dev
> - `/tmp/sast-test/research-caching.md` — Anthropic prompt caching + AI SDK v5 mechanics
> - `/tmp/sast-test/research-code-aware.md` — tree-sitter / LSP / RAG / `code-review-graph` MCP

## Goal

Reduce re-reads and token cost during the per-finding agent loop in `src/core/agent/loop.ts` and the `read` tool at `src/core/agent/tools/read.ts`. The 2026-04-29 NodeGoat run showed:
- 94% of reads were unbounded full-file reads
- Same path was read 2-3× within one finding in 4 cases
- ~12+ wasted reads on guessed-but-nonexistent paths in one finding alone

The fixes need to work on **FPT GLM-5.1** (Chat Completions, the user's primary provider), not just on Anthropic. That eliminates prompt-caching as the headline fix and pushes the leverage onto the harness side.

---

## Technique catalog

Six techniques, ranked. Implementation lives in either `tools/read.ts`, `system-prompt.ts`, or `loop.ts`. Each technique is independent — they can be landed one at a time and gain compounding effect.

### 1. In-loop read registry with content-hash dedup *(highest leverage, ~15 LOC)*

**Mechanism.** Add a per-loop `Map<absPath, { hash: string; step: number; ranges: [start,end][] }>` passed into `createReadTool`. On every `read` call:

1. Stat the target file — capture `mtime`.
2. Read the bytes, hash them (SHA-256, 8 hex chars).
3. If the path is in the registry **AND** the hash is unchanged **AND** the requested range is fully covered by a prior read → return a stub: `[Already read at step K — content unchanged. Use offset N to scroll.]`
4. Otherwise serve normally and update the registry.

The registry lives for the lifetime of `runAgentLoop` (one finding) and is discarded between findings.

**Why it works.** The model's context already has the prior read output; a second identical read doubles token cost with zero new information. Weak models that scrolled past their earlier read most prone to this. The cache notice **re-anchors** the model on what it already has.

**Implementation sketch** (`src/core/agent/tools/read.ts`):
```typescript
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

interface ReadEntry { hash: string; step: number; mtimeMs: number }
export type ReadRegistry = Map<string, ReadEntry>;

export function createReadTool(
  projectRoot: string,
  registry?: ReadRegistry,
  getStep?: () => number,
) {
  return tool({
    /* ...existing definition... */
    execute: async ({ path, offset, limit }) => {
      const abs = resolve(projectRoot, path);
      const { mtimeMs } = statSync(abs);
      const buf = readFileSync(abs);
      const hash = createHash("sha256").update(buf).digest("hex").slice(0, 12);

      const prior = registry?.get(abs);
      if (prior && prior.hash === hash && prior.mtimeMs === mtimeMs) {
        // Same path, same content — caller has seen it.
        return `[Already read at step ${prior.step} — content unchanged (hash ${hash}). ` +
               `If you need a different range, pass offset/limit.]`;
      }
      registry?.set(abs, { hash, step: getStep?.() ?? 0, mtimeMs });
      return /* normal formatted read with footer */;
    },
  });
}
```

Wire into `loop.ts`:
```typescript
const readRegistry = new Map<string, ReadEntry>();
let currentStep = 0;
const tools = createTools({
  projectRoot,
  allowBash,
  // ...
  readRegistry,
  getStep: () => currentStep,
});
// In prepareStep callback: currentStep = stepNumber;
```

**Cost.** ~30 LOC across `read.ts` + `tools/index.ts` + `loop.ts`. No new dependencies. Backwards-compatible (registry is optional).

**Expected savings.** Eliminates the same-file-twice pattern entirely. On NodeGoat run that was 4 cases × ~10K extra input tokens each ≈ 40K tokens saved, ~5% of total. More on confused/longer loops where dedup compounds.

**Caveats.**
- Hashing only for files ≤ some size cap (already 50 KB cap exists in `read.ts`); skip hash for tiny files where it doesn't matter.
- Hash the buffer, not the path → catches in-session edits that change content.
- The stub message must be informative enough that the model doesn't re-issue the same request expecting different output.

---

### 2. Path existence gate with glob suggestion *(surgical, ~10 LOC)*

**Mechanism.** Before throwing `File not found`, run a `glob("**/<basename>", { cwd: projectRoot })` for the basename and append up to 5 suggestions to the error. SWE-agent and `read-once` do this; current `read.ts` throws the bare message.

**Why it works.** The shotgun pattern observed in NodeGoat (`app/server.js`, `app/index.js`, `index.js`, `app/routes.js`, `app/app.js`) is the model guessing plausible-but-wrong paths. A single corrected error message collapses 5 round trips into 1.

**Implementation sketch:**
```typescript
import { globSync } from "glob";
// in execute(), in the catch / not-exists branch:
const basename = path.split("/").pop()!;
const suggestions = globSync(`**/${basename}`, { cwd: projectRoot, ignore: ["**/node_modules/**"] }).slice(0, 5);
const hint = suggestions.length ? ` — did you mean: ${suggestions.join(", ")}?` : "";
throw new Error(`File not found: ${path}${hint}`);
```

**Cost.** ~10 LOC + glob already a dep. **Expected savings.** Eliminates 50-80% of shotgun reads on first-attempt 404. On the NodeGoat worst-case finding (`benefits.html:54`, 17 calls, 6 misses) this saves 5+ round trips.

---

### 3. System-prompt reinforcement *(cheapest, prompt-only)*

**Mechanism.** Add three lines to `SYSTEM_PROMPT` in `src/core/agent/system-prompt.ts`:

> - **Never call `read` without `offset` and `limit` unless the file is < 100 lines.** The metadata footer tells you the total line count — use it.
> - **Glob before reading a path you guessed.** If you're not certain a file exists, `glob('**/<basename>')` once before reading.
> - **Do not re-read a file you've already read.** If you need a different range of the same file, pass `offset`/`limit`. The harness will reject duplicate reads with a hash-stable stub.

**Why it works.** Soft pressure. Won't fix everything, but combined with the registry stub from #1 it gives the model a learnable signal: it sees its own read patterns getting deduped, then sees the prompt saying so.

**Cost.** 3 lines. **Expected savings.** Marginal alone (5-10%); compounds with #1 and #2.

---

### 4. Structural primer (per-finding file outline) *(medium-high leverage, ~50 LOC)*

**Mechanism.** Before the agent loop starts, generate a **symbol outline** of the file referenced by the finding using tree-sitter. Inject as a structured block at the top of the user message:

```
File outline for app/routes/contributions.js (function bodies elided):
  Line 8:   class Contributions
  Line 12:    constructor(db)
  Line 25:    handleContributionsUpdate(req, res)  ← FINDING ON LINE 32 IS INSIDE THIS METHOD
  Line 60:    displayPage(req, res)
```

This is Aider's repo-map applied at the single-file level (Aider does it cross-repo with PageRank; we just need the file the finding is in, plus maybe its imports).

**Why it works.** Eliminates the discovery phase. The agent already knows the function containing the finding's line; it can call `read(file, offset=25, limit=35)` directly to fetch just that method instead of reading the whole 200-line file.

**Implementation sketch.**

Add a new helper `outlineFile(absPath): string` using `tree-sitter-typescript`/`tree-sitter-javascript` (or `tree-sitter-language-pack`-style auto-detection):
```typescript
// src/core/agent/outline.ts
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";

export function outlineFile(content: string, lang: "javascript" | "typescript" | ...): string {
  const parser = new Parser();
  parser.setLanguage(JavaScript);
  const tree = parser.parse(content);
  const out: string[] = [];
  function walk(node: Parser.SyntaxNode) {
    if (["function_declaration", "method_definition", "class_declaration", "arrow_function"].includes(node.type)) {
      const name = node.childForFieldName("name")?.text ?? "<anon>";
      out.push(`Line ${node.startPosition.row + 1}: ${node.type} ${name}`);
    }
    for (const child of node.children) walk(child);
  }
  walk(tree.rootNode);
  return out.join("\n");
}
```

Wire into `system-prompt.ts`:
```typescript
export function formatFindingMessage(finding: Finding, outline: string): string {
  return [
    `## Finding\n...`,
    outline ? `## File Outline\n${outline}` : "",
    `The finding is at ${finding.path}:${finding.start.line}.`,
  ].filter(Boolean).join("\n\n");
}
```

Generate `outline` synchronously in `triage()` before `runAgentLoop` is called. **No new agent tool needed** — just inject into the user message.

**Cost.** New tree-sitter dependency (~5MB), one new helper file (~50 LOC), wiring (~15 LOC). One-time per finding (ms). **Expected savings.** 30-50% on findings in files >150 lines. The NodeGoat worst-case finding (200+ line files, 17 tool calls) likely drops to 5-7 calls.

**Tradeoff vs MCP option (#6 below):** This works for any target codebase out-of-the-box. The MCP option is more powerful but requires the graph to be built for each target repo first.

---

### 5. Anthropic prompt caching *(highest gross savings, but provider-gated)*

**Mechanism.** When `provider === "anthropic"`, attach `cache_control: { type: "ephemeral" }` to the system block (cached across all N parallel findings) and to recent tool-result messages (cached within a single loop's later steps).

**Why it works.** Anthropic charges 10% of base price for cache reads, 25% premium for cache writes. The system prompt (~1500 tokens) + tool definitions (~300 tokens) are byte-identical across N findings → first finding pays full price + 25%, every subsequent finding pays 10% on the cached prefix. For a 34-finding batch that's ~50K input tokens cached × 90% rebate ≈ 45K free tokens.

Inside one loop, marking the latest tool-result message with `cache_control` lets later steps re-use earlier file contents at 10% price.

**Why it doesn't help the current setup.** The user runs FPT GLM-5.1, which uses Chat Completions, not Anthropic Messages. The AI SDK silently strips `providerOptions.anthropic.cacheControl` for any non-Anthropic provider. **No-op on FPT/OpenRouter/OpenAI.** Land this only behind a `provider === "anthropic"` guard for when users switch to native Anthropic.

**Implementation sketch.** Pass the system as a `messages[]` block instead of the `system:` parameter so `providerOptions` can be attached:
```typescript
const messages: ModelMessage[] = [
  { role: "system", content: systemPrompt,
    providerOptions: provider === "anthropic"
      ? { anthropic: { cacheControl: { type: "ephemeral" } } } : undefined },
  { role: "user", content: userMessage },
];
```

For tool-result caching inside the loop, use `prepareStep` to retroactively stamp `cacheControl` on the last 3 tool-result messages each step (see research note for the `applyCacheMarkers` helper). The retry path in `loop.ts:302+` must be updated identically or the retry skips cache.

**Cost.** ~50 LOC, all gated. **Expected savings.** 60-90% on input-token cost when active. Zero when not on Anthropic.

**Major caveats.**
- Hard limit: 4 cache breakpoints per request. Don't add a fifth.
- 5-minute TTL refreshed on every hit. A 6-minute investigation loses cache mid-loop.
- `memoryHints` MUST move to the user message (varies per finding) — keeping them in the system prompt fragments the cache.

---

### 6. Graph-guided agent tools (`code-review-graph` MCP) *(highest leverage when applicable)*

**Mechanism.** Wire the existing `code-review-graph` MCP primitives as agent tools:
- `query_graph(pattern: callers_of|callees_of|imports_of|file_summary, target)` returns `NodeInfo[]` with `line_start` / `line_end`
- `semantic_search_nodes(query)` returns top-K matching symbols with file + line range

The agent then calls `read(file, offset=line_start, limit=line_end-line_start+1)` to fetch exactly the relevant function body. Replaces the current pattern of `grep` → read whole file.

**Why it works.** Replaces shotgun discovery with structured navigation. For findings that need data-flow tracing (open redirect, eval source, NoSQL injection), `callers_of(taintFunctionName)` directly answers the relevant question.

**Why it's gated.** The MCP is currently configured for the `bot` repo itself (per `CLAUDE.md`). To use it on an arbitrary target codebase (NodeGoat, customer code) we'd need to build+cache the graph per target before triage starts. That's a separate piece of infrastructure (`build_or_update_graph_tool` already exists, but it costs minutes for non-trivial repos and needs cache management).

**Cost.** ~80 LOC for two tool wrappers + MCP client integration + per-target graph caching. **Expected savings.** 40-70% on shotgun-prone findings. **Verdict:** schedule after #1-#4 are landed. Only worth it if the team commits to running graphs against every target repo.

---

## Recommended sequence

| Order | Technique | Effort | Provider gate? | Compound savings |
|---|---|---|---|---|
| 1 | Read registry + hash dedup (#1) | S | none | 5-15% |
| 2 | Path existence gate (#2) | XS | none | +10-20% |
| 3 | System-prompt reinforcement (#3) | XS | none | +5-10% |
| 4 | Structural primer (file outline) (#4) | M | none | +20-40% |
| 5 | Anthropic cache markers (#5) | M | yes (anthropic only) | +60% (when active) |
| 6 | Graph-guided tools via MCP (#6) | L | needs target graph | +30-50% (when graph available) |

**Cumulative target after #1-#4:** 30-50% reduction in tokens-per-finding on FPT/GLM-5.1, and significantly fewer wasted tool-call round trips.

**Cumulative target after #5 lands and the user moves to native Anthropic:** 70-85% reduction.

---

## Validation

For each landed technique, capture a before/after measurement on the same OWASP NodeGoat findings.json. Compare:
- Total `input_tokens` summed across `findings-out.json`
- Total tool-call count
- Wall-clock for fresh audits (with `--concurrency 1` to isolate from the concurrency cap bug — see `2026-04-29-triage-perf-and-tool-use.md`)

A regression test in `tests/core/agent/` that records a deterministic tool-call sequence on a fixture finding would catch behavior drift across these changes.

---

## What we deliberately did NOT recommend

- **LSP integration** (research note §2). High value for data-flow but high harness cost (spawning `typescript-language-server` and speaking JSON-RPC). The graph MCP gives 80% of the benefit at 20% of the cost.
- **Vector RAG / embeddings.** Query signal in SAST triage is too short ("eval-detected on line 32") to make embeddings the primary retrieval. Useful as a supplement but not first-order.
- **OpenHands-style observation truncation** (`MAX_RESPONSE_LEN_CHAR`). The current 50KB byte cap in `read.ts` already does this. Adequate as-is.
- **Conversation condenser** (OpenHands `ConversationWindowCondenser`). Reasonable for 50+ step loops but our `maxSteps` is single-digit.
