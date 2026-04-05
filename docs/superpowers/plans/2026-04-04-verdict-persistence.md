# Verdict Persistence & Unified Finding State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist full verdicts (evidence + fix) and load them back into the Active view on startup, so audited findings stay visible as completed work instead of being filtered out.

**Architecture:** Extend SQLite schema with `key_evidence` (JSON) and `suggested_fix` columns via idempotent migration. Remove cache-based filtering from prefilter (cached verdicts are completed work, not noise). On TUI startup, look up every finding by fingerprint and pre-populate `FindingState.verdict` if cached. Extend multi-select (Space/a/Enter) to work across all three views for batch promote/restore.

**Tech Stack:** TypeScript, AI SDK v5, Ink 6 TUI, SQLite (bun:sqlite / better-sqlite3), Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-04-verdict-persistence-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/memory/store.ts` | SQLite schema + migration, store/lookup full verdict, new `lookupVerdict()` method |
| `src/parser/prefilter.ts` | Noise filtering only (test/generated/INFO) — no memory dependency |
| `src/ui/app.tsx` | Load cached verdicts into FindingState on startup; extend multi-select handlers |
| `src/index.ts` | Remove `memoryLookup` from headless prefilter call; emit cached verdicts as NDJSON |
| `tests/memory/store.test.ts` | Round-trip full verdict, migration idempotency |
| `tests/parser/prefilter.test.ts` | Remove cache-based test, verify no memory dependency |

---

## Task 1: Extend memory schema with full verdict fields

**Files:**
- Modify: `src/memory/store.ts`
- Test: `tests/memory/store.test.ts`

- [ ] **Step 1: Write failing test for round-tripping full verdict**

Add this test to `tests/memory/store.test.ts` after the existing "upserts on duplicate fingerprint" test:

```typescript
it("stores and retrieves full verdict with evidence and fix", () => {
  store.store({
    fingerprint: "fp-full",
    check_id: "test.rule",
    path: "src/app.py",
    verdict: "true_positive",
    reasoning: "SQL injection",
    key_evidence: ["Line 10: raw query", "No ORM usage"],
    suggested_fix: "Use parameterized queries",
  });
  const verdict = store.lookupVerdict("fp-full");
  expect(verdict).not.toBeNull();
  expect(verdict!.verdict).toBe("true_positive");
  expect(verdict!.reasoning).toBe("SQL injection");
  expect(verdict!.key_evidence).toEqual(["Line 10: raw query", "No ORM usage"]);
  expect(verdict!.suggested_fix).toBe("Use parameterized queries");
});

it("lookupVerdict returns null for unknown fingerprint", () => {
  expect(store.lookupVerdict("does-not-exist")).toBeNull();
});

it("lookupVerdict handles missing optional fields", () => {
  store.store({
    fingerprint: "fp-min",
    check_id: "test.rule",
    path: "src/app.py",
    verdict: "needs_review",
    reasoning: "unclear",
    key_evidence: [],
  });
  const verdict = store.lookupVerdict("fp-min");
  expect(verdict!.key_evidence).toEqual([]);
  expect(verdict!.suggested_fix).toBeUndefined();
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /Users/n3m0/Code/bot/sast-triage-ts
npx vitest run tests/memory/store.test.ts
```

Expected: 3 new tests fail with `store.lookupVerdict is not a function` and `TS2353: Object literal may only specify known properties` (TypeScript error on `key_evidence`).

- [ ] **Step 3: Update `StoreInput` and `TriageRecord` interfaces**

In `src/memory/store.ts`, update both interfaces to include the new fields:

```typescript
export interface TriageRecord {
  fingerprint: string;
  check_id: string;
  path: string;
  verdict: string;
  reasoning: string;
  key_evidence: string[];
  suggested_fix?: string;
  created_at?: string;
  updated_at?: string;
}

export interface StoreInput {
  fingerprint: string;
  check_id: string;
  path: string;
  verdict: string;
  reasoning: string;
  key_evidence: string[];
  suggested_fix?: string;
}
```

- [ ] **Step 4: Update schema creation and add migration**

Replace the `createTables()` method in `src/memory/store.ts`:

```typescript
private createTables(): void {
  this.db.run(`
    CREATE TABLE IF NOT EXISTS triage_records (
      fingerprint TEXT PRIMARY KEY,
      check_id TEXT NOT NULL,
      path TEXT NOT NULL,
      verdict TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      key_evidence TEXT NOT NULL DEFAULT '[]',
      suggested_fix TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  // Migration: add columns to existing databases (idempotent)
  const cols = this.db.all("PRAGMA table_info(triage_records)") as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("key_evidence")) {
    this.db.run("ALTER TABLE triage_records ADD COLUMN key_evidence TEXT NOT NULL DEFAULT '[]'");
  }
  if (!names.has("suggested_fix")) {
    this.db.run("ALTER TABLE triage_records ADD COLUMN suggested_fix TEXT");
  }
}
```

- [ ] **Step 5: Update `store()` to write new fields**

Replace the `store()` method:

```typescript
store(input: StoreInput): void {
  const now = new Date().toISOString();
  const evidenceJson = JSON.stringify(input.key_evidence);
  this.db.run(
    `INSERT INTO triage_records (fingerprint, check_id, path, verdict, reasoning, key_evidence, suggested_fix, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET
       verdict = excluded.verdict,
       reasoning = excluded.reasoning,
       key_evidence = excluded.key_evidence,
       suggested_fix = excluded.suggested_fix,
       updated_at = excluded.updated_at`,
    input.fingerprint, input.check_id, input.path, input.verdict, input.reasoning,
    evidenceJson, input.suggested_fix ?? null, now, now,
  );
}
```

- [ ] **Step 6: Add `lookupVerdict()` method**

Add this method to the `MemoryStore` class in `src/memory/store.ts` after `lookup()`:

```typescript
/** Returns the full verdict reconstructed from the record, or null if not found. */
lookupVerdict(fingerprint: string): import("../models/verdict.js").TriageVerdict | null {
  const row = this.db.get(
    "SELECT verdict, reasoning, key_evidence, suggested_fix FROM triage_records WHERE fingerprint = ?",
    fingerprint,
  ) as { verdict: string; reasoning: string; key_evidence: string; suggested_fix: string | null } | undefined;
  if (!row) return null;
  let evidence: string[] = [];
  try {
    const parsed = JSON.parse(row.key_evidence);
    if (Array.isArray(parsed)) evidence = parsed.map(String);
  } catch { /* corrupted JSON — return empty */ }
  return {
    verdict: row.verdict as "true_positive" | "false_positive" | "needs_review",
    reasoning: row.reasoning,
    key_evidence: evidence,
    suggested_fix: row.suggested_fix ?? undefined,
  };
}
```

- [ ] **Step 7: Run tests — verify they pass**

```bash
npx vitest run tests/memory/store.test.ts
```

Expected: all tests pass (old 7 + new 3 = 10 tests).

- [ ] **Step 8: Commit**

```bash
git add src/memory/store.ts tests/memory/store.test.ts
git commit -m "$(cat <<'EOF'
feat(memory): persist full verdict with evidence and fix

Extend TriageRecord schema with key_evidence (JSON) and suggested_fix.
Idempotent ALTER TABLE migration for existing DBs. Add lookupVerdict()
method that returns the reconstructed TriageVerdict.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Update all call sites that store verdicts

**Files:**
- Modify: `src/ui/app.tsx:150-156` (triageIndex)
- Modify: `src/index.ts:143-149` (headless loop)

- [ ] **Step 1: Update `memory.store()` call in app.tsx**

In `src/ui/app.tsx`, find the `memory.store()` call inside `triageIndex` (around line 150) and update it to include the new fields:

```typescript
memory.store({
  fingerprint: fp,
  check_id: state.finding.check_id,
  path: state.finding.path,
  verdict: verdict.verdict,
  reasoning: verdict.reasoning,
  key_evidence: verdict.key_evidence,
  suggested_fix: verdict.suggested_fix,
});
```

- [ ] **Step 2: Update `memory.store()` call in index.ts**

In `src/index.ts`, find the `memory.store()` call inside `runHeadless()` (around line 143) and update identically:

```typescript
memory.store({
  fingerprint: fp,
  check_id: finding.check_id,
  path: finding.path,
  verdict: verdict.verdict,
  reasoning: verdict.reasoning,
  key_evidence: verdict.key_evidence,
  suggested_fix: verdict.suggested_fix,
});
```

- [ ] **Step 3: Verify type check passes**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/ui/app.tsx src/index.ts
git commit -m "$(cat <<'EOF'
feat: persist key_evidence and suggested_fix at every verdict store call

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Remove cache-based filtering from prefilter

**Files:**
- Modify: `src/parser/prefilter.ts`
- Test: `tests/parser/prefilter.test.ts`

- [ ] **Step 1: Update failing test expectations**

In `tests/parser/prefilter.test.ts`, DELETE the two cache-related tests at the bottom (lines 70-81: `"filters cached verdicts when memory lookup provided"` and `"passes when memory lookup returns null"`).

- [ ] **Step 2: Run tests — verify still passing (they just disappeared)**

```bash
npx vitest run tests/parser/prefilter.test.ts
```

Expected: 6 tests pass (down from 8).

- [ ] **Step 3: Remove `memoryLookup` from `prefilterFinding` signature**

Replace the `src/parser/prefilter.ts` file contents with:

```typescript
import type { Finding } from "../models/finding.js";

export interface PrefilterResult {
  passed: boolean;
  reason?: string;
}

const TEST_DIR_PATTERNS = ["__tests__", "/tests/", "tests/", "/test/", "test/", "testing/"];
const TEST_FILE_PATTERNS = ["test_", "_test.", ".test.", ".spec.", "conftest.", "test_helper"];
const GENERATED_PATH_PATTERNS = [
  "/migrations/", "migrations/", "node_modules/", "/vendor/", "vendor/", "/dist/", "dist/", "/build/", "build/",
  ".generated.", "_pb2.py", ".min.js", "package-lock.json", "yarn.lock",
  ".pb.go", "/gen/", "gen/", "/generated/", "generated/",
];

export function prefilterFinding(finding: Finding): PrefilterResult {
  if (isTestFile(finding.path)) return { passed: false, reason: "Test file" };
  if (isGeneratedFile(finding.path)) return { passed: false, reason: "Generated/vendor file" };
  if (isInfoSeverity(finding)) return { passed: false, reason: "Informational severity" };
  return { passed: true };
}

function isTestFile(path: string): boolean {
  const lower = path.toLowerCase();
  const basename = lower.split("/").pop() ?? "";
  if (TEST_FILE_PATTERNS.some((p) => basename.includes(p))) return true;
  return TEST_DIR_PATTERNS.some((p) => lower.includes(p));
}

function isGeneratedFile(path: string): boolean {
  const lower = path.toLowerCase();
  return GENERATED_PATH_PATTERNS.some((p) => lower.includes(p));
}

function isInfoSeverity(finding: Finding): boolean {
  return finding.extra.severity.toUpperCase() === "INFO";
}
```

Note: this removes the `MemoryLookup` type export and the `fingerprintFinding` import.

- [ ] **Step 4: Run prefilter tests**

```bash
npx vitest run tests/parser/prefilter.test.ts
```

Expected: all 6 tests still pass.

- [ ] **Step 5: Verify type check fails at call sites (expected)**

```bash
npx tsc --noEmit
```

Expected: errors in `src/index.ts` and `src/ui/app.tsx` about passing too many arguments to `prefilterFinding` and importing `createLookup` / `MemoryLookup`. These get fixed in the next tasks.

- [ ] **Step 6: DO NOT commit yet** — the codebase is in a broken state; we'll commit after Task 4.

---

## Task 4: Update prefilter call sites (remove memoryLookup args)

**Files:**
- Modify: `src/index.ts:78-79, 105-117`
- Modify: `src/ui/app.tsx:597-608`

- [ ] **Step 1: Update `src/index.ts` headless prefilter call**

In `src/index.ts` find the block around line 104-117 inside `runHeadless()` and replace:

```typescript
const memory = new MemoryStore(resolve(config.memoryDb));
const memoryLookup = memory.createLookup();

const active: Finding[] = [];
for (const f of findings) {
  const result = prefilterFinding(f, memoryLookup);
  if (result.passed) {
    active.push(f);
  } else {
    const fp = fingerprintFinding(f);
    log.debug("prefilter", `Filtered ${f.check_id}: ${result.reason}`);
    console.log(JSON.stringify({ type: "filtered", fingerprint: fp, rule: f.check_id, reason: result.reason }));
  }
}
log.info("prefilter", `${active.length} active, ${findings.length - active.length} filtered`);
```

with:

```typescript
const memory = new MemoryStore(resolve(config.memoryDb));

const active: Finding[] = [];
for (const f of findings) {
  const result = prefilterFinding(f);
  if (result.passed) {
    active.push(f);
  } else {
    const fp = fingerprintFinding(f);
    log.debug("prefilter", `Filtered ${f.check_id}: ${result.reason}`);
    console.log(JSON.stringify({ type: "filtered", fingerprint: fp, rule: f.check_id, reason: result.reason }));
  }
}
log.info("prefilter", `${active.length} active, ${findings.length - active.length} filtered`);
```

- [ ] **Step 2: Update `src/index.ts` pre-load prefilter call**

In `src/index.ts` find the block around line 74-86 in the TUI entry path and replace:

```typescript
if (config.provider && config.model && config.findingsPath) {
  const raw = JSON.parse(readInput(config.findingsPath));
  const allFindings = parseSemgrepOutput(raw);
  const memoryLookup = memory.createLookup();
  const active = allFindings.filter((f) => prefilterFinding(f, memoryLookup).passed);
```

with:

```typescript
if (config.provider && config.model && config.findingsPath) {
  const raw = JSON.parse(readInput(config.findingsPath));
  const allFindings = parseSemgrepOutput(raw);
  const active = allFindings.filter((f) => prefilterFinding(f).passed);
```

- [ ] **Step 3: Update `src/ui/app.tsx` prefilter call**

In `src/ui/app.tsx` find the block around line 597-608 inside `handleSetupComplete` and replace:

```typescript
const allFindings = parseSemgrepOutput(raw);
const memoryLookup = memory.createLookup();
const active: Finding[] = [];
const filtered: { finding: Finding; reason: string }[] = [];
for (const f of allFindings) {
  const result = prefilterFinding(f, memoryLookup);
  if (result.passed) {
    active.push(f);
  } else {
    filtered.push({ finding: f, reason: result.reason ?? "Unknown" });
  }
}
```

with:

```typescript
const allFindings = parseSemgrepOutput(raw);
const active: Finding[] = [];
const filtered: { finding: Finding; reason: string }[] = [];
for (const f of allFindings) {
  const result = prefilterFinding(f);
  if (result.passed) {
    active.push(f);
  } else {
    filtered.push({ finding: f, reason: result.reason ?? "Unknown" });
  }
}
```

- [ ] **Step 4: Remove unused `createLookup()` from MemoryStore**

In `src/memory/store.ts`, delete the `createLookup()` method entirely (lines 118-124 in the pre-Task-1 file; adjust if different after Task 1). Also remove the unused import:

```typescript
import type { MemoryLookup } from "../parser/prefilter.js";
```

Delete that import line too. The `MemoryLookup` type no longer exists.

- [ ] **Step 5: Also remove the unused test for `createLookup()`**

In `tests/memory/store.test.ts`, DELETE the test `"createLookup returns a function usable by prefilter"` (the last `it(...)` block in the file).

- [ ] **Step 6: Type check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/parser/prefilter.ts src/index.ts src/ui/app.tsx src/memory/store.ts tests/parser/prefilter.test.ts tests/memory/store.test.ts
git commit -m "$(cat <<'EOF'
refactor: remove cache-based filtering from prefilter

Cached verdicts are completed work, not noise. Prefilter now only
rejects test files, generated code, and INFO severity. Remove the
now-unused memoryLookup parameter, MemoryLookup type, and
MemoryStore.createLookup() method.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Load cached verdicts into FindingState on TUI startup

**Files:**
- Modify: `src/ui/app.tsx` (MainScreen props and initial state, plus App component props passing)

- [ ] **Step 1: Pass memory store into `findingStates` initialization**

In `src/ui/app.tsx`, find the `findingStates` useState initializer inside `MainScreen` (around line 71-83):

```typescript
const [findingStates, setFindingStates] = useState<FindingState[]>(() =>
  findings.map((f) => ({
    entry: {
      fingerprint: fingerprintFinding(f),
      ruleId: f.check_id,
      fileLine: `${f.path}:${f.start.line}`,
      severity: f.extra.severity,
      status: "pending" as FindingStatus,
    },
    finding: f,
    events: [],
  })),
);
```

Replace with:

```typescript
const [findingStates, setFindingStates] = useState<FindingState[]>(() =>
  findings.map((f) => {
    const fp = fingerprintFinding(f);
    const cachedVerdict = memory.lookupVerdict(fp);
    return {
      entry: {
        fingerprint: fp,
        ruleId: f.check_id,
        fileLine: `${f.path}:${f.start.line}`,
        severity: f.extra.severity,
        status: (cachedVerdict?.verdict ?? "pending") as FindingStatus,
      },
      finding: f,
      events: [],
      verdict: cachedVerdict ?? undefined,
    };
  }),
);
```

- [ ] **Step 2: Type check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run tests**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 4: Manual verification — build and run**

```bash
bun build src/index.ts --compile --outfile sast-triage
```

Expected: compile succeeds.

Manually verify by running the TUI against a repo with previously-audited findings (optional — user will test).

- [ ] **Step 5: Commit**

```bash
git add src/ui/app.tsx
git commit -m "$(cat <<'EOF'
feat(tui): load cached verdicts into active list on startup

Previously-audited findings now appear in Active view with their
verdict badges (green/red/yellow) instead of being filtered out.
Press 'r' to re-audit any cached verdict.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Extend multi-select to filtered and dismissed views

**Files:**
- Modify: `src/ui/app.tsx` (multi-select keybindings + Enter handler)

- [ ] **Step 1: Add state for filtered/dismissed multi-select**

The existing `selectedIndices` state is reused for the active view. It will now be shared across all views — but we need to reset it on view change. In `src/ui/app.tsx`, find the Tab keybinding inside `useInput` (around line 344-350):

```typescript
if (key.tab) {
  const views: Array<"active" | "filtered" | "dismissed"> = ["active", "filtered", "dismissed"];
  const next = views[(views.indexOf(viewMode) + 1) % views.length]!;
  setViewMode(next);
  setSelectedIndex(0);
  return;
}
```

Replace with:

```typescript
if (key.tab) {
  const views: Array<"active" | "filtered" | "dismissed"> = ["active", "filtered", "dismissed"];
  const next = views[(views.indexOf(viewMode) + 1) % views.length]!;
  setViewMode(next);
  setSelectedIndex(0);
  setSelectedIndices(new Set());
  return;
}
```

- [ ] **Step 2: Remove `viewMode === "active"` restriction on Space key**

Find the Space keybinding (around line 354-363):

```typescript
// Space: toggle selection
if (input === " " && viewMode === "active" && !isTriaging) {
  setSelectedIndices((prev) => {
    const next = new Set(prev);
    if (next.has(selectedIndex)) next.delete(selectedIndex);
    else next.add(selectedIndex);
    return next;
  });
  return;
}
```

Replace with:

```typescript
// Space: toggle selection (works in all views)
if (input === " " && !isTriaging) {
  setSelectedIndices((prev) => {
    const next = new Set(prev);
    if (next.has(selectedIndex)) next.delete(selectedIndex);
    else next.add(selectedIndex);
    return next;
  });
  return;
}
```

- [ ] **Step 3: Update `a` (select all) to work across views**

Find the `a` keybinding (around line 365-369):

```typescript
// a: select all
if (input === "a" && viewMode === "active" && !isTriaging) {
  setSelectedIndices(new Set(findingStates.map((_, i) => i).filter((i) => !findingStates[i]!.verdict)));
  return;
}
```

Replace with:

```typescript
// a: select all (view-aware)
if (input === "a" && !isTriaging) {
  if (viewMode === "active") {
    setSelectedIndices(new Set(findingStates.map((_, i) => i).filter((i) => !findingStates[i]!.verdict)));
  } else if (viewMode === "filtered") {
    setSelectedIndices(new Set(filteredFindings.map((_, i) => i)));
  } else if (viewMode === "dismissed") {
    setSelectedIndices(new Set(dismissedFindings.map((_, i) => i)));
  }
  return;
}
```

- [ ] **Step 4: Add batch-promote helper above single `promoteFiltered`**

In `src/ui/app.tsx`, replace the existing `promoteFiltered` useCallback (around line 264-296) with two callbacks — a batch version and update the single version to delegate:

```typescript
// Promote selected filtered findings to active and triage them sequentially
const promoteFilteredBatch = useCallback(async (indices: number[]) => {
  if (isTriaging || viewMode !== "filtered" || indices.length === 0) return;
  const sorted = [...indices].sort((a, b) => a - b);
  const itemsToPromote = sorted.map((i) => filteredFindings[i]).filter((item): item is { finding: Finding; reason: string } => item != null);
  if (itemsToPromote.length === 0) return;

  const newStates: FindingState[] = itemsToPromote.map((item) => {
    const f = item.finding;
    return {
      entry: {
        fingerprint: fingerprintFinding(f),
        ruleId: f.check_id,
        fileLine: `${f.path}:${f.start.line}`,
        severity: f.extra.severity,
        status: "pending" as FindingStatus,
      },
      finding: f,
      events: [],
    };
  });

  const startIdx = findingStates.length;
  const newIndices = newStates.map((_, i) => startIdx + i);

  // Remove promoted from filtered, append to active
  setFilteredFindings((prev) => prev.filter((_, i) => !sorted.includes(i)));
  setFindingStates((prev) => [...prev, ...newStates]);
  setSelectedIndices(new Set());
  setViewMode("active");
  setSelectedIndex(startIdx);

  // Triage all newly-promoted findings
  setIsTriaging(true);
  stopQueueRef.current = false;
  setQueueState({ items: newIndices, currentIndex: 0, isRunning: true });
  for (let qi = 0; qi < newIndices.length; qi++) {
    if (stopQueueRef.current) break;
    setQueueState({ items: newIndices, currentIndex: qi, isRunning: true });
    await triageIndex(newIndices[qi]!);
  }
  setQueueState(null);
  setIsTriaging(false);
}, [isTriaging, viewMode, filteredFindings, findingStates.length, triageIndex]);

// Promote a single filtered finding (fallback when no selection)
const promoteFiltered = useCallback(async () => {
  await promoteFilteredBatch([selectedIndex]);
}, [selectedIndex, promoteFilteredBatch]);
```

- [ ] **Step 5: Add batch-restore helper**

Replace the existing `restoreDismissed` useCallback (around line 311-320):

```typescript
// Restore selected dismissed findings back to filtered
const restoreDismissedBatch = useCallback((indices: number[]) => {
  if (viewMode !== "dismissed" || indices.length === 0) return;
  const sorted = [...indices].sort((a, b) => a - b);
  const items = sorted.map((i) => dismissedFindings[i]).filter((item): item is { finding: Finding; reason: string } => item != null);
  if (items.length === 0) return;
  setFilteredFindings((prev) => [...prev, ...items]);
  setDismissedFindings((prev) => prev.filter((_, i) => !sorted.includes(i)));
  setSelectedIndices(new Set());
  if (selectedIndex >= dismissedFindings.length - items.length) {
    setSelectedIndex(Math.max(0, dismissedFindings.length - items.length - 1));
  }
}, [viewMode, selectedIndex, dismissedFindings]);

const restoreDismissed = useCallback(() => {
  restoreDismissedBatch([selectedIndex]);
}, [selectedIndex, restoreDismissedBatch]);
```

- [ ] **Step 6: Update Enter handler to use batch versions**

Find the Enter keybinding (around line 372-384):

```typescript
// Enter: start triage (active), promote filtered, or restore dismissed
if (key.return && !isTriaging) {
  if (viewMode === "active") {
    const indices = selectedIndices.size > 0
      ? [...selectedIndices].filter((i) => !findingStates[i]!.verdict).sort((a, b) => a - b)
      : [selectedIndex];
    startBatchQueue(indices);
  } else if (viewMode === "filtered") {
    promoteFiltered();
  } else if (viewMode === "dismissed") {
    restoreDismissed();
  }
  return;
}
```

Replace with:

```typescript
// Enter: start triage (active), promote filtered, or restore dismissed
if (key.return && !isTriaging) {
  if (viewMode === "active") {
    const indices = selectedIndices.size > 0
      ? [...selectedIndices].filter((i) => !findingStates[i]!.verdict).sort((a, b) => a - b)
      : [selectedIndex];
    startBatchQueue(indices);
  } else if (viewMode === "filtered") {
    const indices = selectedIndices.size > 0
      ? [...selectedIndices].sort((a, b) => a - b)
      : [selectedIndex];
    promoteFilteredBatch(indices);
  } else if (viewMode === "dismissed") {
    const indices = selectedIndices.size > 0
      ? [...selectedIndices].sort((a, b) => a - b)
      : [selectedIndex];
    restoreDismissedBatch(indices);
  }
  return;
}
```

- [ ] **Step 7: Type check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 9: Build and verify compile**

```bash
bun build src/index.ts --compile --outfile sast-triage
```

Expected: compile succeeds.

- [ ] **Step 10: Commit**

```bash
git add src/ui/app.tsx
git commit -m "$(cat <<'EOF'
feat(tui): multi-select across all views for batch operations

Space/a keys now work in filtered and dismissed views. Enter promotes
or restores all selected findings in one operation. Reuses the
existing batch queue for sequential triaging.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update filtered/dismissed list rendering to show selection indicators

**Files:**
- Modify: `src/ui/app.tsx` (filtered/dismissed list rendering block)

- [ ] **Step 1: Add selection indicator to filtered/dismissed list items**

In `src/ui/app.tsx`, find the rendering block for filtered/dismissed views (around line 443-458 inside the MainScreen return):

```typescript
{(viewMode === "filtered" ? filteredFindings : dismissedFindings).map((item, i) => {
  const isSelected = i === selectedIndex;
  const fp = `${viewMode}-${item.finding.check_id}-${item.finding.path}-${item.finding.start.line}`;
  const fileLine = `${item.finding.path}:${item.finding.start.line}`;
  const rule = item.finding.check_id.split(".").pop() ?? "";
  const cw = tableWidth - 4; // padding
  const line = `${fileLine} ${rule}`;
  const clipped = line.length > cw ? line.slice(0, cw - 1) + "…" : line;
  return (
    <Box key={fp}>
      <Text dimColor={!isSelected}>
        {isSelected ? "> " : "  "}{clipped}
      </Text>
    </Box>
  );
})}
```

Replace with:

```typescript
{(viewMode === "filtered" ? filteredFindings : dismissedFindings).map((item, i) => {
  const isSelected = i === selectedIndex;
  const isMultiSelected = selectedIndices.has(i);
  const fp = `${viewMode}-${item.finding.check_id}-${item.finding.path}-${item.finding.start.line}`;
  const fileLine = `${item.finding.path}:${item.finding.start.line}`;
  const rule = item.finding.check_id.split(".").pop() ?? "";
  const cw = tableWidth - 6; // padding + marker
  const line = `${fileLine} ${rule}`;
  const clipped = line.length > cw ? line.slice(0, cw - 1) + "…" : line;
  const marker = isMultiSelected ? "●" : " ";
  return (
    <Box key={fp}>
      <Text dimColor={!isSelected}>
        {isSelected ? ">" : " "}{marker} {clipped}
      </Text>
    </Box>
  );
})}
```

- [ ] **Step 2: Type check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run full test suite**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 4: Build and verify compile**

```bash
bun build src/index.ts --compile --outfile sast-triage
```

Expected: compile succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/ui/app.tsx
git commit -m "$(cat <<'EOF'
feat(tui): show multi-select indicators in filtered/dismissed lists

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Section 1 (Persist full verdict) → Task 1 + Task 2
- ✅ Section 2 (Remove cache filtering) → Task 3 + Task 4
- ✅ Section 3 (Load cached verdicts into active) → Task 5
- ✅ Section 4 (Multi-select across views) → Task 6 + Task 7

**Placeholder scan:** None. Every step has concrete code or commands.

**Type consistency:**
- `lookupVerdict()` returns `TriageVerdict | null` (Task 1) → app.tsx uses `memory.lookupVerdict(fp)` (Task 5) ✓
- `StoreInput.key_evidence: string[]` (Task 1) → call sites pass `verdict.key_evidence` (Task 2) ✓
- `prefilterFinding(finding)` signature (Task 3) → all call sites drop the 2nd arg (Task 4) ✓
- `promoteFilteredBatch(indices: number[])` (Task 6) → Enter handler passes `number[]` (Task 6 step 6) ✓
- `restoreDismissedBatch(indices: number[])` (Task 6) → same ✓

**Final verification at end of plan:**
```bash
npx vitest run && npx tsc --noEmit && bun build src/index.ts --compile --outfile sast-triage
```
Expected: 110 tests pass (started at 111, minus 2 deleted cache tests, plus 3 new lookupVerdict tests = 112 — actual will depend on precise counts).
