import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { PermissionDecision } from "../../models/events.js";

const MAX_BYTES = 50 * 1024;
const DEFAULT_LIMIT = 200;

export interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface PermissionCallbacks {
  isPathAllowed: (absPath: string) => boolean;
  requestPermission: (absPath: string) => Promise<PermissionDecision>;
}

export interface ReadTool {
  execute(input: ReadToolInput): Promise<string>;
}

export function createReadTool(projectRoot: string, permissions?: PermissionCallbacks): ReadTool {
  const root = resolve(projectRoot);

  return {
    async execute({ path, offset = 1, limit = DEFAULT_LIMIT }: ReadToolInput): Promise<string> {
      const abs = resolve(root, path);
      const rel = relative(root, abs);
      const isOutside = rel.startsWith("..") || rel === abs;

      if (isOutside) {
        if (!permissions) {
          throw new Error(`Path outside project root: ${path}`);
        }

        if (!permissions.isPathAllowed(abs)) {
          const decision = await permissions.requestPermission(abs);
          if (decision === "deny") {
            throw new Error(`Access denied: ${path} — outside project root. User denied access.`);
          }
          // "once" and "always" both proceed — "always" handling is done by the caller
        }
      }

      let buf: Buffer;
      try {
        buf = readFileSync(abs);
      } catch {
        throw new Error(`File not found: ${path}`);
      }

      // Binary check: look for null bytes in first 8KB
      const probe = buf.subarray(0, 8192);
      if (probe.includes(0)) {
        throw new Error(`Binary file not supported: ${path}`);
      }

      const capped = buf.subarray(0, MAX_BYTES);
      const lines = capped.toString("utf8").split("\n");
      // Remove trailing empty element from trailing newline
      if (lines.at(-1) === "") lines.pop();

      const start = Math.max(1, offset);
      const slice = lines.slice(start - 1, start - 1 + limit);

      return slice.map((line, i) => `${start + i}\t${line}`).join("\n");
    },
  };
}
