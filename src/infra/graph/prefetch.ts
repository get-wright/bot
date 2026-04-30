import type { GraphClient, NodeInfo } from "./index.js";
import type { Finding } from "../../core/models/finding.js";

const MAX_FILE_SYMBOLS = 10;

function relativize(absPath: string, root: string): string {
  if (absPath.startsWith(root + "/")) return absPath.slice(root.length + 1);
  // Some sandboxes prepend /private (macOS) or symlink-resolved paths.
  if (absPath.includes(root)) return absPath.slice(absPath.indexOf(root) + root.length + 1);
  return absPath;
}

function isFunctionLike(kind: string | undefined): boolean {
  if (!kind) return false;
  const k = kind.toLowerCase();
  return k === "function" || k === "method";
}

function formatNode(n: NodeInfo, root: string): string {
  const params = n.params ? `  (${n.params})` : "";
  return `${n.kind} ${n.qualified_name}  ${relativize(n.file_path, root)}:${n.line_start}-${n.line_end}${params}`;
}

// Renders file_summary + enclosing function only. Callers/callees were
// dropped after juice-shop A/B showed they bias the model toward FP — the
// model treats wrapper-function summaries as proof of safety and skips
// reading the sink (lost real mongo-nosqli + directory-listing TPs).
export async function prefetchGraphContext(
  finding: Finding,
  graphClient: GraphClient,
  projectRoot: string,
): Promise<string | null> {
  const summary = await graphClient.queryGraph({
    pattern: "file_summary",
    target: finding.path,
  });
  if (summary.length === 0) return null;

  const enclosing = summary
    .filter(n => isFunctionLike(n.kind))
    .find(n => finding.start.line >= n.line_start && finding.start.line <= n.line_end) ?? null;

  const lines: string[] = [];
  const symLabel = summary.length === 1 ? "symbol" : "symbols";
  lines.push(`File contains ${summary.length} ${symLabel}:`);
  for (const n of summary.slice(0, MAX_FILE_SYMBOLS)) {
    lines.push(`  - ${formatNode(n, projectRoot)}`);
  }
  if (summary.length > MAX_FILE_SYMBOLS) {
    lines.push(`  ...and ${summary.length - MAX_FILE_SYMBOLS} more`);
  }

  if (enclosing) {
    lines.push("");
    lines.push(`Enclosing function: ${formatNode(enclosing, projectRoot)}`);
  }

  return lines.join("\n");
}
