import { describe, it, expect } from "vitest";
import { WorkerPool } from "../../src/core/worker/pool.js";
import { GraphBridge } from "../../src/core/worker/graph-bridge.js";
import type { Finding } from "../../src/core/models/finding.js";
import type { TriageResult } from "../../src/core/triage/orchestrator.js";

// Bun Workers require the Bun runtime — skip when running under Node/vitest.
const isBun = typeof globalThis.Bun !== "undefined";

const stubFinding = (i: number): Finding => ({
  check_id: `rule-${i}`,
  path: `src/file-${i}.ts`,
  start: { line: 1, col: 1 },
  end: { line: 1, col: 1 },
  extra: { severity: "ERROR", message: "stub", lines: "x" },
} as any);

describe("WorkerPool integration (2 workers x 4 findings)", () => {
  it.skipIf(!isBun)("processes all findings via real Bun Workers", async () => {
    const results: Record<string, TriageResult> = {};
    const pool = new WorkerPool({
      size: 2,
      // Pass SAST_TEST_AGENT_STUB into each worker via Bun's env option so the
      // stub short-circuit in runAgentLoop is active without network calls.
      factory: () => new Worker(new URL("../../src/core/worker/entry.ts", import.meta.url), {
        env: { SAST_TEST_AGENT_STUB: "1" },
      } as any) as any,
      serializedConfig: {
        provider: "openai",
        model: "gpt-4o",
        apiKey: "stub",
        maxSteps: 5,
        allowBash: false,
        // concurrency: 1 per worker avoids the 500ms init-stagger in entry.ts,
        // keeping deterministic task dispatch with fast-returning stubs.
        concurrency: 1,
      },
      tracingEnabled: false,
      graphBridge: new GraphBridge(null),
      onEvent: () => {},
      onResult: (fp, r) => { results[fp] = r; },
    });

    const tasks = Array.from({ length: 4 }, (_, i) => ({
      finding: stubFinding(i),
      fingerprint: `fp-${i}`,
    }));
    pool.enqueue(tasks);
    await pool.run();

    expect(Object.keys(results).sort()).toEqual(["fp-0", "fp-1", "fp-2", "fp-3"]);
    for (const r of Object.values(results)) {
      expect((r as any).verdict.verdict).toBe("false_positive");
    }
  }, 30_000);
});
