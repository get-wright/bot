/// <reference lib="dom" />
declare const self: Worker;

import type { ToWorker, FromWorker, SerializedConfig } from "./protocol.js";
import { initTracing } from "../../infra/tracing.js";
import { initLogger, log } from "../../infra/logger.js";
import { WorkerGraphClient } from "./graph-stub.js";
import { runAgentLoop } from "../agent/loop.js";

let workerId = -1;
let serializedConfig: SerializedConfig | null = null;
let graphStub: WorkerGraphClient | null = null;
let aborted = false;

function send(msg: FromWorker): void {
  postMessage(msg);
}

const STAGGER_MS = 500;
let runningSlots = 0;
let slotsRequested = 0;

function tryRequestTask(): void {
  if (!serializedConfig || aborted) return;
  if (runningSlots + slotsRequested >= serializedConfig.concurrency) return;
  slotsRequested++;
  send({ kind: "request_task" });
}

async function runFinding(
  finding: import("../models/finding.js").Finding,
  fingerprint: string,
  graphContext?: string,
): Promise<void> {
  if (!serializedConfig || !graphStub) throw new Error("worker not initialized");
  const result = await runAgentLoop({
    finding,
    projectRoot: process.cwd(),
    provider: serializedConfig.provider as any,
    model: serializedConfig.model,
    maxSteps: serializedConfig.maxSteps,
    allowBash: serializedConfig.allowBash,
    apiKey: serializedConfig.apiKey,
    baseUrl: serializedConfig.baseUrl,
    reasoningEffort: serializedConfig.reasoningEffort,
    graphClient: graphStub,
    graphContext,
    onEvent: (event) => send({ kind: "event", fingerprint, event }),
  });
  send({ kind: "result", fingerprint, result });
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  switch (msg.kind) {
    case "init": {
      workerId = msg.workerId;
      serializedConfig = msg.serializedConfig;
      graphStub = new WorkerGraphClient(send);
      // Per-worker debug log so concurrent appendFileSync calls don't
      // interleave lines across workers in a single shared file. The main
      // process owns its own `debug.log` separately.
      if (msg.logPath) {
        initLogger(msg.logPath);
        log.info("worker", "init", { workerId, concurrency: msg.serializedConfig.concurrency });
      }
      if (msg.tracingEnabled) {
        if (msg.langsmithProject) process.env.LANGSMITH_PROJECT = msg.langsmithProject;
        await initTracing();
      }
      send({ kind: "ready" });
      // Prime concurrency slots — pull one task per slot.
      for (let i = 0; i < (serializedConfig?.concurrency ?? 1); i++) {
        if (i > 0) await new Promise(r => setTimeout(r, STAGGER_MS));
        tryRequestTask();
      }
      return;
    }
    case "graph_response": {
      if (graphStub) {
        graphStub.resolveRpc(
          msg.rpcId,
          msg.ok,
          msg.ok ? msg.result : msg.error,
        );
      }
      return;
    }
    case "abort": {
      aborted = true;
      return;
    }
    case "shutdown": {
      // Bun does not expose an explicit close event; main calls worker.terminate()
      // which fires close with code 0 (clean). Just exit.
      // NOTE: process.exit() is not synchronous in Bun Workers — set aborted
      // and return to prevent switch fall-through to the "task" case, and to
      // block any subsequent messages from dispatching new work.
      aborted = true;
      process.exit(0);
      return;
    }
    case "task": {
      if (!serializedConfig || !graphStub) {
        send({ kind: "fatal", error: "task before init" });
        return;
      }
      slotsRequested = Math.max(0, slotsRequested - 1);
      runningSlots++;
      runFinding(msg.finding, msg.fingerprint, msg.graphContext)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          send({
            kind: "result",
            fingerprint: msg.fingerprint,
            result: {
              verdict: { verdict: "error", reasoning: message, key_evidence: [] },
              toolCalls: [],
              inputTokens: 0,
              outputTokens: 0,
            },
          });
        })
        .finally(() => {
          runningSlots--;
          tryRequestTask();
        });
      return;
    }
  }
};

// Surface uncaught errors as fatal messages so main can apply restart policy.
self.addEventListener("error", (e: ErrorEvent) => {
  send({ kind: "fatal", error: e.message });
});

export {}; // ensure module
