import { describe, it, expect } from "vitest";
import { buildFollowUpMessages } from "../../src/core/agent/follow-up.js";
import { FindingSchema } from "../../src/core/models/finding.js";
import type { TriageVerdict } from "../../src/core/models/verdict.js";

const TEST_FINDING = FindingSchema.parse({
  check_id: "test.rule",
  path: "src/app.py",
  start: { line: 10, col: 1 },
  end: { line: 10, col: 20 },
  extra: {
    message: "Test finding",
    severity: "ERROR",
    metadata: { cwe: ["CWE-89"], confidence: "HIGH", category: "security" },
    lines: "cursor.execute(sql)",
    metavars: {},
  },
});

const TEST_VERDICT: TriageVerdict = {
  verdict: "false_positive",
  reasoning: "The SQL query uses parameterized inputs.",
  key_evidence: ["Line 10 uses parameterized query"],
};

describe("buildFollowUpMessages", () => {
  it("builds messages with finding context, verdict, and user question", () => {
    const messages = buildFollowUpMessages(TEST_FINDING, TEST_VERDICT, "Why is this safe?");
    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toContain("test.rule");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toContain("false_positive");
    expect(messages[1]!.content).toContain("parameterized inputs");
    expect(messages[2]!.role).toBe("user");
    expect(messages[2]!.content).toBe("Why is this safe?");
  });

  it("accumulates prior follow-ups", () => {
    const priorExchanges = [
      { question: "Is the input validated?", answer: "Yes, via Pydantic model." },
    ];
    const messages = buildFollowUpMessages(
      TEST_FINDING,
      TEST_VERDICT,
      "What about edge cases?",
      priorExchanges,
    );
    expect(messages).toHaveLength(5);
    expect(messages[2]!.role).toBe("user");
    expect(messages[2]!.content).toBe("Is the input validated?");
    expect(messages[3]!.role).toBe("assistant");
    expect(messages[3]!.content).toBe("Yes, via Pydantic model.");
    expect(messages[4]!.role).toBe("user");
    expect(messages[4]!.content).toBe("What about edge cases?");
  });
});
