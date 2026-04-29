import { TriageVerdictSchema, type TriageVerdict } from "../../models/verdict.js";

export interface VerdictToolInput {
  verdict: TriageVerdict["verdict"];
  reasoning: string;
  key_evidence: string[];
  suggested_fix?: string;
}

export interface VerdictTool {
  execute(input: VerdictToolInput): Promise<TriageVerdict>;
}

export function createVerdictTool(): VerdictTool {
  return {
    async execute(input: VerdictToolInput): Promise<TriageVerdict> {
      return TriageVerdictSchema.parse(input);
    },
  };
}
