import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OutputWriter } from "../../src/headless/output.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sast-out-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("OutputWriter", () => {
  it("validates output path is writable before agent starts", () => {
    const badPath = join(dir, "nonexistent-subdir", "out.json");
    expect(() => new OutputWriter(badPath, { provider: "openai", model: "gpt-4o" })).toThrow(
      /not writable|ENOENT/i,
    );
  });

  it("writes consolidated JSON with summary on flush", () => {
    const out = join(dir, "findings-out.json");
    const w = new OutputWriter(out, { provider: "openai", model: "gpt-4o" });

    w.append({
      finding: { check_id: "test", path: "x.ts", start: { line: 1, col: 0 }, end: { line: 1, col: 0 }, extra: { message: "m", severity: "WARNING", metadata: { cwe: [] } }, fingerprint: "fp1" } as never,
      verdict: { verdict: "true_positive", reasoning: "r", key_evidence: ["e"] },
      tool_calls: [],
      input_tokens: 100,
      output_tokens: 50,
      cached: false,
      audited_at: "2026-04-28T00:00:00Z",
    });

    w.append({
      finding: { check_id: "test2", path: "y.ts", start: { line: 1, col: 0 }, end: { line: 1, col: 0 }, extra: { message: "m", severity: "WARNING", metadata: { cwe: [] } }, fingerprint: "fp2" } as never,
      verdict: { verdict: "false_positive", reasoning: "r", key_evidence: [] },
      tool_calls: [],
      input_tokens: 80,
      output_tokens: 30,
      cached: true,
      audited_at: "2026-04-28T00:00:01Z",
    });

    w.flush();

    expect(existsSync(out)).toBe(true);
    const data = JSON.parse(readFileSync(out, "utf-8"));
    expect(data.schema_version).toBe(1);
    expect(data.config.provider).toBe("openai");
    expect(data.summary).toEqual({
      total: 2,
      true_positive: 1,
      false_positive: 1,
      needs_review: 0,
      error: 0,
      cached: 1,
    });
    expect(data.findings).toHaveLength(2);
    expect(data.findings[0]!.cached).toBe(false);
    expect(data.findings[1]!.cached).toBe(true);
  });

  it("counts error rows in summary.error", () => {
    const out = join(dir, "findings-out.json");
    const w = new OutputWriter(out, { provider: "openai", model: "gpt-4o" });
    w.append({
      finding: { check_id: "x", path: "x", start: { line: 1, col: 0 }, end: { line: 1, col: 0 }, extra: { message: "", severity: "WARNING", metadata: { cwe: [] } }, fingerprint: "fp" } as never,
      verdict: { verdict: "error", reasoning: "boom", key_evidence: [] },
      tool_calls: [],
      input_tokens: 0,
      output_tokens: 0,
      cached: false,
      audited_at: "2026-04-28T00:00:00Z",
    });
    w.flush();
    const data = JSON.parse(readFileSync(out, "utf-8"));
    expect(data.summary.error).toBe(1);
    expect(data.summary.total).toBe(1);
  });
});
