import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const MAX_FILES = 50;
const IGNORED_DIRS = ["node_modules", ".git", "dist", "__pycache__", "venv", "build"];

export interface GlobToolInput {
  pattern: string;
  path?: string;
}

export interface GlobTool {
  execute(input: GlobToolInput): Promise<string>;
}

export function createGlobTool(projectRoot: string): GlobTool {
  const root = resolve(projectRoot);

  return {
    async execute({ pattern, path }: GlobToolInput): Promise<string> {
      const searchDir = path ? resolve(root, path) : root;

      const args: string[] = ["--files", "--glob", pattern];

      for (const dir of IGNORED_DIRS) {
        args.push("--glob", `!${dir}`);
        args.push("--glob", `!**/${dir}/**`);
      }

      args.push(searchDir);

      let output: string;
      try {
        output = execFileSync("rg", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
      } catch (err: unknown) {
        const e = err as { status?: number };
        if (e.status === 1) return "No files found.";
        throw err;
      }

      const files = output.trim().split("\n").filter(Boolean).slice(0, MAX_FILES);
      if (files.length === 0) return "No files found.";
      return files.join("\n");
    },
  };
}
