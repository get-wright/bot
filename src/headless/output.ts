import { writeFileSync, accessSync, constants, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Finding } from "../core/models/finding.js";
import type { VerdictValue } from "../core/models/verdict.js";

export interface OutputRow {
  finding: Finding;
  /**
   * Output verdict — accepts the LLM-emitted verdicts plus "error" for runner failures.
   * Runner-level superset of VerdictValue; the LLM-facing schema does not include "error".
   */
  verdict: { verdict: VerdictValue | "error"; reasoning: string; key_evidence: string | string[] };
  tool_calls: Array<{ tool: string; args: Record<string, unknown> }>;
  input_tokens: number;
  output_tokens: number;
  cached: boolean;
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
  cached: number;
}

interface OutputDocument {
  schema_version: 1;
  generated_at: string;
  config: OutputConfig;
  summary: OutputSummary;
  findings: OutputRow[];
}

export class OutputWriter {
  private rows: OutputRow[] = [];

  constructor(private readonly path: string, private readonly config: OutputConfig) {
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
      cached: this.rows.filter((r) => r.cached).length,
    };
    const doc: OutputDocument = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      config: this.config,
      summary,
      findings: this.rows,
    };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(doc, null, 2), "utf-8");
  }
}
