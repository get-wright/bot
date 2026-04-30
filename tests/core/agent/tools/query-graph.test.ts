import { describe, it, expect, vi } from "vitest";
import { createQueryGraphTool, createSearchSymbolTool } from "../../../../src/core/agent/tools/query-graph.js";
import type { GraphClient } from "../../../../src/infra/graph/index.js";

function mockClient(nodes: unknown[]): GraphClient {
  return {
    queryGraph: vi.fn().mockResolvedValue(nodes),
    searchSymbol: vi.fn().mockResolvedValue(nodes),
    close: vi.fn(),
  };
}

describe("createQueryGraphTool", () => {
  it("formats results as one line per node with file:line range", async () => {
    const client = mockClient([
      { name: "foo", qualified_name: "src/a.ts::foo", kind: "function", file_path: "src/a.ts", line_start: 10, line_end: 25, params: "(x: number)" },
      { name: "bar", qualified_name: "src/b.ts::bar", kind: "method",   file_path: "src/b.ts", line_start: 30, line_end: 45 },
    ]);
    const tool = createQueryGraphTool(client);
    const out = await tool.execute({ pattern: "callers_of", target: "foo" });
    expect(out).toContain("function src/a.ts::foo  src/a.ts:10-25  ((x: number))");
    expect(out).toContain("method src/b.ts::bar  src/b.ts:30-45");
  });

  it("returns explicit empty-result message", async () => {
    const client = mockClient([]);
    const tool = createQueryGraphTool(client);
    const out = await tool.execute({ pattern: "callers_of", target: "doesnotexist" });
    expect(out).toMatch(/No callers_of results for "doesnotexist"/);
  });
});

describe("createSearchSymbolTool", () => {
  it("formats results compactly", async () => {
    const client = mockClient([
      { name: "parseUser", qualified_name: "src/util.ts::parseUser", kind: "function", file_path: "src/util.ts", line_start: 5, line_end: 8 },
    ]);
    const tool = createSearchSymbolTool(client);
    const out = await tool.execute({ query: "parseUser", topK: 5 });
    expect(out).toContain("function src/util.ts::parseUser  src/util.ts:5-8");
  });
});
