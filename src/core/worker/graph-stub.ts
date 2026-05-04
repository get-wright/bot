import type { GraphClient } from "../../infra/graph/mcp-client.js";
import type { NodeInfo, QueryGraphArgs, SearchSymbolArgs } from "../../infra/graph/types.js";
import type { FromWorker, GraphMethod } from "./protocol.js";

type Pending = { resolve: (v: NodeInfo[]) => void; reject: (e: Error) => void };

export class WorkerGraphClient implements GraphClient {
  private rpcs = new Map<string, Pending>();
  private send: (msg: FromWorker) => void;

  constructor(send: (msg: FromWorker) => void) {
    this.send = send;
  }

  queryGraph(args: QueryGraphArgs): Promise<NodeInfo[]> {
    return this.rpc("queryGraph", args);
  }

  searchSymbol(args: SearchSymbolArgs): Promise<NodeInfo[]> {
    return this.rpc("searchSymbol", args);
  }

  async close(): Promise<void> {
    /* main owns the real client */
  }

  resolveRpc(rpcId: string, ok: boolean, payload: NodeInfo[] | string): void {
    const pending = this.rpcs.get(rpcId);
    if (!pending) return;
    this.rpcs.delete(rpcId);
    if (ok) pending.resolve(payload as NodeInfo[]);
    else pending.reject(new Error(payload as string));
  }

  private rpc(method: GraphMethod, args: QueryGraphArgs | SearchSymbolArgs): Promise<NodeInfo[]> {
    const rpcId = crypto.randomUUID();
    return new Promise<NodeInfo[]>((resolve, reject) => {
      this.rpcs.set(rpcId, { resolve, reject });
      this.send({ kind: "graph_request", rpcId, method, args });
    });
  }
}
