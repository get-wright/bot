import type { TriageVerdict } from "./verdict.js";

export type AgentEvent =
  | { type: "tool_start"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; summary: string; full: string; durationMs: number; success: boolean }
  | { type: "thinking"; delta: string }
  | { type: "verdict"; verdict: TriageVerdict }
  | { type: "error"; message: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
    }
  | { type: "followup_start"; question: string };
