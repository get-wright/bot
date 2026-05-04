import type { Finding } from "../models/finding.js";
import type { AgentEvent } from "../models/events.js";
import type { NodeInfo, QueryGraphArgs, SearchSymbolArgs } from "../../infra/graph/types.js";
import type { TriageResult } from "../triage/orchestrator.js";

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
      serializedConfig: SerializedConfig;
      tracingEnabled: boolean;
      langsmithProject?: string;
    }
  | {
      kind: "task";
      finding: Finding;
      fingerprint: string;
      graphContext?: string;
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
