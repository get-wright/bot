import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseSemgrepOutput,
  fingerprintFinding,
  classifyFinding,
} from "../../../src/core/parser/semgrep.js";

const FIXTURES = resolve(import.meta.dirname, "../../fixtures");

describe("parseSemgrepOutput", () => {
  it("parses JSON object with results array", () => {
    const raw = JSON.parse(readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"));
    const findings = parseSemgrepOutput(raw);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.check_id).toBe("python.django.security.injection.sql.raw-query");
  });

  it("parses raw JSON string", () => {
    const str = readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8");
    const findings = parseSemgrepOutput(str);
    expect(findings).toHaveLength(2);
  });

  it("parses bare results array", () => {
    const raw = JSON.parse(readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"));
    const findings = parseSemgrepOutput(raw.results);
    expect(findings).toHaveLength(2);
  });

  it("returns empty array for invalid input", () => {
    expect(parseSemgrepOutput(42 as unknown as string)).toEqual([]);
    expect(parseSemgrepOutput("not json")).toEqual([]);
  });

  it("accepts cwe as a single string and normalizes to array", () => {
    const raw = {
      results: [{
        check_id: "test.csrf",
        path: "x.html",
        start: { line: 1, col: 1 },
        end: { line: 1, col: 1 },
        extra: {
          message: "m",
          severity: "WARNING",
          metadata: { cwe: "CWE-352: CSRF" },
          lines: "<form>",
        },
      }],
    };
    const parsed = parseSemgrepOutput(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.extra.metadata.cwe).toEqual(["CWE-352: CSRF"]);
  });

  it("accepts cwe as array and preserves it", () => {
    const raw = {
      results: [{
        check_id: "test.eval",
        path: "x.js",
        start: { line: 1, col: 1 },
        end: { line: 1, col: 5 },
        extra: {
          message: "m",
          severity: "ERROR",
          metadata: { cwe: ["CWE-95: eval"] },
          lines: "eval()",
        },
      }],
    };
    const parsed = parseSemgrepOutput(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.extra.metadata.cwe).toEqual(["CWE-95: eval"]);
  });

  it("skips malformed findings", () => {
    const input = {
      results: [
        { check_id: "valid", path: "a.py", start: { line: 1, col: 1 }, end: { line: 1, col: 5 } },
        { broken: true },
      ],
    };
    const findings = parseSemgrepOutput(input);
    expect(findings).toHaveLength(1);
  });
});

describe("fingerprintFinding", () => {
  it("produces a 16-char hex string", () => {
    const raw = JSON.parse(readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"));
    const findings = parseSemgrepOutput(raw);
    const fp = fingerprintFinding(findings[0]!);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces different fingerprints for different findings", () => {
    const raw = JSON.parse(readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"));
    const findings = parseSemgrepOutput(raw);
    const fp1 = fingerprintFinding(findings[0]!);
    const fp2 = fingerprintFinding(findings[1]!);
    expect(fp1).not.toBe(fp2);
  });

  it("is deterministic", () => {
    const raw = JSON.parse(readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"));
    const findings = parseSemgrepOutput(raw);
    expect(fingerprintFinding(findings[0]!)).toBe(fingerprintFinding(findings[0]!));
  });
});

describe("classifyFinding", () => {
  it("classifies finding without dataflow trace as pattern", () => {
    const raw = JSON.parse(readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"));
    const findings = parseSemgrepOutput(raw);
    expect(classifyFinding(findings[0]!)).toBe("pattern");
  });

  it("classifies finding with dataflow trace as taint", () => {
    const raw = JSON.parse(readFileSync(resolve(FIXTURES, "semgrep-taint.json"), "utf-8"));
    const findings = parseSemgrepOutput(raw);
    expect(classifyFinding(findings[0]!)).toBe("taint");
  });
});
