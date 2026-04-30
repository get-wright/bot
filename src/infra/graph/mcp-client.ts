import { existsSync } from "node:fs";
// v1.x stable import paths. v2 alpha splits into @modelcontextprotocol/client
// and @modelcontextprotocol/server with different paths — see package.json pin.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  NodeInfoSchema,
  type NodeInfo,
  type QueryGraphArgs,
  type SearchSymbolArgs,
} from "./types.js";

export interface GraphClient {
  queryGraph(args: QueryGraphArgs): Promise<NodeInfo[]>;
  searchSymbol(args: SearchSymbolArgs): Promise<NodeInfo[]>;
  close(): Promise<void>;
}

export interface CreateGraphClientOptions {
  repoRoot: string;
  binaryPath?: string;
  skipExistsCheck?: boolean;
}

export async function createGraphClient(opts: CreateGraphClientOptions): Promise<GraphClient | null> {
  const binary = opts.binaryPath ?? "code-review-graph";

  if (binary.includes("/") && !opts.skipExistsCheck && !existsSync(binary)) {
    return null;
  }

  let client: Client;
  try {
    const transport = new StdioClientTransport({
      command: binary,
      args: ["serve"],
      cwd: opts.repoRoot,
    });
    client = new Client({ name: "sast-triage", version: "0.1.0" });
    await client.connect(transport);
  } catch {
    return null;
  }

  async function callAndParse(toolName: string, args: Record<string, unknown>): Promise<NodeInfo[]> {
    let result: unknown;
    try {
      result = await client.callTool({ name: toolName, arguments: args });
    } catch (e) {
      console.error(`[graph] ${toolName} call failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
    if (!Array.isArray(content)) return [];
    const block = content.find(c => c.type === "text");
    if (!block || !block.text) return [];
    let payload: unknown;
    try {
      payload = JSON.parse(block.text);
    } catch {
      return [];
    }
    const nodes = (payload as { nodes?: unknown[] }).nodes;
    if (!Array.isArray(nodes)) return [];
    const parsed: NodeInfo[] = [];
    for (const n of nodes) {
      const r = NodeInfoSchema.safeParse(n);
      if (r.success) parsed.push(r.data);
    }
    return parsed;
  }

  return {
    queryGraph: (args) => callAndParse("query_graph_tool", args),
    searchSymbol: ({ query, topK }) => callAndParse("semantic_search_nodes_tool", { query, top_k: topK ?? 5 }),
    close: async () => {
      try { await client.close(); } catch { /* swallow shutdown errors */ }
    },
  };
}
