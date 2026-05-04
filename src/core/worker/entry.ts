/// <reference lib="dom" />
declare const self: Worker;

import type { ToWorker, FromWorker, SerializedConfig } from "./protocol.js";
import { initTracing } from "../../infra/tracing.js";
import { WorkerGraphClient } from "./graph-stub.js";
import { runAgentLoop } from "../agent/loop.js";

let serializedConfig: SerializedConfig | null = null;
let graphStub: WorkerGraphClient | null = null;
let aborted = false;

function send(msg: FromWorker): void {
  postMessage(msg);
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
  if (!aborted) send({ kind: "request_task" });
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  switch (msg.kind) {
    case "init": {
      serializedConfig = msg.serializedConfig;
      graphStub = new WorkerGraphClient(send);
      if (msg.tracingEnabled) {
        if (msg.langsmithProject) process.env.LANGSMITH_PROJECT = msg.langsmithProject;
        await initTracing();
      }
      send({ kind: "ready" });
      send({ kind: "request_task" });
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
      process.exit(0);
    }
    case "task": {
      if (!serializedConfig || !graphStub) {
        send({ kind: "fatal", error: "task before init" });
        return;
      }
      runFinding(msg.finding, msg.fingerprint, msg.graphContext).catch((err: unknown) => {
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
        send({ kind: "request_task" });
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
