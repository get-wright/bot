import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { createReadTool } from "./read.js";
import type { PreferredReadRange, ReadRegistry } from "./read.js";
import { createGrepTool } from "./grep.js";
import { createGlobTool } from "./glob.js";
import { createBashTool } from "./bash.js";
import { TriageVerdictSchema } from "../../models/verdict.js";
import type { GraphClient } from "../../../infra/graph/index.js";
import { createQueryGraphTool, createSearchSymbolTool } from "./query-graph.js";

export interface ToolConfig {
  projectRoot: string;
  allowBash: boolean;
  readRegistry?: ReadRegistry;
  getStep?: () => number;
  graphClient?: GraphClient | null;
  preferredReadRange?: PreferredReadRange;
}

export function createTools(config: ToolConfig): ToolSet {
  const readImpl = createReadTool({
    projectRoot: config.projectRoot,
    registry: config.readRegistry,
    getStep: config.getStep,
    preferredRange: config.preferredReadRange,
  });
  const grepImpl = createGrepTool(config.projectRoot);
  const globImpl = createGlobTool(config.projectRoot);

  const tools: ToolSet = {
    read: tool({
      description:
        "Read a file's contents with line numbers. Use offset/limit to read specific sections.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to project root"),
        offset: z.number().optional().describe("Start line (1-indexed, default 1)"),
        limit: z.number().optional().describe("Max lines to read (default 2000)"),
      }),
      execute: async (args) => readImpl.execute(args),
    }),
    grep: tool({
      description:
        "Search file contents using regex. Returns matching lines with file paths and line numbers.",
      inputSchema: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        path: z.string().optional().describe("Subdirectory to search in"),
        include: z.string().optional().describe("Glob filter (e.g. '*.py')"),
      }),
      execute: async (args) => grepImpl.execute(args),
    }),
    glob: tool({
      description:
        "Find files matching a glob pattern. Returns file paths sorted by modification time.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern (e.g. '**/*.py')"),
        path: z.string().optional().describe("Subdirectory to search in"),
      }),
      execute: async (args) => globImpl.execute(args),
    }),
    verdict: tool({
      description:
        "Deliver your final triage verdict. Call this when you have enough evidence. " +
        "REQUIRED: sink_line_quoted must be a verbatim ≥20-char substring of the actual " +
        "sink line as it appears in a read tool output (NOT your paraphrase). " +
        "REQUIRED for true_positive: attacker_payload must be concrete attacker input " +
        "bytes that exploit the specific sink. " +
        "Verdicts that fail these requirements are auto-downgraded to needs_review.",
      inputSchema: TriageVerdictSchema,
      execute: async (args) => JSON.stringify(args),
    }),
  };

  if (config.allowBash) {
    const bashImpl = createBashTool(config.projectRoot);
    tools.bash = tool({
      description:
        "Execute a shell command for read-only exploration (e.g., git log, git blame). Destructive commands are blocked.",
      inputSchema: z.object({
        command: z.string().describe("Shell command to execute"),
        timeout: z.number().optional().describe("Timeout in seconds (default 30)"),
      }),
      execute: async (args) => bashImpl.execute(args),
    });
  }

  if (config.graphClient) {
    (tools as Record<string, unknown>).query_graph = createQueryGraphTool(config.graphClient);
    (tools as Record<string, unknown>).search_symbol = createSearchSymbolTool(config.graphClient);
  }

  return tools;
}
