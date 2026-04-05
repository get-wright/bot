import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../../src/memory/store.js";

let tmpDir: string;
let store: MemoryStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sast-triage-test-"));
  store = new MemoryStore(join(tmpDir, "memory.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("MemoryStore", () => {
  it("stores and retrieves a verdict", () => {
    store.store({
      fingerprint: "abc123",
      check_id: "test.rule",
      path: "src/app.py",
      verdict: "true_positive",
      reasoning: "SQL injection found",
      key_evidence: [],
    });
    const record = store.lookup("abc123");
    expect(record).not.toBeNull();
    expect(record!.verdict).toBe("true_positive");
    expect(record!.reasoning).toBe("SQL injection found");
    expect(record!.check_id).toBe("test.rule");
  });

  it("returns null for unknown fingerprint", () => {
    expect(store.lookup("nonexistent")).toBeNull();
  });

  it("upserts on duplicate fingerprint", () => {
    store.store({ fingerprint: "abc123", check_id: "test.rule", path: "src/app.py", verdict: "needs_review", reasoning: "first pass", key_evidence: [] });
    store.store({ fingerprint: "abc123", check_id: "test.rule", path: "src/app.py", verdict: "false_positive", reasoning: "ORM is safe", key_evidence: [] });
    const record = store.lookup("abc123");
    expect(record!.verdict).toBe("false_positive");
    expect(record!.reasoning).toBe("ORM is safe");
  });

  it("stores and retrieves full verdict with evidence and fix", () => {
    store.store({
      fingerprint: "fp-full",
      check_id: "test.rule",
      path: "src/app.py",
      verdict: "true_positive",
      reasoning: "SQL injection",
      key_evidence: ["Line 10: raw query", "No ORM usage"],
      suggested_fix: "Use parameterized queries",
    });
    const verdict = store.lookupVerdict("fp-full");
    expect(verdict).not.toBeNull();
    expect(verdict!.verdict).toBe("true_positive");
    expect(verdict!.reasoning).toBe("SQL injection");
    expect(verdict!.key_evidence).toEqual(["Line 10: raw query", "No ORM usage"]);
    expect(verdict!.suggested_fix).toBe("Use parameterized queries");
  });

  it("lookupVerdict returns null for unknown fingerprint", () => {
    expect(store.lookupVerdict("does-not-exist")).toBeNull();
  });

  it("lookupVerdict handles missing optional fields", () => {
    store.store({
      fingerprint: "fp-min",
      check_id: "test.rule",
      path: "src/app.py",
      verdict: "needs_review",
      reasoning: "unclear",
      key_evidence: [],
    });
    const verdict = store.lookupVerdict("fp-min");
    expect(verdict!.key_evidence).toEqual([]);
    expect(verdict!.suggested_fix).toBeUndefined();
  });

  it("looks up by rule with limit", () => {
    for (let i = 0; i < 5; i++) {
      store.store({ fingerprint: `fp-${i}`, check_id: "same.rule", path: `src/file${i}.py`, verdict: i % 2 === 0 ? "true_positive" : "false_positive", reasoning: `reason ${i}`, key_evidence: [] });
    }
    const records = store.lookupByRule("same.rule", 3);
    expect(records).toHaveLength(3);
  });

  it("getHints returns prior verdict text", () => {
    store.store({ fingerprint: "abc123", check_id: "test.rule", path: "src/app.py", verdict: "true_positive", reasoning: "SQL injection found", key_evidence: [] });
    const hints = store.getHints("test.rule", "abc123");
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]).toContain("true_positive");
  });

  it("getHints returns rule-level stats when enough data", () => {
    for (let i = 0; i < 3; i++) {
      store.store({ fingerprint: `fp-${i}`, check_id: "popular.rule", path: `src/file${i}.py`, verdict: "true_positive", reasoning: "vuln", key_evidence: [] });
    }
    const hints = store.getHints("popular.rule", "unknown-fp");
    expect(hints.some((h) => h.includes("previous findings"))).toBe(true);
  });
});
