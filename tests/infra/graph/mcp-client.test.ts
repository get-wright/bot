import { describe, it, expect, vi } from "vitest";
import { createGraphClient } from "../../../src/infra/graph/mcp-client.js";

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}));

describe("createGraphClient", () => {
  it("returns null when code-review-graph binary is not on PATH", async () => {
    const client = await createGraphClient({
      repoRoot: "/tmp",
      binaryPath: "/nonexistent/code-review-graph",
    });
    expect(client).toBeNull();
  });

  it("queryGraph returns parsed NodeInfo array on success", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const mockCallTool = vi.fn().mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          nodes: [{
            name: "fooFn",
            qualified_name: "src/foo.ts::fooFn",
            kind: "function",
            file_path: "src/foo.ts",
            line_start: 10,
            line_end: 25,
          }],
        }),
      }],
    });
    (Client as unknown as { mockImplementation: (fn: () => unknown) => void })
      .mockImplementation(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: mockCallTool,
        close: vi.fn().mockResolvedValue(undefined),
      }));

    const client = await createGraphClient({
      repoRoot: "/tmp",
      binaryPath: "/some/code-review-graph",
      skipExistsCheck: true,
    });
    expect(client).not.toBeNull();

    const results = await client!.queryGraph({ pattern: "callers_of", target: "fooFn" });
    expect(results).toHaveLength(1);
    expect(results[0].file_path).toBe("src/foo.ts");
    expect(results[0].line_start).toBe(10);
    expect(mockCallTool).toHaveBeenCalledWith(expect.objectContaining({
      name: "query_graph_tool",
      arguments: expect.objectContaining({ pattern: "callers_of", target: "fooFn" }),
    }));

    await client!.close();
  });

  it("returns empty array when MCP returns no nodes", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    (Client as unknown as { mockImplementation: (fn: () => unknown) => void })
      .mockImplementation(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: JSON.stringify({ nodes: [] }) }],
        }),
        close: vi.fn().mockResolvedValue(undefined),
      }));

    const client = await createGraphClient({
      repoRoot: "/tmp",
      binaryPath: "/x/code-review-graph",
      skipExistsCheck: true,
    });
    const results = await client!.searchSymbol({ query: "nothingMatches" });
    expect(results).toEqual([]);
  });

  it("returns [] (does not throw) when callTool rejects — best-effort failure contract", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    (Client as unknown as { mockImplementation: (fn: () => unknown) => void })
      .mockImplementation(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockRejectedValue(new Error("MCP transport closed")),
        close: vi.fn().mockResolvedValue(undefined),
      }));

    const client = await createGraphClient({
      repoRoot: "/tmp",
      binaryPath: "/x/code-review-graph",
      skipExistsCheck: true,
    });
    await expect(client!.queryGraph({ pattern: "callers_of", target: "x" })).resolves.toEqual([]);
  });

  it("returns [] when JSON parse fails", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    (Client as unknown as { mockImplementation: (fn: () => unknown) => void })
      .mockImplementation(() => ({
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "not-valid-json{" }],
        }),
        close: vi.fn().mockResolvedValue(undefined),
      }));

    const client = await createGraphClient({
      repoRoot: "/tmp",
      binaryPath: "/x/code-review-graph",
      skipExistsCheck: true,
    });
    await expect(client!.searchSymbol({ query: "x" })).resolves.toEqual([]);
  });
});
