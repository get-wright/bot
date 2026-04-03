import { describe, it, expect } from "vitest";
import { formatEvent } from "../../src/headless/reporter.js";
import type { AgentEvent } from "../../src/models/events.js";

describe("formatEvent", () => {
  it("formats tool_start as NDJSON", () => {
    const event: AgentEvent = { type: "tool_start", tool: "read", args: { path: "src/app.py" } };
    const line = formatEvent(event, "abc123");
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("tool_start");
    expect(parsed.fingerprint).toBe("abc123");
    expect(parsed.tool).toBe("read");
  });

  it("formats verdict as NDJSON", () => {
    const event: AgentEvent = {
      type: "verdict",
      verdict: { verdict: "true_positive", reasoning: "SQL injection", key_evidence: ["cursor.execute(sql)"] },
    };
    const line = formatEvent(event, "abc123");
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("verdict");
    expect(parsed.verdict.verdict).toBe("true_positive");
  });

  it("each line is valid JSON (no newlines in output)", () => {
    const event: AgentEvent = { type: "thinking", delta: "multi\nline\nthinking" };
    const line = formatEvent(event, "fp1");
    expect(line.split("\n")).toHaveLength(1);
    expect(() => JSON.parse(line)).not.toThrow();
  });
});
