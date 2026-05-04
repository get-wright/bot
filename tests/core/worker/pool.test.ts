import { describe, it, expect, vi } from "vitest";
import { WorkerPool } from "../../../src/core/worker/pool.js";
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
});
