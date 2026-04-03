import { execFileSync } from "node:child_process";
import { resolve, relative } from "node:path";

const MAX_MATCHES = 50;

export interface GrepToolInput {
  pattern: string;
  path?: string;
  include?: string;
}

export interface GrepTool {
  execute(input: GrepToolInput): Promise<string>;
}

export function createGrepTool(projectRoot: string): GrepTool {
  const root = resolve(projectRoot);

  return {
    async execute({ pattern, path, include }: GrepToolInput): Promise<string> {
      const searchDir = path ? resolve(root, path) : root;

      const args: string[] = ["--line-number", "--no-heading", "-e", pattern];

      if (include) {
        args.push("--glob", include);
      }

      args.push(searchDir);

      let output: string;
      try {
        output = execFileSync("rg", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
      } catch (err: unknown) {
        const e = err as { status?: number; stdout?: string };
        // rg exits 1 when no matches found
        if (e.status === 1) return "No matches found.";
        throw err;
      }

      const lines = output.trim().split("\n").slice(0, MAX_MATCHES);
      return lines.join("\n");
    },
  };
}
