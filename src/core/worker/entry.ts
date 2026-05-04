/// <reference lib="dom" />
declare const self: Worker;

import type { ToWorker, FromWorker, SerializedConfig } from "./protocol.js";
import { initTracing } from "../../infra/tracing.js";
import { WorkerGraphClient } from "./graph-stub.js";

let serializedConfig: SerializedConfig | null = null;
let graphStub: WorkerGraphClient | null = null;
let aborted = false;

function send(msg: FromWorker): void {
  postMessage(msg);
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
      // Filled in by Task 8.
      send({ kind: "fatal", error: "task handler not implemented" });
      return;
    }
  }
};

// Surface uncaught errors as fatal messages so main can apply restart policy.
self.addEventListener("error", (e: ErrorEvent) => {
  send({ kind: "fatal", error: e.message });
});

export {}; // ensure module
