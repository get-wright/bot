import type { Finding } from "../models/finding.js";
import type { AgentEvent } from "../models/events.js";
import type { TriageResult } from "../triage/orchestrator.js";
import type { GraphBridge } from "./graph-bridge.js";
import type { FromWorker, SerializedConfig, ToWorker } from "./protocol.js";

export interface WorkerLike {
  postMessage(msg: ToWorker): void;
  terminate(): void;
  onmessage: ((event: { data: FromWorker }) => void) | null;
  addEventListener(type: "error" | "close", listener: (event: any) => void): void;
}

export type WorkerFactory = () => WorkerLike;

export interface WorkerPoolOptions {
  size: number;
  factory: WorkerFactory;
  serializedConfig: SerializedConfig;
  tracingEnabled: boolean;
  langsmithProject?: string;
  graphBridge: GraphBridge;
  onEvent: (fingerprint: string, event: AgentEvent) => void;
  onResult: (fingerprint: string, result: TriageResult) => void;
  workerRestart?: boolean;
  // Optional directory to write per-worker debug logs into. When set, each
  // worker's init message receives `<logBaseDir>/debug-worker-<id>.log`,
  // keeping concurrent appendFileSync calls from interleaving across workers.
  logBaseDir?: string;
}

interface Slot {
  id: number;
  worker: WorkerLike;
  inFlight: Map<string, { finding: Finding; graphContext?: string }>;
  expectedShutdown: boolean;
  restartCount: number;
}

export class WorkerPool {
  private slots: Slot[] = [];
  private opts: WorkerPoolOptions;
  private queue: Array<{ finding: Finding; fingerprint: string; graphContext?: string }> = [];
  private resolveDone: (() => void) | null = null;
  private rejectDone: ((err: Error) => void) | null = null;
  private aborted = false;

  constructor(opts: WorkerPoolOptions) {
    this.opts = opts;
  }

  enqueue(tasks: Array<{ finding: Finding; fingerprint: string; graphContext?: string }>): void {
    this.queue.push(...tasks);
  }

  start(): void {
    for (let i = 0; i < this.opts.size; i++) {
      this.spawnSlot(i);
    }
  }

  run(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
      this.start();
      this.checkDone();
    });
  }

  private checkDone(): void {
    if (this.aborted) return;
    if (this.queue.length > 0) return;
    const allIdle = this.slots.every((s) => s.inFlight.size === 0);
    if (allIdle) {
      for (const s of this.slots) {
        // Skip slots already marked for shutdown to avoid posting to a
        // terminated worker (which throws InvalidStateError and would
        // prevent resolveDone from being called).
        if (s.expectedShutdown) continue;
        s.expectedShutdown = true;
        s.worker.postMessage({ kind: "shutdown" });
      }
      this.resolveDone?.();
    }
  }

  private spawnSlot(id: number, priorRestartCount = 0): void {
    const worker = this.opts.factory();
    const slot: Slot = {
      id,
      worker,
      inFlight: new Map(),
      expectedShutdown: false,
      restartCount: priorRestartCount,
    };
    this.slots[id] = slot;
    this.attach(slot);
    const logPath = this.opts.logBaseDir
      ? `${this.opts.logBaseDir}/debug-worker-${id}.log`
      : undefined;
    worker.postMessage({
      kind: "init",
      workerId: id,
      serializedConfig: this.opts.serializedConfig,
      tracingEnabled: this.opts.tracingEnabled,
      langsmithProject: this.opts.langsmithProject,
      logPath,
      graphEnabled: this.opts.graphBridge?.hasClient === true,
    });
  }

  private attach(slot: Slot): void {
    slot.worker.onmessage = (event) => {
      this.onMessage(slot, event.data).catch((err) => {
        console.error(`[worker-pool] handler error: ${err}`);
      });
    };
    slot.worker.addEventListener("error", (e: any) => {
      this.handleCrash(slot, e?.message ?? "worker error");
    });
    slot.worker.addEventListener("close", (e: any) => {
      const code = typeof e?.code === "number" ? e.code : 0;
      if (slot.expectedShutdown && code === 0) return;
      this.handleCrash(slot, `worker closed unexpectedly (code=${code})`);
    });
  }

  private async onMessage(slot: Slot, msg: FromWorker): Promise<void> {
    switch (msg.kind) {
      case "ready":
        return;
      case "request_task": {
        const next = this.queue.shift();
        if (!next) {
          // When a worker finishes its last task it sends both `result`
          // (handled below) and `request_task`. The result branch may have
          // already flagged this slot expectedShutdown via checkDone; in
          // that case the worker is being / has been told to shut down, so
          // posting another `shutdown` would either duplicate the message
          // or — under real Bun, after terminate() — throw InvalidStateError.
          if (slot.inFlight.size === 0 && !slot.expectedShutdown) {
            slot.expectedShutdown = true;
            slot.worker.postMessage({ kind: "shutdown" });
          }
          this.checkDone();
          return;
        }
        slot.inFlight.set(next.fingerprint, { finding: next.finding, graphContext: next.graphContext });
        slot.worker.postMessage({
          kind: "task",
          finding: next.finding,
          fingerprint: next.fingerprint,
          graphContext: next.graphContext,
        });
        return;
      }
      case "event":
        this.opts.onEvent(msg.fingerprint, msg.event);
        return;
      case "result":
        slot.inFlight.delete(msg.fingerprint);
        this.opts.onResult(msg.fingerprint, msg.result);
        this.checkDone();
        return;
      case "graph_request":
        await this.opts.graphBridge.handle(slot.worker, msg);
        return;
      case "fatal":
        this.handleCrash(slot, msg.error);
        return;
    }
  }

  private handleCrash(slot: Slot, reason: string): void {
    if (slot.expectedShutdown) return;
    // Mark the dead slot as shut down before any further work. This (a)
    // makes a follow-up `close` event for the same crash a no-op, (b)
    // prevents checkDone() from posting `shutdown` to the dead worker
    // (which throws InvalidStateError under Bun and would block
    // resolveDone), and (c) lets the alive-worker check below correctly
    // exclude this slot.
    slot.expectedShutdown = true;

    const restartAllowed = this.opts.workerRestart === true && slot.restartCount === 0;

    const drained = Array.from(slot.inFlight.entries());
    slot.inFlight.clear();

    if (!restartAllowed) {
      for (const [fp] of drained) {
        this.opts.onResult(fp, {
          verdict: { verdict: "error", reasoning: `worker crash: ${reason}`, key_evidence: [] },
          toolCalls: [],
          inputTokens: 0,
          outputTokens: 0,
        });
      }
      // If no alive worker remains to consume the queue, drain it now to
      // error verdicts. Otherwise checkDone() would block forever on
      // queue.length > 0 with no consumer, hanging run() and the CLI.
      const anyAlive = this.slots.some((s) => !s.expectedShutdown);
      if (!anyAlive && this.queue.length > 0) {
        const remaining = this.queue.splice(0, this.queue.length);
        for (const task of remaining) {
          this.opts.onResult(task.fingerprint, {
            verdict: {
              verdict: "error",
              reasoning: `worker pool exhausted: ${reason}`,
              key_evidence: [],
            },
            toolCalls: [],
            inputTokens: 0,
            outputTokens: 0,
          });
        }
      }
      this.checkDone();
      return;
    }

    for (const [fp, payload] of drained.reverse()) {
      this.queue.unshift({ finding: payload.finding, fingerprint: fp, graphContext: payload.graphContext });
    }
    slot.restartCount++;
    this.spawnSlot(slot.id, slot.restartCount);
  }

  shutdown(): void {
    this.aborted = true;
    for (const slot of this.slots) {
      slot.expectedShutdown = true;
      slot.worker.terminate();
    }
  }
}
