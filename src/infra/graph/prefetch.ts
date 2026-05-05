import type { GraphClient, NodeInfo } from "./index.js";
import type { Finding } from "../../core/models/finding.js";
import { findCallPathsToFunction } from "./multipath.js";
import { resolveEnclosingFunctionRangeFromSummary } from "./function-range.js";

const MAX_FILE_SYMBOLS = 10;
const MAX_PATHS = 3;
const MAX_PATH_DEPTH = 4;

function relativize(absPath: string, root: string): string {
  if (absPath.startsWith(root + "/")) return absPath.slice(root.length + 1);
  // Some sandboxes prepend /private (macOS) or symlink-resolved paths.
  if (absPath.includes(root)) return absPath.slice(absPath.indexOf(root) + root.length + 1);
  return absPath;
}

function shortName(n: NodeInfo): string {
  return n.qualified_name.split("::").slice(-1)[0] ?? n.qualified_name;
}

function formatNode(n: NodeInfo, root: string): string {
  const params = n.params ? `  (${n.params})` : "";
  return `${n.kind} ${n.qualified_name}  ${relativize(n.file_path, root)}:${n.line_start}-${n.line_end}${params}`;
}

function formatPath(path: NodeInfo[], root: string): string {
  const arrow = path.map(n => `${shortName(n)} (${relativize(n.file_path, root)}:${n.line_start})`).join(" -> ");
  return `  ${arrow}`;
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
  return prefetchGraphContextFromSummary(finding, graphClient, projectRoot, summary);
}

export async function prefetchGraphContextFromSummary(
  finding: Finding,
  graphClient: GraphClient,
  projectRoot: string,
  summary: NodeInfo[],
): Promise<string | null> {
  if (summary.length === 0) return null;

  const initialRange = resolveEnclosingFunctionRangeFromSummary(finding, summary);
  const enclosing = initialRange
    ? summary.find((n) => n.qualified_name === initialRange.qualifiedName) ?? null
    : null;

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

    const paths = await findCallPathsToFunction(graphClient, enclosing, {
      maxPaths: MAX_PATHS,
      maxDepth: MAX_PATH_DEPTH,
    });
    if (paths.length > 0) {
      lines.push("");
      lines.push(`Call paths to sink (${paths.length} of up to ${MAX_PATHS}):`);
      for (const p of paths) {
        lines.push(formatPath(p, projectRoot));
      }
    }
  }

  return lines.join("\n");
}
