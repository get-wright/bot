import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../../src/infra/memory/store.js";

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
    const cached = store.lookupCached("fp-full");
    expect(cached).not.toBeNull();
    expect(cached!.verdict.verdict).toBe("true_positive");
    expect(cached!.verdict.reasoning).toBe("SQL injection");
    expect(cached!.verdict.key_evidence).toEqual(["Line 10: raw query", "No ORM usage"]);
    expect(cached!.verdict.suggested_fix).toBe("Use parameterized queries");
  });

  it("lookupCached returns null for unknown fingerprint", () => {
    expect(store.lookupCached("does-not-exist")).toBeNull();
  });

  it("lookupCached handles missing optional fields", () => {
    store.store({
      fingerprint: "fp-min",
      check_id: "test.rule",
      path: "src/app.py",
      verdict: "needs_review",
      reasoning: "unclear",
      key_evidence: [],
    });
    const cached = store.lookupCached("fp-min");
    expect(cached!.verdict.key_evidence).toEqual([]);
    expect(cached!.verdict.suggested_fix).toBeUndefined();
    expect(cached!.tool_calls).toEqual([]);
    expect(cached!.input_tokens).toBe(0);
    expect(cached!.output_tokens).toBe(0);
  });

  it("stores and retrieves tool calls and token usage", () => {
    store.store({
      fingerprint: "fp-ctx",
      check_id: "test.rule",
      path: "src/app.py",
      verdict: "false_positive",
      reasoning: "safe",
      key_evidence: [],
      tool_calls: [
        { tool: "read", args: { path: "src/app.py", offset: 10, limit: 50 } },
        { tool: "grep", args: { pattern: "sanitize", path: "." } },
      ],
      input_tokens: 4200,
      output_tokens: 350,
    });
    const cached = store.lookupCached("fp-ctx");
    expect(cached!.tool_calls).toHaveLength(2);
    expect(cached!.tool_calls[0]).toEqual({ tool: "read", args: { path: "src/app.py", offset: 10, limit: 50 } });
    expect(cached!.tool_calls[1]!.tool).toBe("grep");
    expect(cached!.input_tokens).toBe(4200);
    expect(cached!.output_tokens).toBe(350);
    expect(cached!.updated_at).toBeTruthy();
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
