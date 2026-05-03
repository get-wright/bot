import { writeFileSync, accessSync, constants, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { VerdictValue } from "../../core/models/verdict.js";

export interface OutputRef {
  fingerprint: string;
  check_id: string;
  path: string;
  line: number;
}

export interface OutputRow {
  ref: OutputRef;
  /**
   * Output verdict — accepts the LLM-emitted verdicts plus "error" for runner failures.
   * Runner-level superset of VerdictValue; the LLM-facing schema does not include "error".
   */
  verdict: { verdict: VerdictValue | "error"; reasoning: string; key_evidence: string | string[] };
  tool_calls: Array<{ tool: string; args: Record<string, unknown> }>;
  input_tokens: number;
  output_tokens: number;
  audited_at: string;
}

export interface OutputConfig {
  provider: string;
  model: string;
  effort?: string;
}

interface OutputSummary {
  total: number;
  true_positive: number;
  false_positive: number;
  needs_review: number;
  error: number;
}

interface OutputDocument {
  generated_at: string;
  findings_source: string;
  config: OutputConfig;
  summary: OutputSummary;
  findings: OutputRow[];
}

export class OutputWriter {
  private rows: OutputRow[] = [];

  constructor(
    private readonly path: string,
    private readonly config: OutputConfig,
    private readonly findingsSource: string,
  ) {
    const dir = dirname(path);
    try {
      accessSync(dir, constants.W_OK);
    } catch {
      throw new Error(`Output directory not writable: ${dir}`);
    }
  }

  append(row: OutputRow): void {
    this.rows.push(row);
  }

  flush(): void {
    const summary: OutputSummary = {
      total: this.rows.length,
      true_positive: this.rows.filter((r) => r.verdict.verdict === "true_positive").length,
      false_positive: this.rows.filter((r) => r.verdict.verdict === "false_positive").length,
      needs_review: this.rows.filter((r) => r.verdict.verdict === "needs_review").length,
      error: this.rows.filter((r) => r.verdict.verdict === "error").length,
    };
    const doc: OutputDocument = {
      generated_at: new Date().toISOString(),
      findings_source: this.findingsSource,
      config: this.config,
      summary,
      findings: this.rows,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(doc, null, 2), "utf-8");
  }
}
