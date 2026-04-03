import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSemgrepOutput, fingerprintFinding, classifyFinding } from "../src/parser/semgrep.js";
import { prefilterFinding } from "../src/parser/prefilter.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures");

describe("pipeline integration (no LLM)", () => {
  it("parse → fingerprint → classify → prefilter for pattern finding", () => {
    const raw = JSON.parse(readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"));
    const findings = parseSemgrepOutput(raw);
    expect(findings).toHaveLength(2);

    const f = findings[0]!;
    const fp = fingerprintFinding(f);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);

    const cls = classifyFinding(f);
    expect(cls).toBe("pattern");

    const pf = prefilterFinding(f);
    expect(pf.passed).toBe(true);
  });

  it("parse → fingerprint → classify → prefilter for taint finding", () => {
    const raw = JSON.parse(readFileSync(resolve(FIXTURES, "semgrep-taint.json"), "utf-8"));
    const findings = parseSemgrepOutput(raw);
    expect(findings).toHaveLength(1);

    const f = findings[0]!;
    const cls = classifyFinding(f);
    expect(cls).toBe("taint");

    expect(f.extra.dataflow_trace).toBeDefined();
    expect(f.extra.dataflow_trace!.taint_source).toBeDefined();
    // Access content from CliLoc tuple format
    const source = f.extra.dataflow_trace!.taint_source;
    if (Array.isArray(source) && source.length > 1) {
      const content = source[1];
      expect(content).toBe("request.GET.get('query')");
    }
  });

  it("prefilter rejects test files", () => {
    const raw = JSON.parse(readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"));
    const findings = parseSemgrepOutput(raw);

    // Create a test file variant
    const testFinding = {
      ...findings[0],
      path: "tests/test_views.py",
    };

    const parsed = parseSemgrepOutput([testFinding]);
    expect(parsed).toHaveLength(1);

    const pf = prefilterFinding(parsed[0]!);
    expect(pf.passed).toBe(false);
    expect(pf.reason).toContain("Test file");
  });

  it("prefilter rejects generated files", () => {
    const raw = JSON.parse(readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"));
    const findings = parseSemgrepOutput(raw);

    const generatedFinding = {
      ...findings[0],
      path: "src/migrations/0001_initial.py",
    };

    const parsed = parseSemgrepOutput([generatedFinding]);
    expect(parsed).toHaveLength(1);

    const pf = prefilterFinding(parsed[0]!);
    expect(pf.passed).toBe(false);
    expect(pf.reason).toContain("Generated");
  });

  it("prefilter rejects INFO severity", () => {
    const raw = JSON.parse(readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"));
    const findings = parseSemgrepOutput(raw);

    const infoFinding = {
      ...findings[0],
      extra: {
        ...findings[0]!.extra,
        severity: "INFO",
      },
    };

    const parsed = parseSemgrepOutput([infoFinding]);
    expect(parsed).toHaveLength(1);

    const pf = prefilterFinding(parsed[0]!);
    expect(pf.passed).toBe(false);
    expect(pf.reason).toContain("Informational");
  });

  it("fingerprint is deterministic", () => {
    const raw = JSON.parse(readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"));
    const findings = parseSemgrepOutput(raw);
    const f = findings[0]!;

    const fp1 = fingerprintFinding(f);
    const fp2 = fingerprintFinding(f);
    expect(fp1).toBe(fp2);
  });

  it("different findings produce different fingerprints", () => {
    const raw = JSON.parse(readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"));
    const findings = parseSemgrepOutput(raw);

    const fp1 = fingerprintFinding(findings[0]!);
    const fp2 = fingerprintFinding(findings[1]!);
    expect(fp1).not.toBe(fp2);
  });
});
