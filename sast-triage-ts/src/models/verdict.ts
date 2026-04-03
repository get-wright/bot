import { z } from "zod";

export const VerdictValue = z.enum(["true_positive", "false_positive", "needs_review"]);
export type VerdictValue = z.infer<typeof VerdictValue>;

export const TriageVerdictSchema = z.object({
  verdict: VerdictValue,
  reasoning: z.string(),
  key_evidence: z.array(z.string()),
  suggested_fix: z.string().optional(),
});
export type TriageVerdict = z.infer<typeof TriageVerdictSchema>;
