# Read-Efficiency Implementation Spec

> **Type:** Design spec (interfaces, package wiring, CI integration). Not a step-by-step plan — that follows once design is approved.
>
> **Sibling docs:** `2026-04-29-triage-perf-and-tool-use.md` (the investigation that motivated this), `2026-04-29-read-efficiency-techniques.md` (the technique catalog this spec selects from).

## Scope

Land four runtime fixes to the agent loop. Each is independently shippable. Ordered by leverage and risk:

1. **Read registry + content-hash dedup** — kill same-file-twice in one finding.
2. **Path existence gate with glob suggestion** — kill shotgun reads on guessed paths.
3. **System-prompt reinforcement** — soft pressure to back the harness rules.
4. **`code-review-graph` MCP integration** — two new agent tools (`query_graph`, `semantic_search_nodes`) backed by a Tree-sitter knowledge graph of the **target repo** (not this `bot` repo).

Out of scope here: Anthropic prompt caching (provider-gated, separate spec when the user moves to native Anthropic), LSP integration, vector RAG.

## Goals

- Reduce per-finding wall clock and input tokens on FPT GLM-5.1 (the user's primary provider) by **30-50%** on findings in files >150 lines.
- Eliminate the three failure modes catalogued in `2026-04-29-triage-perf-and-tool-use.md` §2: same-path-twice, shotgun reads, full-file reads when 5 lines suffice.
- Stay provider-agnostic — none of these depend on Anthropic-specific features.

## Non-goals

- Don't build our own knowledge graph — `code-review-graph` already exists, runs on PyPI, has 23-language tree-sitter coverage and an MCP server. Wrap, don't reinvent.
- Don't change the verdict tool, the orchestrator's concurrency model (separate bug, separate spec), or the memory store.
- Don't break the bun-compiled binary's portability — graph integration must be optional / runtime-detected.

---

## Architecture

```
                                  ┌──────────────────────────────────────┐
                                  │  code-review-graph (Python 3.10+)    │
                                  │  PyPI: code-review-graph             │
                                  │                                       │
                                  │  CLI:  code-review-graph build       │
                                  │        code-review-graph update      │
                                  │        code-review-graph serve  ─────┼─── stdio MCP server
                                  │                                       │
                                  │  Stores: <target>/.code-review-graph/│
                                  │          graph.sqlite                │
                                  └──────────────┬───────────────────────┘
                                                 │ JSON-RPC over stdio
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  src/core/agent/loop.ts (Node/Bun runtime)                              │
│                                                                         │
│  createTools({                                                          │
│    projectRoot,                                                         │
│    allowBash,                                                           │
│    readRegistry,        ◄── new: Map<absPath, ReadEntry>                │
│    getStep,             ◄── new: () => stepNumber from prepareStep      │
│    graphClient,         ◄── new: optional MCPClient or null             │
│  })                                                                     │
│                                                                         │
│  Tools registered when graphClient is non-null:                         │
│    - read   (existing, now with dedup + path gate)                      │
│    - grep, glob, bash (existing, unchanged)                             │
│    - verdict (existing, unchanged)                                      │
│    - queryGraph         ◄── NEW: callers_of/callees_of/file_summary/... │
│    - searchSymbol       ◄── NEW: semantic_search_nodes_tool             │
└─────────────────────────────────────────────────────────────────────────┘
```

Fallback path: when `code-review-graph` is not installed or the graph hasn't been built for the target, `graphClient` is `null` → `queryGraph` and `searchSymbol` are not registered → agent falls back to existing read/grep/glob behavior. **No hard dependency.**

---

## Component 1 — Read Registry + Content-Hash Dedup

### Files

- **Modify:** `src/core/agent/tools/read.ts` (~60 LOC added)
- **Modify:** `src/core/agent/tools/index.ts` (thread `readRegistry` + `getStep` through `createTools`)
- **Modify:** `src/core/agent/loop.ts` (instantiate registry per loop, update `getStep` from `prepareStep`)
- **Add:** `tests/core/agent/tools/read-dedup.test.ts`

### Interface

```typescript
// src/core/agent/tools/read.ts
export interface ReadEntry {
  hash: string;        // first 12 hex chars of SHA-256(buffer)
  step: number;        // step at which it was first served
  mtimeMs: number;     // file mtime at read time
  totalLines: number;  // total file lines (for stub message)
}

export type ReadRegistry = Map<string, ReadEntry>;

export interface CreateReadToolOptions {
  projectRoot: string;
  registry?: ReadRegistry;
  getStep?: () => number;
}

export function createReadTool(opts: CreateReadToolOptions): Tool<ReadInput, string>;
```

### Behavior

On every `read`:

1. Resolve `path` relative to `projectRoot` → `abs`.
2. `statSync(abs)` to get `mtimeMs` and existence. (See Component 2 for the path-gate path.)
3. Read bytes, compute `hash = sha256(buffer).slice(0,12)`.
4. **Dedup check:**
   - If `registry.has(abs)`:
     - If `entry.hash === hash` AND `entry.mtimeMs === mtimeMs`: serve a stub with the original step number; do NOT re-emit content.
     - If hash or mtime changed: serve fresh content + note that it changed (`[File modified since step K — re-reading]`). Update entry.
   - Else: serve fresh content. Insert entry.
5. Stub message format (must be informative enough that the model doesn't retry the same call):

```
[File app/server.js was already read at step 3 (148 lines, hash a1b2c3d4e5f6, content unchanged).
 If you need a different range, call read with offset+limit. Otherwise refer to your earlier output.]
```

### Skip dedup when

- `offset` or `limit` differ from a prior call on the same file (different range = new request).
- File size is < 200 bytes (overhead not worth it; tiny files are cheap).
- The 50 KB byte cap was hit on the prior read — model may legitimately want to re-attempt with offset.

### Test cases

```typescript
// tests/core/agent/tools/read-dedup.test.ts
it("returns stub on second read of same file, same content", ...)
it("returns fresh content when mtime changes between reads", ...)
it("returns fresh content when content changes (rare race) but mtime equal", ...)  // hash safety net
it("does NOT dedup when offset/limit differ between calls", ...)
it("does NOT dedup files under 200 bytes", ...)
it("registry survives across same loop, fresh per loop", ...)  // factory test
```

### Wiring in `loop.ts`

```typescript
// In runAgentLoop:
const readRegistry: ReadRegistry = new Map();
let stepNumber = 0;
const getStep = () => stepNumber;

const tools = createTools({
  projectRoot,
  allowBash,
  readRegistry,
  getStep,
});

// In streamText.prepareStep callback:
async prepareStep({ stepNumber: sn }) {
  stepNumber = sn;
  // ... existing prepareStep logic
}
```

The registry is allocated per `runAgentLoop` invocation → naturally per-finding scope.

---

## Component 2 — Path Existence Gate with Glob Suggestion

### Files

- **Modify:** `src/core/agent/tools/read.ts` (existence check + glob fallback in error path, ~15 LOC)
- **Add:** `tests/core/agent/tools/read-path-gate.test.ts`

### Behavior

Before reading, `existsSync(abs)`. If false:

1. Extract basename = last `/`-separated segment of input path.
2. Run `globSync('**/${basename}', { cwd: projectRoot, ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**'] })`.
3. Return up to 5 matches sorted by path length (shortest first → most likely the right one).
4. Throw error with format:

```
File not found: app/server.js — did you mean: server.js, src/server.js?
```

Empty match list → existing message preserved (no `did you mean` suffix).

### Test cases

```typescript
it("throws plain not-found when no glob matches", ...)
it("appends suggestions when basename exists at other paths", ...)
it("ignores node_modules / .git / dist when suggesting", ...)
it("returns at most 5 suggestions sorted by path length", ...)
```

### Library

Already a dep (used in `glob` tool). No new package.

---

## Component 3 — System-Prompt Reinforcement

### Files

- **Modify:** `src/core/agent/system-prompt.ts` (~5 lines added to `SYSTEM_PROMPT`)

### Content

Add a `## Investigation discipline` block, positioned after the tool list and before the verdict instructions:

```markdown
## Investigation discipline

- Use `offset` + `limit` on `read` whenever the file is longer than 100 lines. The footer shows total line count — use it.
- If you are not certain a path exists, run `glob('**/<basename>')` once before `read`. The harness will reject duplicate or nonexistent reads with structured hints.
- Do not call `read` on the same path twice in one investigation. The harness deduplicates and returns a stub. To see a different range, pass new `offset` / `limit`.
- When `query_graph` and `search_symbol` are available (target repo has a code graph), prefer them over `grep` for "find callers / callees / definitions" — they return exact line ranges so a single targeted `read` finishes the job.
```

The fourth bullet is conditional — included only when graph tools are wired in (Component 4). Easiest implementation: append at runtime in `formatFindingMessage` based on whether the graph client is non-null.

### Why prompt-only

The harness already enforces (#1) dedup and (#2) path-gate. The prompt explains *why* the model is seeing those stubs/errors so it can adapt rather than retry blindly.

---

## Component 4 — `code-review-graph` MCP Integration

This is the largest component. It splits into:

- **4a. Package wiring** — install + invocation (CI + dev + runtime).
- **4b. MCP client** — JSON-RPC over stdio inside `bot`.
- **4c. New agent tools** — `queryGraph` and `searchSymbol`.
- **4d. Lifecycle** — when to build the graph, when to update it, where to cache it.

### 4a. Package wiring

`code-review-graph` is published on PyPI ([`code-review-graph`](https://pypi.org/project/code-review-graph/)) as a Python 3.10+ package with a console script and an MCP server entry point. Install methods, ranked by stability for our purposes:

| Method | Stability | Where it fits |
|---|---|---|
| **`pipx install code-review-graph`** | High — isolated venv, single binary on PATH, no system pollution | **CI** (recommended) and dev |
| `pip install code-review-graph` (in venv) | High — standard but requires explicit venv mgmt | Acceptable; needs venv setup steps |
| `uvx code-review-graph` | High — ephemeral, no install step, hermetic | Excellent for CI; the package's own README recommends it |
| `pip install code-review-graph` (system-wide) | Medium — fragile across Python upgrades, conflicts on shared runners | **Avoid** |
| Docker sidecar | Medium — adds container orchestration complexity | Reserve for runtime if/when we ship a "with-graph" image |

**Decision for CI:** use `pipx install code-review-graph`. Stable, isolated, single binary on PATH. Drop-in for any subsequent `code-review-graph build` or `code-review-graph serve` call.

**Decision for local dev:** README's `pipx` or `uv` path; either works. Document both in `CLAUDE.md`.

**Decision for runtime (Docker image):** **defer**. The current `Dockerfile` runtime stage is `gcr.io/distroless/cc-debian12:nonroot` — no Python. Adding Python to the runtime would bloat the 47 MB image to ~200+ MB. Two options for later:

- **(A)** ship a second tag `ghcr.io/get-wright/sast-triage:graph` based on `python:3.12-slim` with `pipx`, retaining the lean `:latest` for graph-less runs.
- **(B)** make the binary detect a `code-review-graph` binary on PATH and skip graph integration if absent — same image, optional feature.

(A) is cleaner; (B) is more flexible. Pick at runtime-integration time, not now.

### CI workflow change

Add to `.github/workflows/headless-docker.yml` immediately before the typecheck step:

```yaml
      - name: Install code-review-graph (for graph-tool tests)
        run: pipx install code-review-graph

      - name: Verify code-review-graph CLI
        run: code-review-graph --version
```

CI tests then have access to `code-review-graph build` against the test fixtures and to spawn the MCP server. See test plan below.

### 4b. MCP client (Node/Bun side)

The MCP server speaks **JSON-RPC 2.0 over stdio**. Two viable client implementations:

- **`@modelcontextprotocol/sdk`** — official TypeScript SDK. Adds ~50 KB. Already used in this ecosystem; well-tested. **Recommended.**
- Hand-rolled JSON-RPC framer over a child process. Avoids dep but ~150 LOC and has to handle line-delimited framing, request IDs, error mapping. **Not recommended.**

Files:

- **Add:** `src/infra/graph/mcp-client.ts` — thin wrapper over the SDK that exposes `queryGraph(args)`, `searchSymbol(args)`, `close()`.
- **Add:** `src/infra/graph/index.ts` — discovery: `findGraphBinary()` (search PATH for `code-review-graph`), `ensureGraphBuilt(repoRoot)` (idempotent — runs `code-review-graph build` only if `.code-review-graph/graph.sqlite` is missing or older than 24h).
- **Add:** `src/infra/graph/types.ts` — Zod schemas for tool inputs/outputs (mirror what `code-review-graph` returns).

Interface:

```typescript
// src/infra/graph/mcp-client.ts
export interface GraphClient {
  queryGraph(args: QueryGraphArgs): Promise<NodeInfo[]>;
  searchSymbol(args: { query: string; topK?: number }): Promise<NodeInfo[]>;
  close(): Promise<void>;
}

export interface QueryGraphArgs {
  pattern: "callers_of" | "callees_of" | "imports_of"
         | "importers_of" | "children_of" | "tests_for" | "file_summary";
  target: string;  // function name, qualified name, or file path
}

export interface NodeInfo {
  name: string;
  qualified_name: string;
  kind: "function" | "class" | "method" | "file" | string;
  file_path: string;
  line_start: number;
  line_end: number;
  params?: string;
  return_type?: string;
}

export async function createGraphClient(repoRoot: string): Promise<GraphClient | null>;
// Returns null if code-review-graph binary not on PATH (graceful degradation).
```

Lifecycle:

1. `runAgentLoop` (or the orchestrator at startup) calls `createGraphClient(projectRoot)`.
2. If null → register agent tools without `queryGraph`/`searchSymbol` (existing behavior).
3. If non-null → register both new tools; pass through to MCP via `client.callTool`.
4. After all findings done, call `graphClient.close()` to terminate the subprocess.

### 4c. New agent tools

Files:

- **Add:** `src/core/agent/tools/query-graph.ts`
- **Add:** `src/core/agent/tools/search-symbol.ts`
- **Modify:** `src/core/agent/tools/index.ts` (register new tools when `graphClient` provided)

Schemas (Zod, matching AI SDK v5 `inputSchema` convention):

```typescript
// query-graph.ts
import { tool } from "ai";
import { z } from "zod";

export function createQueryGraphTool(graphClient: GraphClient) {
  return tool({
    description:
      "Query the code knowledge graph for relationships. Returns NodeInfo[] " +
      "with file_path, line_start, line_end, params. Use this BEFORE grep when " +
      "you need to find callers, callees, imports, or files containing a symbol. " +
      "Then call read(file, offset=line_start, limit=line_end - line_start + 1) " +
      "to fetch only the relevant function body.",
    inputSchema: z.object({
      pattern: z.enum([
        "callers_of", "callees_of", "imports_of",
        "importers_of", "children_of", "tests_for", "file_summary",
      ]).describe("Relationship type to query."),
      target: z.string().describe(
        "Function name (e.g. 'evalUserInput'), qualified name " +
        "(e.g. 'app/routes/contributions.js::handleContributionsUpdate'), " +
        "or file path (for file_summary / children_of).",
      ),
    }),
    execute: async ({ pattern, target }) => {
      const results = await graphClient.queryGraph({ pattern, target });
      // Format compactly — model only needs name, file:line, kind:
      return results.length === 0
        ? `No ${pattern} results for "${target}". Verify symbol exists with search_symbol.`
        : results.map(n =>
            `${n.kind} ${n.qualified_name}  ${n.file_path}:${n.line_start}-${n.line_end}` +
            (n.params ? `  (${n.params})` : "")
          ).join("\n");
    },
  });
}
```

```typescript
// search-symbol.ts
export function createSearchSymbolTool(graphClient: GraphClient) {
  return tool({
    description:
      "Find functions/classes by name or keyword. Returns NodeInfo[] with " +
      "file_path and line range. Use when you have a symbol name from the " +
      "finding but don't know which file it's in. Prefer this over " +
      "grep+read for symbol lookup.",
    inputSchema: z.object({
      query: z.string().describe("Name or keyword (e.g. 'parseUser', 'eval')."),
      topK: z.number().int().min(1).max(20).optional().default(5),
    }),
    execute: async ({ query, topK }) => {
      const results = await graphClient.searchSymbol({ query, topK });
      return results.length === 0
        ? `No symbols matching "${query}". Try grep on the source.`
        : results.map(n =>
            `${n.kind} ${n.qualified_name}  ${n.file_path}:${n.line_start}-${n.line_end}`
          ).join("\n");
    },
  });
}
```

Output format: **one line per result, file:line range explicit**, suitable for the model to immediately feed into `read(file, offset=line_start, limit=…)`. No JSON dumps — too verbose.

### 4d. Lifecycle: when to build / update the graph

Three checkpoints:

1. **Pre-batch (orchestrator startup):** if `graphClient` is non-null and `.code-review-graph/graph.sqlite` is missing OR older than 24 hours OR target repo has uncommitted changes, run `code-review-graph build`. Idempotent. Synchronous. Adds ~10s for a 500-file project (per upstream benchmarks). Skipped on graph hits.

   **Implementation:** new helper `ensureGraphBuilt(repoRoot)` in `src/infra/graph/index.ts`. Called once from `triageOrchestrator.run` before `triageBatch`.

2. **Mid-batch:** no rebuilds. The graph is already built; subsequent `query_graph` calls hit the cached SQLite directly.

3. **Tear-down:** `graphClient.close()` after batch — terminates the MCP subprocess and releases the SQLite handle.

Cache storage: the upstream `code-review-graph` already writes to `.code-review-graph/graph.sqlite` inside the target repo. Add this path to `.dockerignore` (image stays lean) and `.gitignore` (target repos shouldn't accidentally commit graphs). For the bot repo's own gitignore: already covers `.sast-triage/` runtime dir; add a similar `.code-review-graph/` line if running graphs against this repo locally.

### Failure modes

- **Graph build fails** (e.g. unsupported language mix): log `graph_build_failed` event, set `graphClient = null`, fall back to graph-less behavior. **Never block triage on graph errors.**
- **MCP subprocess dies mid-loop:** mark client as dead in subsequent `queryGraph` / `searchSymbol` calls; tool returns `Graph subprocess unavailable; use grep/read.` Agent loop continues.
- **MCP responds with non-JSON / invalid:** Zod validation in client surfaces as error to agent; tool result is a structured error message.

These are not edge cases — they are the design contract: **graph integration is best-effort and never blocks the loop.**

---

## CI / packaging

Net changes to repo infrastructure:

| File | Change |
|---|---|
| `.github/workflows/headless-docker.yml` | Add `pipx install code-review-graph` step before typecheck; add CLI verify step |
| `package.json` | Add `@modelcontextprotocol/sdk` to dependencies |
| `.gitignore` | Add `.code-review-graph/` |
| `.dockerignore` | Add `.code-review-graph/` (don't ship target-repo graphs into image builds) |
| `Dockerfile` (runtime stage) | **No change in this spec.** Runtime graph integration deferred (see §4a). |
| `CLAUDE.md` | Append a "Code-graph integration (optional)" subsection under "Conventions" with install + usage one-liners |

The runtime image therefore stays at ~47 MB and graph integration is purely a CI/dev convenience until a follow-up spec ships the `:graph` tag.

---

## Test plan

### Unit tests (vitest, no network, no MCP subprocess)

- `tests/core/agent/tools/read-dedup.test.ts` — registry behavior (6 cases, see §1).
- `tests/core/agent/tools/read-path-gate.test.ts` — glob suggestion behavior (4 cases, see §2).
- `tests/infra/graph/mcp-client.test.ts` — mock the MCP client at the JSON-RPC level; verify `queryGraph` and `searchSymbol` shape requests correctly and parse responses.
- `tests/core/agent/tools/query-graph.test.ts` — tool returns formatted strings given mock `GraphClient`; null-client path skips registration.

### Integration test (CI only, real MCP)

- `tests/integration-graph.test.ts` (gated on `code-review-graph` binary present):
  - Build graph against `tests/fixtures/sample-repo/` (a small Node.js fixture committed to the repo, ~5 files).
  - Start MCP, call `searchSymbol("evalUserInput")`, expect a non-empty result.
  - Call `queryGraph({ pattern: "callers_of", target: "evalUserInput" })`, expect callers.
  - Tear down. Assert subprocess exited cleanly.

### Regression test

- `tests/core/agent/tools/read-no-regression.test.ts` — feed a captured tool-call sequence from the NodeGoat run (`/tmp/sast-test/nodegoat/findings-out.json`) to a synthetic agent harness; verify total tool-call count drops by >= 25% with #1+#2 enabled (not measuring tokens here, just call count).

---

## Validation

After landing, re-run NodeGoat triage with the same params (`fpt`, `GLM-5.1`, `--effort medium`, `--concurrency 20` *— pending the concurrency bug fix from the sibling spec*). Capture:

- Total `input_tokens` summed across `findings-out.json` (compare to baseline 540K from the 2026-04-29 run).
- Total tool-call count (compare to 197 baseline).
- Wall-clock for fresh audits.
- Number of times `queryGraph` / `searchSymbol` were called vs `grep` (signal that the agent learned to prefer them).

Target: 30-50% reduction in tokens, 30-50% reduction in tool calls, comparable verdict accuracy (no more inconsistent labeling than the baseline's 2 cases).

---

## Risks and tradeoffs

| Risk | Mitigation |
|---|---|
| `code-review-graph` releases a breaking version | Pin minor version in CI (`pipx install 'code-review-graph>=X.Y,<X.(Y+1)'`); MCP wire format is stable per upstream's roadmap but still pin |
| MCP subprocess leaks on unexpected agent-loop exit | `graphClient.close()` in `try/finally` around the batch; SIGTERM the child if it doesn't exit in 5s |
| Graph build adds ~10s startup latency for users who only triage 1 finding | `ensureGraphBuilt` is opt-in via env var initially (`SAST_USE_GRAPH=1`); enable by default once graph build is reliably <5s on typical repos |
| Read registry false-positives (different content, same hash, same mtime) | Hash collision at 12 hex chars (~48 bits) for short-lived loops is negligible; if paranoid, bump to 16 chars |
| Path-gate suggestions wrong on monorepos with many same-named files | Cap at 5 sorted by path length; model can ignore obvious mismatches |
| AI SDK v5 tool registration order changes the model's preference | None — the SDK passes tools as a flat object; ordering doesn't affect the model's choice. Validated by reading `src/core/agent/tools/index.ts`. |

## Out of scope (explicitly)

- **Anthropic prompt caching.** Provider-gated; FPT silently strips. Separate spec when the user moves to native Anthropic. Reference: `2026-04-29-read-efficiency-techniques.md` §5.
- **Tree-sitter direct integration in `bot`.** Would duplicate what `code-review-graph` already does. If we ever drop the MCP we revisit this; for now, lean on the published package.
- **Concurrency cap fix.** Tracked in `2026-04-29-triage-perf-and-tool-use.md` §1; needs its own one-line patch + warning. Independent of this spec.
- **Runtime Docker integration of the graph.** §4a explicitly defers. Land CI + dev integration first, prove value, then ship `:graph` tag.

---

## Open questions

1. **Graph rebuild cadence.** 24h staleness threshold is a guess. For active development the user may want it tighter (e.g. invalidate on git HEAD change). Cheap to implement either way once we see real usage.
2. **MCP transport — stdio vs HTTP.** `code-review-graph serve` defaults to stdio. If we ever want to share a single graph server across multiple `bot` invocations, HTTP would be better. Stdio is simpler for v1.
3. **Per-finding vs per-batch graph client.** Spec assumes per-batch (single client serves all N parallel agent loops). If contention emerges (e.g. SQLite locking), switch to per-finding clients with reuse via a pool. Probably premature.
4. **Should the graph tools be exposed when `--allow-bash` is off?** Yes by default — they're read-only queries. But documenting the decision keeps it intentional.

---

## Follow-up plan

If this spec is approved, the implementation plan would be:

- **Phase 1** (~2 hours, no new deps): Land #1 (read registry), #2 (path gate), #3 (system prompt) — three small commits, each with tests.
- **Phase 2** (~4 hours, adds `@modelcontextprotocol/sdk` + `pipx` step in CI): Land #4 (MCP integration) behind `SAST_USE_GRAPH=1` env gate. Tests stub the MCP. CI verifies the `code-review-graph` binary works.
- **Phase 3** (after Phase 2 is green for one week): Flip `SAST_USE_GRAPH=1` to default. Validate against NodeGoat. Capture before/after numbers.
- **Phase 4** (separate spec): runtime Docker integration — `:graph` tag on a Python-base runtime, or PATH-detect with optional skip.

A detailed step-by-step plan in the `superpowers:writing-plans` format can follow once this spec is approved — it would split each phase into atomic commits with TDD ordering.
