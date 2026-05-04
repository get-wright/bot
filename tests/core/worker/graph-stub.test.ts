import { describe, it, expect } from "vitest";
import { WorkerGraphClient } from "../../../src/core/worker/graph-stub.js";
import type { FromWorker } from "../../../src/core/worker/protocol.js";

describe("WorkerGraphClient", () => {
  it("queryGraph posts a graph_request and resolves on graph_response", async () => {
    const sent: FromWorker[] = [];
    const stub = new WorkerGraphClient((msg) => sent.push(msg as FromWorker));

    const promise = stub.queryGraph({ pattern: "callers_of", target: "foo" } as any);

    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.kind).toBe("graph_request");
    expect((req as any).method).toBe("queryGraph");
    expect((req as any).args).toEqual({ pattern: "callers_of", target: "foo" });

    const rpcId = (req as any).rpcId as string;
    stub.resolveRpc(rpcId, true, [{ name: "n1" } as any]);

    await expect(promise).resolves.toEqual([{ name: "n1" }]);
  });

  it("searchSymbol routes through method='searchSymbol'", async () => {
    const sent: FromWorker[] = [];
    const stub = new WorkerGraphClient((msg) => sent.push(msg as FromWorker));

    const promise = stub.searchSymbol({ query: "auth", topK: 3 } as any);
    const req = sent[0]!;
    expect((req as any).method).toBe("searchSymbol");

    stub.resolveRpc((req as any).rpcId, true, []);
    await expect(promise).resolves.toEqual([]);
  });

  it("graph_response with ok=false rejects the pending promise", async () => {
    const sent: FromWorker[] = [];
    const stub = new WorkerGraphClient((msg) => sent.push(msg as FromWorker));

    const promise = stub.queryGraph({ pattern: "callers_of", target: "x" } as any);
    const rpcId = (sent[0] as any).rpcId;
    stub.resolveRpc(rpcId, false, "graph offline");

    await expect(promise).rejects.toThrow("graph offline");
  });

  it("close is a no-op resolving void", async () => {
    const stub = new WorkerGraphClient(() => {});
    await expect(stub.close()).resolves.toBeUndefined();
  });
});
