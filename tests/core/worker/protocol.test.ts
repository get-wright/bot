import { describe, it, expect } from "vitest";
import type {
  ToWorker,
  FromWorker,
  GraphMethod,
} from "../../../src/core/worker/protocol.js";

describe("worker protocol", () => {
  it("ToWorker init carries tracingEnabled and serialized config", () => {
    const msg: ToWorker = {
      kind: "init",
      tracingEnabled: false,
      serializedConfig: { provider: "openai", model: "gpt-4o" } as any,
    };
    expect(msg.kind).toBe("init");
  });

  it("FromWorker graph_request requires method and rpcId", () => {
    const msg: FromWorker = {
      kind: "graph_request",
      rpcId: "abc",
      method: "queryGraph",
      args: { pattern: "callers_of", target: "foo" } as any,
    };
    expect(msg.method).toBe("queryGraph");
  });

  it("GraphMethod is a closed union", () => {
    const m1: GraphMethod = "queryGraph";
    const m2: GraphMethod = "searchSymbol";
    expect([m1, m2]).toEqual(["queryGraph", "searchSymbol"]);
  });
});
