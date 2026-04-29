import { describe, it, expect } from "vitest";
import { createVerdictTool } from "../../../src/core/agent/tools/verdict.js";

describe("createVerdictTool", () => {
  it("returns a parsed TriageVerdict for valid input", async () => {
    const tool = createVerdictTool();
    const result = await tool.execute({
      verdict: "true_positive",
      reasoning: "User input flows to SQL query without sanitization",
      key_evidence: ["cursor.execute(query)", "query uses f-string"],
      suggested_fix: "Use parameterized queries",
    });
    expect(result.verdict).toBe("true_positive");
    expect(result.reasoning).toContain("SQL");
    expect(result.key_evidence).toHaveLength(2);
    expect(result.suggested_fix).toBe("Use parameterized queries");
  });

  it("works without optional suggested_fix", async () => {
    const tool = createVerdictTool();
    const result = await tool.execute({
      verdict: "false_positive",
      reasoning: "ORM handles escaping automatically",
      key_evidence: ["Model.objects.filter()"],
    });
    expect(result.verdict).toBe("false_positive");
    expect(result.suggested_fix).toBeUndefined();
  });

  it("works with needs_review verdict", async () => {
    const tool = createVerdictTool();
    const result = await tool.execute({
      verdict: "needs_review",
      reasoning: "Cannot determine without seeing full sanitization pipeline",
      key_evidence: ["partial trace only"],
    });
    expect(result.verdict).toBe("needs_review");
  });

  it("throws on invalid verdict value", async () => {
    const tool = createVerdictTool();
    await expect(
      tool.execute({
        verdict: "maybe" as "true_positive",
        reasoning: "test",
        key_evidence: [],
      }),
    ).rejects.toThrow();
  });

  it("defaults reasoning and key_evidence when missing", async () => {
    const tool = createVerdictTool();
    const result = await tool.execute({
      verdict: "true_positive",
      // reasoning and key_evidence now have defaults
    } as Parameters<ReturnType<typeof createVerdictTool>["execute"]>[0]);
    expect(result.reasoning).toBe("");
    expect(result.key_evidence).toEqual([]);
  });
});
