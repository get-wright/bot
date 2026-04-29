import { describe, it, expect } from "vitest";
import type { AgentLoopConfig } from "../../src/core/agent/loop.js";
import type { AgentEvent } from "../../src/models/events.js";
import { FindingSchema } from "../../src/models/finding.js";

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

describe("runAgentLoop", () => {
  it("exports runAgentLoop function", async () => {
    const { runAgentLoop } = await import("../../src/core/agent/loop.js");
    expect(typeof runAgentLoop).toBe("function");
  });

  it("accepts valid config shape", () => {
    const events: AgentEvent[] = [];
    const config: AgentLoopConfig = {
      finding: TEST_FINDING,
      projectRoot: "/tmp",
      provider: "openai",
      model: "gpt-4o",
      maxSteps: 2,
      allowBash: false,
      onEvent: (event) => events.push(event),
      memoryHints: [],
    };
    expect(config.maxSteps).toBe(2);
    expect(config.allowBash).toBe(false);
  });
});
