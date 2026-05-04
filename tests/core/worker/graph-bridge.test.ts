import { describe, it, expect, vi } from "vitest";
import { GraphBridge } from "../../../src/core/worker/graph-bridge.js";
import type { GraphClient } from "../../../src/infra/graph/mcp-client.js";
import type { ToWorker } from "../../../src/core/worker/protocol.js";

function fakeGraphClient(impl: Partial<GraphClient>): GraphClient {
  return {
    queryGraph: vi.fn(async () => []),
    searchSymbol: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    ...impl,
  } as GraphClient;
}

describe("GraphBridge", () => {
  it("routes queryGraph and posts graph_response", async () => {
    const sent: ToWorker[] = [];
    const worker = { postMessage: (m: ToWorker) => sent.push(m) };
    const client = fakeGraphClient({
      queryGraph: vi.fn(async () => [{ name: "x" } as any]),
    });
    const bridge = new GraphBridge(client);

    await bridge.handle(worker as any, {
      kind: "graph_request",
      rpcId: "r1",
      method: "queryGraph",
      args: { pattern: "callers_of", target: "x" } as any,
    });

    expect(client.queryGraph).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      kind: "graph_response",
      rpcId: "r1",
      ok: true,
      result: [{ name: "x" }],
    });
  });

  it("routes searchSymbol", async () => {
    const sent: ToWorker[] = [];
    const worker = { postMessage: (m: ToWorker) => sent.push(m) };
    const client = fakeGraphClient({
      searchSymbol: vi.fn(async () => [{ name: "y" } as any]),
    });
    const bridge = new GraphBridge(client);

    await bridge.handle(worker as any, {
      kind: "graph_request",
      rpcId: "r2",
      method: "searchSymbol",
      args: { query: "y" } as any,
    });

    expect(client.searchSymbol).toHaveBeenCalledOnce();
    expect((sent[0] as any).result).toEqual([{ name: "y" }]);
  });

  it("graph errors become ok:false responses", async () => {
    const sent: ToWorker[] = [];
    const worker = { postMessage: (m: ToWorker) => sent.push(m) };
    const client = fakeGraphClient({
      queryGraph: vi.fn(async () => { throw new Error("boom"); }),
    });
    const bridge = new GraphBridge(client);

    await bridge.handle(worker as any, {
      kind: "graph_request",
      rpcId: "r3",
      method: "queryGraph",
      args: { pattern: "callers_of", target: "x" } as any,
    });

    expect(sent[0]).toEqual({
      kind: "graph_response",
      rpcId: "r3",
      ok: false,
      error: "boom",
    });
  });

  it("returns empty result when graphClient is null", async () => {
    const sent: ToWorker[] = [];
    const worker = { postMessage: (m: ToWorker) => sent.push(m) };
    const bridge = new GraphBridge(null);

    await bridge.handle(worker as any, {
      kind: "graph_request",
      rpcId: "r4",
      method: "queryGraph",
      args: { pattern: "callers_of", target: "x" } as any,
    });

    expect(sent[0]).toEqual({
      kind: "graph_response",
      rpcId: "r4",
      ok: true,
      result: [],
    });
  });
});
