import { describe, it, expect, vi } from "vitest";
import { WorkerPool } from "../../src/core/worker/pool.js";
import { GraphBridge } from "../../src/core/worker/graph-bridge.js";

const isBun = typeof globalThis.Bun !== "undefined";

const finding = (id: string) => ({
  check_id: id,
  path: "x.ts",
  start: { line: 1, col: 1 },
  end: { line: 1, col: 1 },
  extra: { severity: "ERROR", message: "x", lines: "x" },
}) as any;

// Bun's Worker `env` option REPLACES the parent env. Both vars are required
// by the gate at the top of `runAgentLoop`; without `NODE_ENV` the stub would
// fall through and try to call a real LLM with `apiKey: "stub"`.
const stubEnv = { SAST_TEST_AGENT_STUB: "1", NODE_ENV: "test" } as Record<string, string>;

const workerEntryUrl = new URL("../../src/core/worker/entry.ts", import.meta.url);

describe("WorkerPool crash handling (real workers)", () => {
  it.skipIf(!isBun)("process.exit(1) inside worker yields error verdict", async () => {
    const results: Record<string, any> = {};
    const factory = vi.fn(() => new Worker(workerEntryUrl, { env: stubEnv } as any) as any);
    const pool = new WorkerPool({
      size: 1,
      factory,
      serializedConfig: {
        provider: "openai", model: "gpt-4o", apiKey: "stub",
        maxSteps: 5, allowBash: false, concurrency: 1,
      },
      tracingEnabled: false,
      graphBridge: new GraphBridge(null),
      workerRestart: false,
      onEvent: () => {},
      onResult: (fp, r) => { results[fp] = r; },
    });
    pool.enqueue([{ finding: finding("__crash_exit__"), fingerprint: "fp" }]);
    await pool.run();

    expect(results["fp"].verdict.verdict).toBe("error");
    // workerRestart=false ⇒ the slot is drained on first crash and never
    // respawned. Asserting exactly one factory call documents that the
    // policy was honored (rather than the test passing because of an
    // accidental error-verdict path elsewhere).
    expect(factory).toHaveBeenCalledTimes(1);
  }, 30_000);

  it.skipIf(!isBun)("workerRestart=true respawns the worker after an uncaught throw", async () => {
    const results: Record<string, any> = {};
    // Spy on the factory so we can assert the restart actually happened.
    // Without this assertion the test would pass even when the throw is
    // silently caught inside the worker (the `verdict === "error"` check
    // is satisfied by the in-worker `.catch` path too, which short-circuits
    // the entire crash/restart pipeline).
    const factory = vi.fn(() => new Worker(workerEntryUrl, { env: stubEnv } as any) as any);
    const pool = new WorkerPool({
      size: 1,
      factory,
      serializedConfig: {
        provider: "openai", model: "gpt-4o", apiKey: "stub",
        maxSteps: 5, allowBash: false, concurrency: 1,
      },
      tracingEnabled: false,
      graphBridge: new GraphBridge(null),
      workerRestart: true,
      onEvent: () => {},
      onResult: (fp, r) => { results[fp] = r; },
    });

    // First task crashes the worker (uncaught error). Pool respawns the slot
    // and redrives the SAME finding, which crashes the second worker too.
    // Restart policy caps at 1 redrive ⇒ second crash emits an error verdict.
    pool.enqueue([{ finding: finding("__crash_throw__"), fingerprint: "fp" }]);
    await pool.run();

    expect(results["fp"].verdict.verdict).toBe("error");
    // Two factory invocations: one initial spawn, one restart after the
    // first crash. A regression where the throw is swallowed by
    // `runFinding(...).catch(...)` in entry.ts would leave this at 1.
    expect(factory).toHaveBeenCalledTimes(2);
  }, 30_000);
});
