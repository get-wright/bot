# Verdict Persistence & Unified Finding State — Design

**Date:** 2026-04-04
**Status:** Approved
**Scope:** Fix three related issues: incomplete verdict persistence, audited findings incorrectly filtered, and missing batch operations across views.

## Problem

Three bugs make the tool feel stateless:

1. **Verdicts persist incompletely.** `TriageRecord` stores only `verdict` + `reasoning`. The `key_evidence` and `suggested_fix` fields are discarded. Re-opening the tool loses the full verdict.

2. **Audited findings appear in the wrong view.** `prefilter.ts:22-26` treats cached verdicts identically to test files and generated code — filtering them OUT of the active list. So after auditing 5 findings and restarting, those 5 findings move to the "Filtered" view with reason `"Cached verdict: true_positive"`, even though they represent completed work.

3. **No batch operations across views.** Multi-select (`Space`/`a` keys) only works in the Active view. Users cannot bulk-promote filtered findings back to active, or bulk-restore dismissed findings.

## Design

### 1. Persist the full verdict

Extend `TriageRecord` in `src/memory/store.ts` with:
- `key_evidence` (TEXT, JSON-encoded `string[]`, default `'[]'`)
- `suggested_fix` (TEXT, nullable)

Add a schema migration using `PRAGMA table_info` for idempotency. Safe for existing DBs since SQLite `ALTER TABLE ADD COLUMN` is non-destructive.

Update `StoreInput`, `store()`, and `lookup()` to round-trip all fields. Add a new method `lookupVerdict(fingerprint): TriageVerdict | null` that reconstructs the full `TriageVerdict` shape for consumers (app.tsx initialization).

Remove `createLookup()` method — it's unused after prefilter changes. `getHints()` stays (uses `lookup()` and `lookupByRule()` for memory hints in the agent loop).

### 2. Remove cache-based filtering

Delete the memory lookup check in `src/parser/prefilter.ts` (lines 22-26). Also remove the `memoryLookup` parameter from `prefilterFinding()` and its callers.

The prefilter should only reject true noise: test files, generated code, INFO severity. Cached verdicts are completed work, not noise.

### 3. Load cached verdicts into active list

In `src/ui/app.tsx`, after parsing findings, look up each by fingerprint in the memory store. If a cached verdict exists, initialize its `FindingState` with the full verdict pre-populated and `status` set to the verdict type.

The existing `FindingsTable` status-badge logic handles rendering automatically — findings with `verdict` set show colored badges (red/green/yellow), pending findings show "pending".

User experience:
- First run: 13 findings, all pending in Active view
- User audits 5, closes app
- Second run: 13 findings still in Active view — 5 with verdict badges, 8 pending
- `r` key still re-audits any cached verdict

### 4. Multi-select across views

Extend `Space` and `a` key handlers to work in `filtered` and `dismissed` views. Extend `Enter` handler to batch-process:

- **Filtered view** + selection: promote all selected findings to active, triage sequentially via existing `startBatchQueue`
- **Dismissed view** + selection: restore all selected findings back to filtered

Existing logic for single-finding `promoteFiltered()` and `restoreDismissed()` gets parameterized to accept a list of indices.

## Data Flow

```
Semgrep JSON → Parser → Pre-filter (test/generated/INFO only) → Active findings
                                                                      │
                                                              Memory lookup by fp
                                                                      │
                                             ┌────────────────────────┴─────────────┐
                                             │                                      │
                                    Cached verdict found                       No cache
                                             │                                      │
                                   FindingState with full verdict        FindingState pending
                                             │                                      │
                                             └─────────────────┬────────────────────┘
                                                               │
                                                          Active view
```

## Error Handling

- **Migration failure**: wrap `ALTER TABLE` in try/catch. If migration fails (extremely unlikely), log warning and continue with existing schema. Old rows without the new columns return `key_evidence: []` and `suggested_fix: undefined`.
- **JSON parse failure for `key_evidence`**: if stored JSON is corrupted, return `[]` and log.
- **Fingerprint mismatch**: if a finding's line/content changes between runs, fingerprint changes, cache miss. Shown as pending. Correct behavior.

## Testing

**Memory store** (`tests/memory/store.test.ts`):
- Round-trip full verdict (verdict + reasoning + key_evidence + suggested_fix)
- Migration adds columns without data loss
- Lookup returns `null` for unknown fingerprints
- Corrupted `key_evidence` JSON returns `[]` gracefully

**Prefilter** (`tests/parser/prefilter.test.ts`):
- No longer references memory lookup
- Test files, generated files, INFO severity still filtered
- Update any existing tests that pass `memoryLookup` parameter

**App integration** (optional, via snapshot or unit test of state initialization):
- Verify `FindingState` initialization loads cached verdicts
- Verify pending findings get empty events/undefined verdict

**No new components needed.**

## Files Touched

- `src/memory/store.ts` — schema migration, extended `StoreInput`/`TriageRecord`, new `lookupVerdict()` method, remove unused `createLookup()`, JSON encode/decode
- `src/parser/prefilter.ts` — remove `memoryLookup` parameter and cache check
- `src/parser/semgrep.ts` — no change (just referenced for `fingerprintFinding`)
- `src/ui/app.tsx` — load cached verdicts into `FindingState`, extend multi-select handlers to filtered/dismissed views
- `src/index.ts` — remove `memoryLookup` arg to `prefilterFinding` in headless path
- `tests/memory/store.test.ts` — new round-trip tests
- `tests/parser/prefilter.test.ts` — remove/update cache-based tests

## Out of Scope

- Exporting verdicts to a report file (already handled by headless NDJSON mode)
- Multi-user or remote memory store
- Re-running cached verdicts automatically (user triggers via `r`)
- Fingerprint versioning / schema evolution beyond what `ALTER TABLE` covers
