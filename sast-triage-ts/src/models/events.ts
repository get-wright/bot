import type { TriageVerdict } from "./verdict.js";

export type AgentEvent =
  | { type: "tool_start"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; summary: string; full: string }
  | { type: "thinking"; delta: string }
  | { type: "verdict"; verdict: TriageVerdict }
  | { type: "error"; message: string };
