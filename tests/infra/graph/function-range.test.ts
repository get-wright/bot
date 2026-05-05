import { describe, expect, it, vi } from "vitest";
import type { Finding } from "../../../src/core/models/finding.js";
import type { GraphClient, NodeInfo } from "../../../src/infra/graph/index.js";
import { resolveEnclosingFunctionRange, resolveEnclosingFunctionRangeFromSummary } from "../../../src/infra/graph/function-range.js";

function findingAt(line: number): Finding {
  return {
    check_id: "test.rule",
    path: "src/server.js",
    start: { line, col: 1 },
    end: { line, col: 20 },
    extra: {
      message: "test finding",
      severity: "ERROR",
      lines: "eval(input)",
      metadata: { cwe: ["CWE-95"] },
      dataflow_trace: undefined,
    },
  } as Finding;
}

function node(overrides: Partial<NodeInfo>): NodeInfo {
  return {
    name: "handler",
    qualified_name: "src/server.js::handler",
    kind: "Function",
    file_path: "/repo/src/server.js",
    line_start: 10,
    line_end: 30,
    params: undefined,
    return_type: undefined,
    ...overrides,
  } as NodeInfo;
}

function graphClient(nodes: NodeInfo[]): GraphClient {
  return {
    queryGraph: vi.fn(async (args) => {
      expect(args).toEqual({ pattern: "file_summary", target: "src/server.js" });
      return nodes;
    }),
    searchSymbol: vi.fn(async () => []),
    close: vi.fn(),
  } as unknown as GraphClient;
}

describe("resolveEnclosingFunctionRangeFromSummary", () => {
  it("returns exact read range for the function containing the finding line", () => {
    const result = resolveEnclosingFunctionRangeFromSummary(findingAt(20), [
      node({ line_start: 10, line_end: 30 }),
    ]);

    expect(result).toEqual({
      path: "src/server.js",
      qualifiedName: "src/server.js::handler",
      kind: "Function",
      lineStart: 10,
      lineEnd: 30,
      readOffset: 10,
      readLimit: 21,
    });
  });

  it("chooses the smallest enclosing function-like node", () => {
    const result = resolveEnclosingFunctionRangeFromSummary(findingAt(18), [
      node({ name: "Controller", qualified_name: "src/server.js::Controller", kind: "class", line_start: 1, line_end: 100 }),
      node({ name: "handler", qualified_name: "src/server.js::Controller::handler", kind: "Method", line_start: 15, line_end: 25 }),
      node({ name: "outer", qualified_name: "src/server.js::outer", kind: "Function", line_start: 10, line_end: 50 }),
    ]);

    expect(result?.qualifiedName).toBe("src/server.js::Controller::handler");
    expect(result?.lineStart).toBe(15);
    expect(result?.lineEnd).toBe(25);
  });

  it("returns null when no function or method contains the finding line", () => {
    const result = resolveEnclosingFunctionRangeFromSummary(findingAt(80), [
      node({ line_start: 10, line_end: 30 }),
    ]);

    expect(result).toBeNull();
  });
});

describe("resolveEnclosingFunctionRange", () => {
  it("queries file_summary once and resolves from that summary", async () => {
    const client = graphClient([node({ line_start: 10, line_end: 30 })]);
    const result = await resolveEnclosingFunctionRange(findingAt(20), client);

    expect(result?.readOffset).toBe(10);
    expect(result?.readLimit).toBe(21);
    expect(client.queryGraph).toHaveBeenCalledTimes(1);
  });
});
