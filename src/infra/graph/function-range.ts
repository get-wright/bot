import type { Finding } from "../../core/models/finding.js";
import type { GraphClient, NodeInfo } from "./index.js";

export interface FunctionRange {
  path: string;
  qualifiedName: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  readOffset: number;
  readLimit: number;
}

function isFunctionLike(kind: string | undefined): boolean {
  if (!kind) return false;
  const normalized = kind.toLowerCase();
  return normalized === "function" || normalized === "method";
}

function rangeSize(node: NodeInfo): number {
  return Math.max(0, node.line_end - node.line_start);
}

export function resolveEnclosingFunctionRangeFromSummary(
  finding: Finding,
  summary: NodeInfo[],
  paddingLines = 0,
): FunctionRange | null {
  const line = finding.start.line;
  const enclosing = summary
    .filter((node) => isFunctionLike(node.kind))
    .filter((node) => line >= node.line_start && line <= node.line_end)
    .sort((a, b) => rangeSize(a) - rangeSize(b))[0];

  if (!enclosing) return null;

  const readOffset = Math.max(1, enclosing.line_start - paddingLines);
  const readEnd = enclosing.line_end + paddingLines;

  return {
    path: finding.path,
    qualifiedName: enclosing.qualified_name,
    kind: enclosing.kind,
    lineStart: enclosing.line_start,
    lineEnd: enclosing.line_end,
    readOffset,
    readLimit: readEnd - readOffset + 1,
  };
}

export async function resolveEnclosingFunctionRange(
  finding: Finding,
  graphClient: GraphClient,
  paddingLines = 0,
): Promise<FunctionRange | null> {
  const summary = await graphClient.queryGraph({
    pattern: "file_summary",
    target: finding.path,
  });
  return resolveEnclosingFunctionRangeFromSummary(finding, summary, paddingLines);
}
