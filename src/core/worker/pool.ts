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
  private done = false;
  private resolveDone: (() => void) | null = null;
  private rejectDone: ((err: Error) => void) | null = null;

  constructor(opts: WorkerPoolOptions) {
    this.opts = opts;
  }

  start(): void {
    for (let i = 0; i < this.opts.size; i++) {
      this.spawnSlot(i);
    }
  }

  private spawnSlot(id: number): void {
    const worker = this.opts.factory();
    const slot: Slot = {
      id,
      worker,
      inFlight: new Map(),
      expectedShutdown: false,
      restartCount: 0,
    };
    this.slots[id] = slot;
    this.attach(slot);
    worker.postMessage({
      kind: "init",
      serializedConfig: this.opts.serializedConfig,
      tracingEnabled: this.opts.tracingEnabled,
      langsmithProject: this.opts.langsmithProject,
    });
  }

  private attach(slot: Slot): void {
    slot.worker.onmessage = (event) => {
      this.onMessage(slot, event.data).catch((err) => {
        // Surface unexpected handler errors; don't silently swallow.
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
    // Filled in by Task 8 / 9. For now, only react to graph_request
    // (so the bridge works once Task 8 lands).
    if (msg.kind === "graph_request") {
      await this.opts.graphBridge.handle(slot.worker, msg);
    }
  }

  private handleCrash(_slot: Slot, _reason: string): void {
    // Filled in by Task 10.
  }

  shutdown(): void {
    this.done = true;
    for (const slot of this.slots) {
      slot.expectedShutdown = true;
      slot.worker.terminate();
    }
  }
}
