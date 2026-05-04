import type { GraphClient } from "../../infra/graph/mcp-client.js";
import type { FromWorker, ToWorker } from "./protocol.js";

interface WorkerLike {
  postMessage(msg: ToWorker): void;
}

export class GraphBridge {
  constructor(private client: GraphClient | null) {}

  /** True when the bridge is backed by a real GraphClient. Used by the
   * pool to decide whether to ask workers to register graph tools. */
  get hasClient(): boolean {
    return this.client !== null;
  }

  async handle(
    worker: WorkerLike,
    req: Extract<FromWorker, { kind: "graph_request" }>,
  ): Promise<void> {
    if (!this.client) {
      worker.postMessage({ kind: "graph_response", rpcId: req.rpcId, ok: true, result: [] });
      return;
    }
    try {
      const result = req.method === "queryGraph"
        ? await this.client.queryGraph(req.args as any)
        : await this.client.searchSymbol(req.args as any);
      worker.postMessage({ kind: "graph_response", rpcId: req.rpcId, ok: true, result });
    } catch (err) {
      worker.postMessage({
        kind: "graph_response",
        rpcId: req.rpcId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
