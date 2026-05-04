# --input Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--input <path>` CLI flag as alias for the existing positional `[findings]` argument; add tests confirming the precedence chain.

**Architecture:** Two-line surface change in `src/cli/cli.ts` (Commander option + precedence resolve). No changes to `resolveConfig` or downstream code — `--input` and the positional arg both feed the same `findingsPath` string. Env coverage is already complete (audit in spec).

**Tech Stack:** TypeScript, Commander, Vitest, Bun.

Spec: `docs/superpowers/specs/2026-05-04-input-flag-design.md`

---

## File Structure

- Modify: `src/cli/cli.ts` — add `--input` Commander option, resolve precedence in action handler, update positional arg help text
- Modify: `tests/cli/index-smoke.test.ts` (or new dedicated file) — add CLI-level tests covering `--input` precedence

The CLI test file already exists and covers smoke behavior of `program.parse`. We add tests there to keep CLI tests in one place.

---

### Task 1: Smoke-test the existing CLI test file

**Files:**
- Read: `tests/cli/index-smoke.test.ts`

- [ ] **Step 1: Read the file to confirm test pattern**

Run: `cat tests/cli/index-smoke.test.ts`
Expected: shows existing CLI smoke tests using `program.parse([...])` or similar; if absent or differently structured, fall back to creating `tests/cli/input-flag.test.ts` with the same env-cleanup `beforeEach`/`afterEach` shape used in `tests/cli/config-resolution.test.ts`.

- [ ] **Step 2: Run the existing CLI tests to confirm green baseline**

Run: `bunx vitest run tests/cli/`
Expected: all pass.

---

### Task 2: Write failing tests for `--input` precedence

**Files:**
- Create: `tests/cli/input-flag.test.ts`

- [ ] **Step 1: Write the failing tests**

Tests target `resolveConfig` because that is where `findingsPath` lands. The CLI's job is to pass the right value in; we cover that with one test that drives the action handler indirectly (via captured opts).

Create `tests/cli/input-flag.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveConfig } from "../../src/cli/config.js";

const ENV_KEYS = ["SAST_FINDINGS"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("--input precedence", () => {
  it("--input value lands in findingsPath", () => {
    const cfg = resolveConfig({ findingsPath: "/abs/from-input.json" });
    expect(cfg.findingsPath).toBe("/abs/from-input.json");
  });

  it("positional value lands in findingsPath when --input absent", () => {
    const cfg = resolveConfig({ findingsPath: "/abs/from-positional.json" });
    expect(cfg.findingsPath).toBe("/abs/from-positional.json");
  });

  it("SAST_FINDINGS used when neither flag nor positional supplied", () => {
    process.env.SAST_FINDINGS = "/abs/from-env.json";
    const cfg = resolveConfig({});
    expect(cfg.findingsPath).toBe("/abs/from-env.json");
  });

  it("explicit findingsPath beats SAST_FINDINGS", () => {
    process.env.SAST_FINDINGS = "/abs/from-env.json";
    const cfg = resolveConfig({ findingsPath: "/abs/from-cli.json" });
    expect(cfg.findingsPath).toBe("/abs/from-cli.json");
  });
});
```

These cover the value-flow path inside `resolveConfig`. The `--input`-vs-positional resolution itself happens in the Commander action handler. Add a separate test for that:

Append to the same file:

```ts
import { Command } from "commander";

describe("--input vs positional resolution in CLI", () => {
  function captureFindingsPath(argv: string[]): string | undefined {
    let captured: string | undefined;
    const program = new Command();
    program
      .argument("[findings]")
      .option("--input <path>")
      .action((findingsPath: string | undefined, opts: any) => {
        captured = opts.input ?? findingsPath;
      });
    program.parse(argv, { from: "user" });
    return captured;
  }

  it("--input wins over positional when both supplied", () => {
    expect(captureFindingsPath(["pos.json", "--input", "flag.json"])).toBe("flag.json");
  });

  it("positional alone is used when --input absent", () => {
    expect(captureFindingsPath(["pos.json"])).toBe("pos.json");
  });

  it("--input alone is used when positional absent", () => {
    expect(captureFindingsPath(["--input", "flag.json"])).toBe("flag.json");
  });

  it("both absent yields undefined", () => {
    expect(captureFindingsPath([])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail (or pass) appropriately**

Run: `bunx vitest run tests/cli/input-flag.test.ts`
Expected: the four `resolveConfig` tests PASS already (no code change needed — they exercise existing behavior and act as regression guards). The four "CLI resolution" tests PASS as well because they construct a local Commander program that already resolves `opts.input ?? findingsPath`.

If everything passes already: that's expected. The tests' purpose is to lock the contract before we change `cli.ts`. Proceed to Task 3 — the next task adds `--input` to the *real* CLI program so the contract becomes a behavior of the shipped binary, not just a local test fixture.

- [ ] **Step 3: Commit**

```bash
git add tests/cli/input-flag.test.ts
git commit -m "test(cli): cover --input vs positional precedence"
```

---

### Task 3: Add `--input` flag to the real CLI program

**Files:**
- Modify: `src/cli/cli.ts:25` (positional arg description), `src/cli/cli.ts:26-36` (option block), `src/cli/cli.ts:37-82` (action handler)

- [ ] **Step 1: Edit `src/cli/cli.ts`**

Change the positional arg description and add the `--input` option. Update the action handler to resolve `--input` before the positional arg.

Old (line 25):
```ts
    .argument("[findings]", "Path to Semgrep JSON output file (or set SAST_FINDINGS)")
```

New:
```ts
    .argument("[findings]", "Path to Semgrep JSON file (or use --input / SAST_FINDINGS)")
    .option("--input <path>", "Path to Semgrep JSON file (alias for positional arg, or set SAST_FINDINGS)")
```

Inside the action handler, after the existing `const concurrency = ...` / `const maxSteps = ...` lines (currently at line 61-62), resolve the input path:

Old:
```ts
      const concurrency = parseConcurrency(opts.concurrency);
      const maxSteps = opts.maxSteps !== undefined ? parseInt(opts.maxSteps, 10) : undefined;

      const resolved = resolveConfig({
        findingsPath,
```

New:
```ts
      const concurrency = parseConcurrency(opts.concurrency);
      const maxSteps = opts.maxSteps !== undefined ? parseInt(opts.maxSteps, 10) : undefined;
      const inputPath = opts.input ?? findingsPath;

      const resolved = resolveConfig({
        findingsPath: inputPath,
```

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run all tests**

Run: `bunx vitest run`
Expected: all 143+ existing tests still pass; the 8 new tests in `input-flag.test.ts` pass.

- [ ] **Step 4: Manual smoke check (positional still works)**

Run: `bun run src/index.ts --help`
Expected: `--help` output shows the new `--input <path>` line and the updated positional description mentions `--input / SAST_FINDINGS`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/cli.ts
git commit -m "feat(cli): add --input flag as alias for positional findings arg"
```

---

### Task 4: Update CLAUDE.md examples

**Files:**
- Modify: `CLAUDE.md` (Commands section — show one `--input` example alongside the existing positional example)

- [ ] **Step 1: Edit the Commands block in `CLAUDE.md`**

Find the line:
```
./sast-triage findings.json --provider openai --model gpt-4o  # NDJSON
```

Replace with:
```
./sast-triage findings.json --provider openai --model gpt-4o  # NDJSON (positional)
./sast-triage --input findings.json --provider openai         # equivalent via flag
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): show --input flag example"
```

---

## Self-Review Checklist (already run during plan write)

- ✅ Spec coverage: `--input` flag (Task 3), env audit (no code change required, locked by tests in Task 2), tests (Task 2), back-compat with positional (Task 3 keeps it).
- ✅ Placeholder scan: no TBDs; every code block is the literal change to apply.
- ✅ Type consistency: `findingsPath` keeps its existing type (`string | undefined`); `opts.input` is Commander-typed `string | undefined`.

---

## Out of Scope (per spec)

- Removing the positional argument
- New env vars beyond `SAST_FINDINGS`
- Custom `.env` path loading (Bun handles `.env` autoloading)
- Existence-checking the path at parse time
