import { describe, expect, it } from "vitest";
import type { Finding } from "../../../src/core/models/finding.js";
import { formatFindingMessage, SYSTEM_PROMPT } from "../../../src/core/agent/system-prompt.js";

function finding(): Finding {
  return {
    check_id: "test.rule",
    path: "src/server.js",
    start: { line: 20, col: 1 },
    end: { line: 20, col: 10 },
    extra: {
      message: "eval with expression",
      severity: "WARNING",
      metadata: { cwe: ["CWE-95"] },
      lines: "eval(input)",
      dataflow_trace: undefined,
    },
  } as Finding;
}

describe("formatFindingMessage", () => {
  it("includes initial focused code context when provided", () => {
    const message = formatFindingMessage(finding(), {
      initialCodeContext: "15\tfunction handler(input) {\n20\t  eval(input);\n25\t}",
    });

    expect(message).toContain("## Initial focused code context");
    expect(message).toContain("smallest graph-resolved function/method");
    expect(message).toContain("20\t  eval(input);");
  });

  it("omits initial focused code context when absent", () => {
    const message = formatFindingMessage(finding());
    expect(message).not.toContain("## Initial focused code context");
  });
});

describe("SYSTEM_PROMPT", () => {
  it("instructs the model not to duplicate focused reads", () => {
    expect(SYSTEM_PROMPT).toContain("If initial focused code context is provided");
    expect(SYSTEM_PROMPT).toContain("do not immediately repeat that read");
  });
});
