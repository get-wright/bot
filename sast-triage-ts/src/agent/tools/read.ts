import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import type { PermissionDecision } from "../../models/events.js";

const MAX_BYTES = 50 * 1024;
const DEFAULT_LIMIT = 200;
const MAX_LINE_CHARS = 2000;

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

      const totalBytes = buf.length;
      const bytesTruncated = totalBytes > MAX_BYTES;
      const capped = buf.subarray(0, MAX_BYTES);
      const lines = capped.toString("utf8").split("\n");
      // Remove trailing empty element from trailing newline
      if (lines.at(-1) === "") lines.pop();

      const totalLines = lines.length;
      const start = Math.max(1, offset);
      const end = Math.min(totalLines, start - 1 + limit);
      const slice = lines.slice(start - 1, end);

      // Truncate overly long lines (minified JS, SVG data URIs, etc.)
      const formatted = slice.map((line, i) => {
        const truncated = line.length > MAX_LINE_CHARS
          ? line.slice(0, MAX_LINE_CHARS) + `… [line truncated, ${line.length} chars total]`
          : line;
        return `${start + i}\t${truncated}`;
      }).join("\n");

      // Append metadata footer so the agent knows where it is in the file
      const atEnd = end >= totalLines;
      let footer: string;
      if (bytesTruncated) {
        footer = `\n\n[Showing lines ${start}-${end} — file exceeds ${MAX_BYTES} byte cap, use offset to read further]`;
      } else if (start === 1 && atEnd) {
        footer = `\n\n[End of file — ${totalLines} lines total]`;
      } else if (atEnd) {
        footer = `\n\n[End of file — showed lines ${start}-${end} of ${totalLines}]`;
      } else {
        footer = `\n\n[Showing lines ${start}-${end} of ${totalLines} — use offset=${end + 1} to continue]`;
      }

      return formatted + footer;
    },
  };
}
