// Test-only stub for `runAgentLoop`. Imported lazily and only when BOTH
// `process.env.NODE_ENV === "test"` AND `process.env.SAST_TEST_AGENT_STUB === "1"`
// are set. Production-binary builds also pin `process.env.NODE_ENV` to
// `"production"` via `--define`, so this module is dead-code-eliminated from
// the compiled `sast-triage` binary's reachable graph.
//
// MUST NOT be imported from any production code path. The single legitimate
// caller is the gated branch at the top of `runAgentLoop` in `loop.ts`.

import type { AgentEvent } from "../models/events.js";
import type { AgentLoopConfig, AgentLoopResult } from "./loop.js";

/**
 * Returns a canned `AgentLoopResult` for stub findings. Special `check_id`
 * sentinels trigger deliberate worker-crash behavior so the worker pool's
 * crash/restart paths can be exercised in integration tests.
 *
 * Returning a non-resolving promise (the crash sentinels) keeps the worker's
 * `runFinding` await pending while the synchronous `setTimeout` throw fires
 * outside the promise chain — the only reliable way to surface the error
 * via the worker's `error` event listener (caught promise rejections never
 * propagate up to that listener, by design).
 */
export function runTestAgentStub(config: AgentLoopConfig): AgentLoopResult | Promise<AgentLoopResult> {
  if (config.finding.check_id === "__crash_exit__") {
    // Bun 1.3.x Workers defer `process.exit`, so pair it with a synchronous
    // timer throw that fires outside the runFinding `.catch()` chain — the
    // throw triggers the worker's `error` event ⇒ `fatal` ⇒ `handleCrash`,
    // and the deferred exit eventually reaps the process.
    process.exit(1);
    setTimeout(() => { throw new Error("simulated worker exit"); }, 0);
    return new Promise<never>(() => {});
  }

  if (config.finding.check_id === "__crash_throw__") {
    // Throwing synchronously from `runAgentLoop` is caught by
    // `runFinding(...).catch(...)` in `entry.ts` and converted to a
    // benign `result` message — the worker stays alive and the crash/
    // restart path never executes. To genuinely crash the worker, the
    // throw must escape the awaited promise chain, so schedule it on a
    // fresh task tick where the runtime treats it as an uncaught error
    // and fires the worker's `error` event listener.
    setTimeout(() => { throw new Error("simulated crash"); }, 0);
    return new Promise<never>(() => {});
  }

  config.onEvent?.({ type: "tool_call", tool: "noop", args: {} } as unknown as AgentEvent);
  return {
    verdict: {
      verdict: "false_positive",
      reasoning: "stub",
      key_evidence: [],
      sink_line_quoted: "",
      attacker_payload: "",
    },
    toolCalls: [{ tool: "noop", args: {} }],
    inputTokens: 1,
    outputTokens: 1,
  };
}
