import { describe, it, expect } from "vitest";
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

describe("WorkerPool crash handling (real workers)", () => {
  it.skipIf(!isBun)("process.exit(1) inside worker yields error verdict", async () => {
    const results: Record<string, any> = {};
    const pool = new WorkerPool({
      size: 1,
      factory: () => new Worker(new URL("../../src/core/worker/entry.ts", import.meta.url), {
        env: { SAST_TEST_AGENT_STUB: "1" },
      } as any) as any,
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
  }, 30_000);

  it.skipIf(!isBun)("workerRestart=true redrives once after a throw", async () => {
    const results: Record<string, any> = {};
    const pool = new WorkerPool({
      size: 1,
      factory: () => new Worker(new URL("../../src/core/worker/entry.ts", import.meta.url), {
        env: { SAST_TEST_AGENT_STUB: "1" },
      } as any) as any,
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

    // First task crashes; redrive runs the SAME finding which crashes again.
    // After 1 redrive policy gives up and emits error verdict.
    pool.enqueue([{ finding: finding("__crash_throw__"), fingerprint: "fp" }]);
    await pool.run();

    expect(results["fp"].verdict.verdict).toBe("error");
  }, 30_000);
});
