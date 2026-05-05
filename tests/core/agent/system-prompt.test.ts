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
  it("includes a focused read hint without injecting code", () => {
    const message = formatFindingMessage(finding(), {
      focusedReadHint: '{"path":"src/server.js","offset":15,"limit":11}',
    });

    expect(message).toContain("## Suggested focused read");
    expect(message).toContain('{"path":"src/server.js","offset":15,"limit":11}');
    expect(message).not.toContain("## Initial focused code context");
    expect(message).not.toContain("eval(input);");
  });

  it("still supports explicit initial focused code context when provided", () => {
    const message = formatFindingMessage(finding(), {
      initialCodeContext: "15\tfunction handler(input) {\n20\t  eval(input);\n25\t}",
    });

    expect(message).toContain("## Initial focused code context");
    expect(message).toContain("20\t  eval(input);");
  });

  it("omits focused read sections when absent", () => {
    const message = formatFindingMessage(finding());
    expect(message).not.toContain("## Suggested focused read");
    expect(message).not.toContain("## Initial focused code context");
  });
});

describe("SYSTEM_PROMPT", () => {
  it("instructs the model to use focused read hints instead of whole-file reads", () => {
    expect(SYSTEM_PROMPT).toContain("For the first read:");
    expect(SYSTEM_PROMPT).toContain("If a suggested focused read JSON object is provided");
    expect(SYSTEM_PROMPT).toContain("call read with exactly those arguments");
  });
});
