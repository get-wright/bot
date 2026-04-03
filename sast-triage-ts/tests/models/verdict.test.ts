import { describe, it, expect } from "vitest";
import { TriageVerdictSchema, type TriageVerdict } from "../../src/models/verdict.js";

describe("TriageVerdictSchema", () => {
  it("parses a valid true_positive verdict", () => {
    const v = TriageVerdictSchema.parse({
      verdict: "true_positive",
      reasoning: "User input flows directly to SQL",
      key_evidence: ["cursor.execute(sql)", "no parameterization"],
      suggested_fix: "Use parameterized query",
    });
    expect(v.verdict).toBe("true_positive");
    expect(v.key_evidence).toHaveLength(2);
    expect(v.suggested_fix).toBe("Use parameterized query");
  });

  it("parses a verdict without suggested_fix", () => {
    const v = TriageVerdictSchema.parse({
      verdict: "false_positive",
      reasoning: "ORM parameterized query",
      key_evidence: ["Model.objects.filter()"],
    });
    expect(v.suggested_fix).toBeUndefined();
  });

  it("rejects invalid verdict values", () => {
    expect(() =>
      TriageVerdictSchema.parse({ verdict: "maybe", reasoning: "test", key_evidence: [] }),
    ).toThrow();
  });

  it("requires reasoning and key_evidence", () => {
    expect(() => TriageVerdictSchema.parse({ verdict: "true_positive" })).toThrow();
  });
});
