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
