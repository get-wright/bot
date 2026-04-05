import { z } from "zod";

export const VerdictValue = z.enum(["true_positive", "false_positive", "needs_review"]);
export type VerdictValue = z.infer<typeof VerdictValue>;

// Accept string or string[] and normalize to string[]
const StringOrArray = z.union([
  z.array(z.string()),
  z.string().transform((s) => {
    // Handle JSON-stringified arrays: '["item1", "item2"]'
    const trimmed = s.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch { /* fall through to line split */ }
    }
    return s.split("\n").map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean);
  }),
]);

export const TriageVerdictSchema = z.object({
  verdict: VerdictValue,
  reasoning: z.string().default(""),
  key_evidence: StringOrArray.default([]),
  suggested_fix: z.string().optional(),
});
export type TriageVerdict = z.infer<typeof TriageVerdictSchema>;
