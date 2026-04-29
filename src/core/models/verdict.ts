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
  verdict: VerdictValue.describe("Final verdict: true_positive, false_positive, or needs_review"),
  reasoning: z.string().default("").describe("Plain text analysis explaining WHY this verdict was reached. Focus on the data flow and security logic. Do NOT include evidence lists or fix suggestions here — use the dedicated fields below."),
  key_evidence: StringOrArray.default([]).describe("Short evidence items as an array of strings. Each item is one fact: a line number, code pattern, or protection found. Do NOT duplicate the reasoning text."),
  suggested_fix: z.string().optional().describe("Concrete fix suggestion. Only if verdict is true_positive."),
});
export type TriageVerdict = z.infer<typeof TriageVerdictSchema>;
