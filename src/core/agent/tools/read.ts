import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, relative } from "node:path";

const MAX_BYTES = 50 * 1024;
// Skip dedup for tiny files: a stub message can be larger than the original
// content, and re-reading them costs nothing.
const DEDUP_MIN_BYTES = 200;
const DEFAULT_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;

export interface ServedRange {
  start: number;  // 1-indexed inclusive
  end: number;    // 1-indexed inclusive
}

export interface ReadEntry {
  hash: string;          // first 12 hex chars of SHA-256(buffer)
  step: number;          // step at which it was first served
  mtimeMs: number;       // file mtime at read time
  totalLines: number;    // total file lines (for stub message)
  byteCappedTruncated: boolean;  // 50KB byte cap hit on first read — disables dedup
  servedRanges: ServedRange[];   // line ranges already shown to the agent
}

export type ReadRegistry = Map<string, ReadEntry>;

export interface CreateReadToolOptions {
  projectRoot: string;
  registry?: ReadRegistry;
  getStep?: () => number;
}

export interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface ReadTool {
  execute(input: ReadToolInput): Promise<string>;
}

function formatRanges(ranges: ServedRange[]): string {
  return ranges.map(r => r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`).join(", ");
}

function mergeRanges(ranges: ServedRange[]): ServedRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: ServedRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

export function createReadTool(opts: CreateReadToolOptions): ReadTool {
  const root = resolve(opts.projectRoot);
  const registry = opts.registry;
  const getStep = opts.getStep ?? (() => 0);

  return {
    async execute(input: ReadToolInput): Promise<string> {
      const { path } = input;
      const abs = resolve(root, path);
      const rel = relative(root, abs);
      if (rel.startsWith("..") || rel === abs) {
        throw new Error(`Path outside project root: ${path}`);
      }

      let buf: Buffer;
      let mtimeMs: number;
      try {
        mtimeMs = statSync(abs).mtimeMs;
        buf = readFileSync(abs);
      } catch {
        throw new Error(`File not found: ${path}`);
      }

      // Binary check: look for null bytes in first 8KB
      if (buf.subarray(0, 8192).includes(0)) {
        throw new Error(`Binary file not supported: ${path}`);
      }

      const hash = createHash("sha256").update(buf).digest("hex").slice(0, 12);

      const totalBytes = buf.length;
      const bytesTruncated = totalBytes > MAX_BYTES;
      const capped = buf.subarray(0, MAX_BYTES);
      const lines = capped.toString("utf8").split("\n");
      // Remove trailing empty element from trailing newline
      if (lines.at(-1) === "") lines.pop();
      const totalLines = lines.length;

      // Capture raw input BEFORE applying defaults — critical for range-coverage dedup
      const offset = input.offset ?? 1;
      const limit = input.limit ?? DEFAULT_LIMIT;
      const wantStart = Math.max(1, offset);
      const wantEnd = Math.min(totalLines, wantStart - 1 + limit);

      const prior = registry?.get(abs);
      const eligibleForDedup = registry && buf.length >= DEDUP_MIN_BYTES;
      let modifiedNotice = "";

      if (eligibleForDedup && prior) {
        const sameContent = prior.hash === hash && prior.mtimeMs === mtimeMs;
        if (sameContent && !prior.byteCappedTruncated) {
          const covered = prior.servedRanges.some(r => r.start <= wantStart && r.end >= wantEnd);
          if (covered) {
            return `[File ${path} was already read at step ${prior.step} ` +
                   `(${prior.totalLines} lines, hash ${hash}, content unchanged, ` +
                   `served lines ${formatRanges(prior.servedRanges)}). ` +
                   `Refer to your earlier output. If you need a different range, ` +
                   `pass offset and limit explicitly.]`;
          }
        } else if (!sameContent) {
          modifiedNotice = `[File modified since step ${prior.step} — re-reading]\n`;
        }
      }

      const slice = lines.slice(wantStart - 1, wantEnd);

      // Truncate overly long lines (minified JS, SVG data URIs, etc.)
      const formatted = slice.map((line, i) => {
        const truncated = line.length > MAX_LINE_CHARS
          ? line.slice(0, MAX_LINE_CHARS) + `… [line truncated, ${line.length} chars total]`
          : line;
        return `${wantStart + i}\t${truncated}`;
      }).join("\n");

      // Append metadata footer so the agent knows where it is in the file
      const atEnd = wantEnd >= totalLines;
      let footer: string;
      if (bytesTruncated) {
        footer = `\n\n[Showing lines ${wantStart}-${wantEnd} — file exceeds ${MAX_BYTES} byte cap, use offset to read further]`;
      } else if (wantStart === 1 && atEnd) {
        footer = `\n\n[End of file — ${totalLines} lines total]`;
      } else if (atEnd) {
        footer = `\n\n[End of file — showed lines ${wantStart}-${wantEnd} of ${totalLines}]`;
      } else {
        footer = `\n\n[Showing lines ${wantStart}-${wantEnd} of ${totalLines} — use offset=${wantEnd + 1} to continue]`;
      }

      if (eligibleForDedup && registry) {
        const newRange: ServedRange = { start: wantStart, end: wantEnd };
        const isModified = prior && (prior.hash !== hash || prior.mtimeMs !== mtimeMs);
        if (!prior || isModified) {
          registry.set(abs, {
            hash, step: getStep(), mtimeMs, totalLines,
            byteCappedTruncated: bytesTruncated,
            servedRanges: [newRange],
          });
        } else {
          prior.servedRanges = mergeRanges([...prior.servedRanges, newRange]);
        }
      }

      return modifiedNotice + formatted + footer;
    },
  };
}
