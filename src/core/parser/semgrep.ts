import { createHash } from "node:crypto";
import { FindingSchema, SemgrepOutputSchema, type Finding } from "../../models/finding.js";

export function parseSemgrepOutput(raw: unknown): Finding[] {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) {
    return parseFindingsArray(raw);
  }
  if (typeof raw === "object" && raw !== null) {
    const parsed = SemgrepOutputSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data.results;
    }
    // Try extracting results array and parse item-by-item to skip malformed entries
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj["results"])) {
      return parseFindingsArray(obj["results"]);
    }
    return [];
  }
  return [];
}

function parseFindingsArray(items: unknown[]): Finding[] {
  const findings: Finding[] = [];
  for (const item of items) {
    const result = FindingSchema.safeParse(item);
    if (result.success) {
      findings.push(result.data);
    }
  }
  return findings;
}

export function fingerprintFinding(finding: Finding): string {
  const data = `${finding.check_id}:${finding.path}:${finding.start.line}:${finding.extra.lines}`;
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

export function classifyFinding(finding: Finding): "taint" | "pattern" {
  const trace = finding.extra.dataflow_trace;
  if (!trace) return "pattern";
  return trace.taint_source != null || trace.taint_sink != null ? "taint" : "pattern";
}
