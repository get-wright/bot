import { describe, it, expect } from "vitest";
import { prefilterFinding, type PrefilterResult } from "../../../src/core/parser/prefilter.js";
import { FindingSchema, type Finding } from "../../../src/core/models/finding.js";

function makeFinding(overrides: Record<string, unknown> = {}): Finding {
  return FindingSchema.parse({
    check_id: "test.rule",
    path: (overrides.path as string) ?? "src/app.py",
    start: { line: 10, col: 1 },
    end: { line: 10, col: 20 },
    extra: {
      message: "test",
      severity: (overrides.severity as string) ?? "ERROR",
      metadata: { cwe: [], confidence: "HIGH", category: "security" },
      lines: "test_line",
      metavars: {},
      ...(typeof overrides.extra === "object" ? overrides.extra : {}),
    },
  });
}

describe("prefilterFinding", () => {
  it("passes normal findings", () => {
    const result = prefilterFinding(makeFinding());
    expect(result.passed).toBe(true);
  });

  it("filters test files by directory pattern", () => {
    const patterns = ["src/__tests__/foo.py", "src/tests/test_auth.py", "test/helpers.py", "testing/utils.py"];
    for (const path of patterns) {
      const result = prefilterFinding(makeFinding({ path }));
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("Test file");
    }
  });

  it("filters test files by filename pattern", () => {
    const patterns = ["src/test_auth.py", "src/auth_test.py", "src/auth.test.ts", "src/auth.spec.ts", "conftest.py"];
    for (const path of patterns) {
      const result = prefilterFinding(makeFinding({ path }));
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("Test file");
    }
  });

  it("filters generated/vendor files", () => {
    const patterns = [
      "src/migrations/0001_initial.py", "node_modules/lodash/index.js",
      "vendor/github.com/lib/pq/conn.go", "dist/bundle.js", "build/output.js",
      "src/api_pb2.py", "assets/app.min.js", "gen/types.ts", "src/generated/schema.ts",
    ];
    for (const path of patterns) {
      const result = prefilterFinding(makeFinding({ path }));
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("Generated");
    }
  });

  it("filters INFO severity", () => {
    const result = prefilterFinding(makeFinding({ severity: "INFO" }));
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Informational");
  });

  it("is case-insensitive for severity", () => {
    const result = prefilterFinding(makeFinding({ severity: "info" }));
    expect(result.passed).toBe(false);
  });
});
