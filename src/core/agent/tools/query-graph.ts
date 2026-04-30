import { tool } from "ai";
import { z } from "zod";
import type { GraphClient, NodeInfo } from "../../../infra/graph/index.js";

function formatNode(n: NodeInfo): string {
  const params = n.params ? `  (${n.params})` : "";
  return `${n.kind} ${n.qualified_name}  ${n.file_path}:${n.line_start}-${n.line_end}${params}`;
}

export function createQueryGraphTool(graphClient: GraphClient) {
  return tool({
    description:
      "Query the code knowledge graph for relationships. Use this BEFORE grep when " +
      "you need to find callers, callees, imports, children, or tests of a symbol. " +
      "Returns each result as 'kind qualified_name  file_path:line_start-line_end (params)'. " +
      "Then call read(file, offset=line_start, limit=line_end - line_start + 1) to fetch only the relevant function body.",
    inputSchema: z.object({
      pattern: z.enum([
        "callers_of", "callees_of", "imports_of",
        "importers_of", "children_of", "tests_for", "file_summary",
      ]).describe("Relationship type to query."),
      target: z.string().describe(
        "Function name (e.g. 'evalUserInput'), qualified name " +
        "(e.g. 'app/routes/contributions.js::handleContributionsUpdate'), " +
        "or file path (for file_summary / children_of).",
      ),
    }),
    execute: async ({ pattern, target }) => {
      const nodes = await graphClient.queryGraph({ pattern, target });
      if (nodes.length === 0) {
        return `No ${pattern} results for "${target}". Verify symbol exists with search_symbol or grep.`;
      }
      return nodes.map(formatNode).join("\n");
    },
  });
}

export function createSearchSymbolTool(graphClient: GraphClient) {
  return tool({
    description:
      "Find functions/classes by name or keyword across the indexed codebase. " +
      "Use when you have a symbol name from the finding but don't know which file it's in. " +
      "Prefer this over grep+read for symbol lookup. Returns each match as " +
      "'kind qualified_name  file_path:line_start-line_end'.",
    inputSchema: z.object({
      query: z.string().describe("Name or keyword (e.g. 'parseUser', 'eval')."),
      topK: z.number().int().min(1).max(20).optional().describe("Max results (default 5)."),
    }),
    execute: async ({ query, topK }) => {
      const nodes = await graphClient.searchSymbol({ query, topK });
      if (nodes.length === 0) {
        return `No symbols matching "${query}". Try grep on the source.`;
      }
      return nodes.map(formatNode).join("\n");
    },
  });
}
