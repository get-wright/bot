import type { GraphClient, NodeInfo } from "./index.js";
import type { Finding } from "../../core/models/finding.js";

const MAX_FILE_SYMBOLS = 10;
const MAX_CALL_RELATIONS = 5;

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

  let callers: NodeInfo[] = [];
  let callees: NodeInfo[] = [];
  if (enclosing) {
    [callers, callees] = await Promise.all([
      graphClient.queryGraph({ pattern: "callers_of", target: enclosing.qualified_name }),
      graphClient.queryGraph({ pattern: "callees_of", target: enclosing.qualified_name }),
    ]);
  }

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

  if (callers.length > 0) {
    lines.push(`Callers (${callers.length}):`);
    for (const n of callers.slice(0, MAX_CALL_RELATIONS)) {
      lines.push(`  - ${formatNode(n, projectRoot)}`);
    }
    if (callers.length > MAX_CALL_RELATIONS) {
      lines.push(`  ...and ${callers.length - MAX_CALL_RELATIONS} more`);
    }
  }

  if (callees.length > 0) {
    lines.push(`Callees (${callees.length}):`);
    for (const n of callees.slice(0, MAX_CALL_RELATIONS)) {
      lines.push(`  - ${formatNode(n, projectRoot)}`);
    }
    if (callees.length > MAX_CALL_RELATIONS) {
      lines.push(`  ...and ${callees.length - MAX_CALL_RELATIONS} more`);
    }
  }

  return lines.join("\n");
}
