import type { Finding } from "../../models/finding.js";

export interface PrefilterResult {
  passed: boolean;
  reason?: string;
}

const TEST_DIR_PATTERNS = ["__tests__", "/tests/", "tests/", "/test/", "test/", "testing/"];
const TEST_FILE_PATTERNS = ["test_", "_test.", ".test.", ".spec.", "conftest.", "test_helper"];
const GENERATED_PATH_PATTERNS = [
  "/migrations/", "migrations/", "node_modules/", "/vendor/", "vendor/", "/dist/", "dist/", "/build/", "build/",
  ".generated.", "_pb2.py", ".min.js", "package-lock.json", "yarn.lock",
  ".pb.go", "/gen/", "gen/", "/generated/", "generated/",
];

export function prefilterFinding(finding: Finding): PrefilterResult {
  if (isTestFile(finding.path)) return { passed: false, reason: "Test file" };
  if (isGeneratedFile(finding.path)) return { passed: false, reason: "Generated/vendor file" };
  if (isInfoSeverity(finding)) return { passed: false, reason: "Informational severity" };
  return { passed: true };
}

function isTestFile(path: string): boolean {
  const lower = path.toLowerCase();
  const basename = lower.split("/").pop() ?? "";
  if (TEST_FILE_PATTERNS.some((p) => basename.includes(p))) return true;
  return TEST_DIR_PATTERNS.some((p) => lower.includes(p));
}

function isGeneratedFile(path: string): boolean {
  const lower = path.toLowerCase();
  return GENERATED_PATH_PATTERNS.some((p) => lower.includes(p));
}

function isInfoSeverity(finding: Finding): boolean {
  return finding.extra.severity.toUpperCase() === "INFO";
}
