import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { createReadTool, type PermissionCallbacks } from "./read.js";
import { createGrepTool } from "./grep.js";
import { createGlobTool } from "./glob.js";
import { createBashTool } from "./bash.js";
import { TriageVerdictSchema } from "../../models/verdict.js";

export interface ToolConfig {
  projectRoot: string;
  allowBash: boolean;
  permissions?: PermissionCallbacks;
}

export function createTools(config: ToolConfig): ToolSet {
  const readImpl = createReadTool(config.projectRoot, config.permissions);
  const grepImpl = createGrepTool(config.projectRoot);
  const globImpl = createGlobTool(config.projectRoot);

  const tools: ToolSet = {
    read: tool({
      description:
        "Read a file's contents with line numbers. Use offset/limit to read specific sections.",
      inputSchema: z.object({
        path: z.string().describe("File path relative to project root"),
        offset: z.number().optional().describe("Start line (1-indexed, default 1)"),
        limit: z.number().optional().describe("Max lines to read (default 200)"),
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
        "Deliver your final triage verdict. Call this when you have enough evidence. This ends the investigation. Do NOT repeat or summarize your analysis after calling this tool.",
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

  return tools;
}
