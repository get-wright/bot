import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FindingSchema,
  SemgrepOutputSchema,
  type Finding,
} from "../../src/core/models/finding.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

describe("FindingSchema", () => {
  it("parses a pattern finding", () => {
    const raw = JSON.parse(
      readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"),
    );
    const result = SemgrepOutputSchema.parse(raw);
    expect(result.results).toHaveLength(2);
    const f = result.results[0]!;
    expect(f.check_id).toBe("python.django.security.injection.sql.raw-query");
    expect(f.path).toBe("src/api/views.py");
    expect(f.start.line).toBe(47);
    expect(f.extra.severity).toBe("ERROR");
    expect(f.extra.metadata.cwe).toContain("CWE-89: SQL Injection");
    expect(f.extra.dataflow_trace).toBeUndefined();
  });

  it("parses a taint finding with CliLoc normalization", () => {
    const raw = JSON.parse(
      readFileSync(resolve(FIXTURES, "semgrep-taint.json"), "utf-8"),
    );
    const result = SemgrepOutputSchema.parse(raw);
    const f = result.results[0]!;
    expect(f.extra.dataflow_trace).toBeDefined();
    const trace = f.extra.dataflow_trace!;
    expect(trace.taint_source).toBeDefined();
    expect(trace.taint_source!.content).toBe("request.GET.get('query')");
    expect(trace.taint_source!.location.path).toBe("src/api/views.py");
    expect(trace.taint_source!.location.start.line).toBe(32);
    expect(trace.taint_sink).toBeDefined();
    expect(trace.taint_sink!.content).toBe("cursor.execute(sql)");
    expect(trace.intermediate_vars).toHaveLength(1);
    expect(trace.intermediate_vars[0]!.content).toContain("sql = f\"SELECT");
  });

  it("handles missing optional fields with defaults", () => {
    const minimal = {
      check_id: "test.rule",
      path: "foo.py",
      start: { line: 1, col: 1 },
      end: { line: 1, col: 10 },
    };
    const f = FindingSchema.parse(minimal);
    expect(f.extra.severity).toBe("WARNING");
    expect(f.extra.metadata.cwe).toEqual([]);
    expect(f.extra.lines).toBe("");
  });

  it("preserves unknown extra fields via passthrough", () => {
    const withExtras = {
      check_id: "test.rule",
      path: "foo.py",
      start: { line: 1, col: 1 },
      end: { line: 1, col: 10 },
      extra: {
        message: "test",
        severity: "WARNING",
        metadata: { cwe: [], confidence: "LOW", category: "security" },
        lines: "",
        metavars: {},
        custom_field: "should_be_preserved",
      },
    };
    const f = FindingSchema.parse(withExtras);
    expect((f.extra as Record<string, unknown>).custom_field).toBe("should_be_preserved");
  });
});
