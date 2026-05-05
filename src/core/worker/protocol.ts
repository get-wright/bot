import type { Finding } from "../models/finding.js";
import type { AgentEvent } from "../models/events.js";
import type { NodeInfo, QueryGraphArgs, SearchSymbolArgs } from "../../infra/graph/types.js";
import type { TriageResult } from "../triage/orchestrator.js";
import type { ReadRegistrySeed } from "../agent/tools/read.js";

export type GraphMethod = "queryGraph" | "searchSymbol";

export interface SerializedConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxSteps: number;
  allowBash: boolean;
  reasoningEffort?: "low" | "medium" | "high";
  concurrency: number;
}

export type ToWorker =
  | {
      kind: "init";
      workerId: number;
      serializedConfig: SerializedConfig;
      tracingEnabled: boolean;
      langsmithProject?: string;
      // Absolute path to a per-worker debug log file. Undefined disables
      // worker-side logging (main keeps its own `debug.log`).
      logPath?: string;
      // True when main has a real GraphClient. The worker only constructs
      // the WorkerGraphClient stub (and registers query_graph/search_symbol
      // tools) when this is true — otherwise those tools would call into a
      // GraphBridge that always returns [] and waste agent tokens.
      graphEnabled: boolean;
    }
  | {
      kind: "task";
      finding: Finding;
      fingerprint: string;
      graphContext?: string;
      initialCodeContext?: string | null;
      initialReadRegistrySeeds?: ReadRegistrySeed[];
      focusedReadHint?: string | null;
    }
  | {
      kind: "graph_response";
      rpcId: string;
      ok: true;
      result: NodeInfo[];
    }
  | {
      kind: "graph_response";
      rpcId: string;
      ok: false;
      error: string;
    }
  | { kind: "abort" }
  | { kind: "shutdown" };

export type FromWorker =
  | { kind: "ready" }
  | { kind: "request_task" }
  | { kind: "event"; fingerprint: string; event: AgentEvent }
  | { kind: "result"; fingerprint: string; result: TriageResult }
  | {
      kind: "graph_request";
      rpcId: string;
      method: GraphMethod;
      args: QueryGraphArgs | SearchSymbolArgs;
    }
  | { kind: "fatal"; error: string };
