import { z } from "zod";

export const VerdictValue = z.enum(["true_positive", "false_positive", "needs_review"]);
export type VerdictValue = z.infer<typeof VerdictValue>;

// Accept string or string[] and normalize to string[]
const StringOrArray = z.union([
  z.array(z.string()),
  z.string().transform((s) => s.split("\n").map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean)),
]);

export const TriageVerdictSchema = z.object({
  verdict: VerdictValue,
  reasoning: z.string().default(""),
  key_evidence: StringOrArray.default([]),
  suggested_fix: z.string().optional(),
});
export type TriageVerdict = z.infer<typeof TriageVerdictSchema>;
