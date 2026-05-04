import { describe, it, expect, vi } from "vitest";
import { WorkerPool } from "../../../src/core/worker/pool.js";
import { GraphBridge } from "../../../src/core/worker/graph-bridge.js";
import type { GraphClient } from "../../../src/infra/graph/mcp-client.js";
import type { SerializedConfig } from "../../../src/core/worker/protocol.js";

function makeFakeWorker() {
  const listeners: Record<string, Function[]> = {};
  let mainHandler: ((e: { data: unknown }) => void) | null = null;
  return {
    postMessage: vi.fn(),
    addEventListener: vi.fn((evt: string, fn: Function) => {
      (listeners[evt] ??= []).push(fn);
    }),
    set onmessage(fn: any) { mainHandler = fn; },
    get onmessage() { return mainHandler; },
    terminate: vi.fn(),
    _emit(evt: string, payload: any) {
      (listeners[evt] ?? []).forEach(fn => fn(payload));
    },
    _msgFromWorker(data: any) {
      mainHandler?.({ data });
    },
  };
}

const config: SerializedConfig = {
  provider: "openai",
  model: "gpt-4o",
  apiKey: "k",
  maxSteps: 20,
  allowBash: false,
  concurrency: 1,
};

describe("WorkerPool spawn", () => {
  it("spawns N workers and sends init to each", async () => {
    const factory = vi.fn(() => makeFakeWorker());
    const pool = new WorkerPool({
      size: 3,
      factory: factory as any,
      serializedConfig: config,
      tracingEnabled: false,
      onEvent: () => {},
      onResult: () => {},
      graphBridge: null as any,
    });

    pool.start();

    expect(factory).toHaveBeenCalledTimes(3);
    const inits = factory.mock.results.map(r => (r.value as any).postMessage.mock.calls[0]);
    inits.forEach(call => {
      expect(call[0].kind).toBe("init");
      expect(call[0].serializedConfig).toEqual(config);
    });
  });

  // Bug 1 regression: workers must not register graph tools when main has
  // no graph client. The pool signals this via `graphEnabled` in the init
  // message; entry.ts uses it to decide whether to construct a stub.
  it("init carries graphEnabled=false when graphBridge wraps a null client", () => {
    const factory = vi.fn(() => makeFakeWorker());
    const pool = new WorkerPool({
      size: 1,
      factory: factory as any,
      serializedConfig: config,
      tracingEnabled: false,
      onEvent: () => {},
      onResult: () => {},
      graphBridge: new GraphBridge(null),
    });

    pool.start();

    const initMsg = (factory.mock.results[0].value as any).postMessage.mock.calls[0][0];
    expect(initMsg.kind).toBe("init");
    expect(initMsg.graphEnabled).toBe(false);
  });

  it("init carries graphEnabled=true when graphBridge wraps a real client", () => {
    const fakeClient: GraphClient = {
      queryGraph: vi.fn(async () => []),
      searchSymbol: vi.fn(async () => []),
      close: vi.fn(async () => {}),
    } as unknown as GraphClient;
    const factory = vi.fn(() => makeFakeWorker());
    const pool = new WorkerPool({
      size: 1,
      factory: factory as any,
      serializedConfig: config,
      tracingEnabled: false,
      onEvent: () => {},
      onResult: () => {},
      graphBridge: new GraphBridge(fakeClient),
    });

    pool.start();

    const initMsg = (factory.mock.results[0].value as any).postMessage.mock.calls[0][0];
    expect(initMsg.kind).toBe("init");
    expect(initMsg.graphEnabled).toBe(true);
  });

  it("shutdown calls terminate on every worker", () => {
    const workers: any[] = [];
    const factory = vi.fn(() => {
      const w = makeFakeWorker();
      workers.push(w);
      return w;
    });
    const pool = new WorkerPool({
      size: 2,
      factory: factory as any,
      serializedConfig: config,
      tracingEnabled: false,
      onEvent: () => {},
      onResult: () => {},
      graphBridge: null as any,
    });
    pool.start();
    pool.shutdown();

    workers.forEach(w => expect(w.terminate).toHaveBeenCalledOnce());
  });
});

describe("WorkerPool dispatch", () => {
  it("on request_task, sends next queued task", async () => {
    const factory = vi.fn(() => makeFakeWorker());
    const pool = new WorkerPool({
      size: 1,
      factory: factory as any,
      serializedConfig: config,
      tracingEnabled: false,
      onEvent: () => {},
      onResult: () => {},
      graphBridge: null as any,
    });

    const finding = { check_id: "rule-1" } as any;
    pool.enqueue([{ finding, fingerprint: "fp1" }]);
    pool.start();

    const w = factory.mock.results[0].value;
    w._msgFromWorker({ kind: "request_task" });

    const taskCall = w.postMessage.mock.calls.find(
      (c: any[]) => c[0].kind === "task",
    );
    expect(taskCall).toBeDefined();
    expect(taskCall![0].fingerprint).toBe("fp1");
  });

  // Bug 2 regression: when a worker finishes its last task it sends both
  // `result` and `request_task`. The pool sends shutdown on `result` (via
  // checkDone), so the late-arriving `request_task` must not post a second
  // shutdown to the (potentially terminated) worker.
  it("does not post duplicate shutdown when result+request_task arrive after the last task", async () => {
    const factory = vi.fn(() => makeFakeWorker());
    const pool = new WorkerPool({
      size: 1,
      factory: factory as any,
      serializedConfig: config,
      tracingEnabled: false,
      onEvent: () => {},
      onResult: () => {},
      graphBridge: null as any,
    });

    const finding = { check_id: "r" } as any;
    pool.enqueue([{ finding, fingerprint: "fp-only" }]);
    const runP = pool.run();

    const w = factory.mock.results[0].value;
    w._msgFromWorker({ kind: "request_task" });
    // Worker finishes its only task: sends result, then asks for more.
    w._msgFromWorker({
      kind: "result",
      fingerprint: "fp-only",
      result: {
        verdict: { verdict: "false_positive", reasoning: "ok", key_evidence: [] },
        toolCalls: [],
        inputTokens: 0,
        outputTokens: 0,
      } as any,
    });
    w._msgFromWorker({ kind: "request_task" });

    await Promise.race([
      runP,
      new Promise((_, rej) => setTimeout(() => rej(new Error("pool.run() hung")), 1000)),
    ]);

    const shutdownPosts = w.postMessage.mock.calls.filter(
      (c: any[]) => c[0]?.kind === "shutdown",
    );
    expect(shutdownPosts).toHaveLength(1);
  });

  it("when queue empty, sends shutdown", async () => {
    const factory = vi.fn(() => makeFakeWorker());
    const pool = new WorkerPool({
      size: 1,
      factory: factory as any,
      serializedConfig: config,
      tracingEnabled: false,
      onEvent: () => {},
      onResult: () => {},
      graphBridge: null as any,
    });
    pool.enqueue([]);
    pool.start();

    const w = factory.mock.results[0].value;
    w._msgFromWorker({ kind: "request_task" });

    const shutdownCall = w.postMessage.mock.calls.find(
      (c: any[]) => c[0].kind === "shutdown",
    );
    expect(shutdownCall).toBeDefined();
  });

  it("forwards result and event messages to callbacks", async () => {
    const factory = vi.fn(() => makeFakeWorker());
    const onResult = vi.fn();
    const onEvent = vi.fn();
    const pool = new WorkerPool({
      size: 1,
      factory: factory as any,
      serializedConfig: config,
      tracingEnabled: false,
      onEvent,
      onResult,
      graphBridge: null as any,
    });
    pool.start();

    const w = factory.mock.results[0].value;
    w._msgFromWorker({
      kind: "event",
      fingerprint: "fp1",
      event: { type: "tool_call" } as any,
    });
    w._msgFromWorker({
      kind: "result",
      fingerprint: "fp1",
      result: {
        verdict: { verdict: "false_positive", reasoning: "test", key_evidence: [] },
        toolCalls: [],
        inputTokens: 0,
        outputTokens: 0,
      } as any,
    });

    expect(onEvent).toHaveBeenCalledWith("fp1", expect.objectContaining({ type: "tool_call" }));
    expect(onResult).toHaveBeenCalledOnce();
  });
});

describe("WorkerPool crash handling", () => {
  it("emits error verdict for in-flight finding when worker crashes (no-restart)", async () => {
    const onResult = vi.fn();
    const factory = vi.fn(() => makeFakeWorker());
    const pool = new WorkerPool({
      size: 1,
      factory: factory as any,
      serializedConfig: config,
      tracingEnabled: false,
      onEvent: () => {},
      onResult,
      graphBridge: null as any,
      workerRestart: false,
    });

    const finding = { check_id: "r" } as any;
    pool.enqueue([{ finding, fingerprint: "fp-crash" }]);
    pool.start();

    const w = factory.mock.results[0].value;
    w._msgFromWorker({ kind: "request_task" }); // pulls task, registers in-flight
    w._emit("close", { code: 1 });

    expect(onResult).toHaveBeenCalledWith(
      "fp-crash",
      expect.objectContaining({
        verdict: expect.objectContaining({ verdict: "error" }),
      }),
    );
  });

  it("with workerRestart=true, redrives in-flight task once", () => {
    const onResult = vi.fn();
    const workers: any[] = [];
    const factory = vi.fn(() => {
      const w = makeFakeWorker();
      workers.push(w);
      return w;
    });
    const pool = new WorkerPool({
      size: 1,
      factory: factory as any,
      serializedConfig: config,
      tracingEnabled: false,
      onEvent: () => {},
      onResult,
      graphBridge: null as any,
      workerRestart: true,
    });

    const finding = { check_id: "r" } as any;
    pool.enqueue([{ finding, fingerprint: "fp-redrive" }]);
    pool.start();

    workers[0]._msgFromWorker({ kind: "request_task" });
    workers[0]._emit("close", { code: 1 });

    // A new worker should have spawned and received an init.
    expect(factory).toHaveBeenCalledTimes(2);
    const reinit = workers[1].postMessage.mock.calls[0];
    expect(reinit[0].kind).toBe("init");

    // After ready/request_task on the new worker, it should pull the redriven task.
    workers[1]._msgFromWorker({ kind: "request_task" });
    const taskCall = workers[1].postMessage.mock.calls.find((c: any[]) => c[0].kind === "task");
    expect(taskCall![0].fingerprint).toBe("fp-redrive");
  });

  it("expected shutdown with code=0 is not treated as a crash", () => {
    const onResult = vi.fn();
    const factory = vi.fn(() => makeFakeWorker());
    const pool = new WorkerPool({
      size: 1,
      factory: factory as any,
      serializedConfig: config,
      tracingEnabled: false,
      onEvent: () => {},
      onResult,
      graphBridge: null as any,
    });
    pool.enqueue([]);
    pool.start();

    const w = factory.mock.results[0].value;
    w._msgFromWorker({ kind: "request_task" }); // queue empty -> shutdown sent
    w._emit("close", { code: 0 });

    expect(onResult).not.toHaveBeenCalled();
  });

  // Bug 1 regression: when the last alive worker crashes with workerRestart=false,
  // queued (not-yet-started) findings must be drained to error verdicts so that
  // run() resolves instead of hanging on queue.length > 0 in checkDone().
  it("drains queued findings to error verdicts when last worker crashes (no-restart)", async () => {
    const onResult = vi.fn();
    const factory = vi.fn(() => makeFakeWorker());
    const pool = new WorkerPool({
      size: 1,
      factory: factory as any,
      serializedConfig: config,
      tracingEnabled: false,
      onEvent: () => {},
      onResult,
      graphBridge: null as any,
      workerRestart: false,
    });

    const finding = { check_id: "r" } as any;
    pool.enqueue([
      { finding, fingerprint: "fp-inflight" },
      { finding, fingerprint: "fp-queued-1" },
      { finding, fingerprint: "fp-queued-2" },
    ]);

    const runP = pool.run();

    const w = factory.mock.results[0].value;
    w._msgFromWorker({ kind: "request_task" }); // pulls fp-inflight, leaves 2 in queue
    w._emit("close", { code: 1 });

    // run() must resolve — race against a short timeout to fail fast on a hang.
    await Promise.race([
      runP,
      new Promise((_, rej) => setTimeout(() => rej(new Error("pool.run() hung after crash")), 1000)),
    ]);

    const fingerprints = onResult.mock.calls.map((c) => c[0]).sort();
    expect(fingerprints).toEqual(["fp-inflight", "fp-queued-1", "fp-queued-2"]);
    for (const [, result] of onResult.mock.calls) {
      expect(result.verdict.verdict).toBe("error");
    }
  });

  // Bug 2 regression: handleCrash must mark the slot as expectedShutdown so
  // a subsequent close event for the same crash is a no-op. Without the fix,
  // the second handleCrash call enters checkDone which posts shutdown to the
  // dead worker and (under real Bun) throws InvalidStateError before reaching
  // resolveDone. The fake worker's postMessage doesn't throw, so we assert on
  // the observable: only one error verdict is emitted and run() resolves.
  it("ignores duplicate crash events (error + close) for the same slot", async () => {
    const onResult = vi.fn();
    const factory = vi.fn(() => makeFakeWorker());
    const pool = new WorkerPool({
      size: 1,
      factory: factory as any,
      serializedConfig: config,
      tracingEnabled: false,
      onEvent: () => {},
      onResult,
      graphBridge: null as any,
      workerRestart: false,
    });

    const finding = { check_id: "r" } as any;
    pool.enqueue([{ finding, fingerprint: "fp-once" }]);
    const runP = pool.run();

    const w = factory.mock.results[0].value;
    w._msgFromWorker({ kind: "request_task" });
    w._emit("error", { message: "boom" });
    w._emit("close", { code: 1 });

    await Promise.race([
      runP,
      new Promise((_, rej) => setTimeout(() => rej(new Error("pool.run() hung")), 1000)),
    ]);

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(
      "fp-once",
      expect.objectContaining({ verdict: expect.objectContaining({ verdict: "error" }) }),
    );
    const shutdownPosts = w.postMessage.mock.calls.filter(
      (c: any[]) => c[0]?.kind === "shutdown",
    );
    expect(shutdownPosts).toHaveLength(0);
  });

  // Bug 2 regression: checkDone() must not postMessage shutdown to a crashed
  // worker (which would throw InvalidStateError under real Bun and prevent
  // resolveDone). The fix marks the crashed slot as expectedShutdown so the
  // existing skip in checkDone takes effect.
  it("does not post shutdown to a crashed worker after handleCrash", async () => {
    const onResult = vi.fn();
    const factory = vi.fn(() => makeFakeWorker());
    const pool = new WorkerPool({
      size: 1,
      factory: factory as any,
      serializedConfig: config,
      tracingEnabled: false,
      onEvent: () => {},
      onResult,
      graphBridge: null as any,
      workerRestart: false,
    });

    const finding = { check_id: "r" } as any;
    pool.enqueue([{ finding, fingerprint: "fp-only" }]);
    const runP = pool.run();

    const w = factory.mock.results[0].value;
    w._msgFromWorker({ kind: "request_task" });
    w._emit("close", { code: 1 });

    await Promise.race([
      runP,
      new Promise((_, rej) => setTimeout(() => rej(new Error("pool.run() hung after crash")), 1000)),
    ]);

    const shutdownPosts = w.postMessage.mock.calls.filter(
      (c: any[]) => c[0]?.kind === "shutdown",
    );
    expect(shutdownPosts).toHaveLength(0);
  });
});
