import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { TriageOrchestrator } from "../src/core/triage/orchestrator.js";
import { MemoryStore } from "../src/memory/store.js";
import { fingerprintFinding } from "../src/core/parser/semgrep.js";
import type { Finding } from "../src/core/models/finding.js";
import type { AppConfig } from "../src/config.js";

function makeMinimalFinding(): Finding {
  return {
    check_id: "test-rule",
    path: "src/example.ts",
    start: { line: 10, col: 5, offset: 0 },
    end: { line: 10, col: 25, offset: 0 },
    extra: {
      message: "test finding",
      severity: "WARNING",
      metadata: { cwe: [], confidence: "MEDIUM", category: "security", technology: [], owasp: [], vulnerability_class: [] },
      lines: "",
      metavars: {},
    },
  } as Finding;
}

describe("TriageOrchestrator", () => {
  function createOrchestrator() {
    const memory = new MemoryStore(":memory:");
    return { orchestrator: new TriageOrchestrator(memory), memory };
  }

  describe("loadFindings", () => {
    const fixturePath = resolve(import.meta.dirname, "fixtures/semgrep-output.json");

    it("parses and classifies findings from a file", () => {
      const { orchestrator } = createOrchestrator();
      const result = orchestrator.loadFindings(fixturePath);

      expect(result.total).toBeGreaterThan(0);
      expect(result.active.length + result.filtered.length).toBe(result.total);
      for (const s of result.active) {
        expect(s.entry.fingerprint).toBeTruthy();
        expect(s.finding).toBeDefined();
        expect(s.events).toEqual([]);
        expect(s.entry.status).toBe("pending");
      }
    });

    it("hydrates cached verdicts from memory", () => {
      const { orchestrator, memory } = createOrchestrator();

      const first = orchestrator.loadFindings(fixturePath);
      const fp = first.active[0]!.entry.fingerprint;
      const finding = first.active[0]!.finding;

      memory.store({
        fingerprint: fp,
        check_id: finding.check_id,
        path: finding.path,
        verdict: "false_positive",
        reasoning: "test reasoning",
        key_evidence: ["evidence1"],
        tool_calls: [{ tool: "grep", args: { pattern: "test" } }],
        input_tokens: 100,
        output_tokens: 50,
      });

      const second = orchestrator.loadFindings(fixturePath);
      const cached = second.active.find((s) => s.entry.fingerprint === fp)!;
      expect(cached.verdict?.verdict).toBe("false_positive");
      expect(cached.cachedAt).toBeTruthy();
      expect(cached.entry.status).toBe("false_positive");
      expect(cached.events.length).toBeGreaterThan(0);
      expect(cached.events.some((e) => e.type === "verdict")).toBe(true);
    });

    it("throws on nonexistent file", () => {
      const { orchestrator } = createOrchestrator();
      expect(() => orchestrator.loadFindings("/nonexistent/file.json")).toThrow();
    });
  });

  describe("triageBatch", () => {
    it("runs findings concurrently up to the limit", async () => {
      const { orchestrator } = createOrchestrator();
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      orchestrator.triage = vi.fn(async (...args: Parameters<typeof orchestrator.triage>) => {
        currentConcurrent++;
        if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
        // Must be longer than the 500ms stagger delay so concurrent calls overlap
        await new Promise((r) => setTimeout(r, 1500));
        currentConcurrent--;
        return {
          verdict: { verdict: "false_positive" as const, reasoning: "test", key_evidence: [], suggested_fix: undefined },
          toolCalls: [],
          inputTokens: 10,
          outputTokens: 5,
        };
      });

      const fixturePath = resolve(import.meta.dirname, "fixtures/semgrep-output.json");
      const loaded = orchestrator.loadFindings(fixturePath);
      const base = loaded.active.map((s) => ({
        finding: s.finding,
        fingerprint: s.entry.fingerprint,
      }));
      // Repeat items to get at least 6
      const items: typeof base = [];
      while (items.length < 6) {
        for (const b of base) {
          items.push({ ...b, fingerprint: `${b.fingerprint}-${items.length}` });
          if (items.length >= 6) break;
        }
      }

      const config = {
        findingsPath: fixturePath,
        provider: "openai",
        model: "gpt-4o",
        headless: false,
        allowBash: false,
        maxSteps: 15,
        memoryDb: ":memory:",
        concurrency: 3,
      };

      const results: any[] = [];
      await orchestrator.triageBatch(items, config, 3, (fingerprint, result) => {
        results.push({ fingerprint, result });
      });

      expect(orchestrator.triage).toHaveBeenCalledTimes(6);
      expect(maxConcurrent).toBeLessThanOrEqual(3);
      expect(maxConcurrent).toBeGreaterThan(1);
      expect(results).toHaveLength(6);
    });

    it("respects abort signal to stop dispatching new items", async () => {
      const { orchestrator } = createOrchestrator();
      let callCount = 0;

      orchestrator.triage = vi.fn(async () => {
        callCount++;
        await new Promise((r) => setTimeout(r, 100));
        return {
          verdict: { verdict: "false_positive" as const, reasoning: "test", key_evidence: [], suggested_fix: undefined },
          toolCalls: [],
          inputTokens: 10,
          outputTokens: 5,
        };
      }) as any;

      const fixturePath = resolve(import.meta.dirname, "fixtures/semgrep-output.json");
      const loaded = orchestrator.loadFindings(fixturePath);
      const base = loaded.active.map((s) => ({
        finding: s.finding,
        fingerprint: s.entry.fingerprint,
      }));
      const items: typeof base = [];
      while (items.length < 6) {
        for (const b of base) {
          items.push({ ...b, fingerprint: `${b.fingerprint}-${items.length}` });
          if (items.length >= 6) break;
        }
      }

      const config = {
        findingsPath: fixturePath, provider: "openai", model: "gpt-4o",
        headless: false, allowBash: false, maxSteps: 15, memoryDb: ":memory:", concurrency: 2,
      };

      const abortController = new AbortController();
      setTimeout(() => abortController.abort(), 50);

      await orchestrator.triageBatch(items, config, 2, () => {}, abortController.signal);
      expect(callCount).toBeLessThan(6);
    });
  });
});

describe("TriageOrchestrator.triageBatch — error rows", () => {
  it("emits error result via onResult when triage throws", async () => {
    const memory = {
      lookupCached: () => null,
      store: vi.fn(),
      close: () => {},
      getHints: () => [],
    } as never;
    const orch = new TriageOrchestrator(memory);

    vi.spyOn(orch, "triage" as never).mockRejectedValue(new Error("provider 500"));

    const finding = makeMinimalFinding();
    const items = [{ finding, fingerprint: "fp1" }];

    const config: AppConfig = {
      findingsPath: "findings.json",
      provider: "openai",
      model: "gpt-4o",
      headless: true,
      allowBash: false,
      maxSteps: 15,
      memoryDb: ":memory:",
    };

    const results: Array<{ fp: string; result: unknown }> = [];
    await orch.triageBatch(
      items,
      config,
      1,
      (fp, result) => { results.push({ fp, result }); },
      undefined,
      () => {},
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.fp).toBe("fp1");
    const r = results[0]!.result as { verdict: { verdict: string; reasoning: string } };
    expect(r.verdict.verdict).toBe("error");
    expect(r.verdict.reasoning).toMatch(/provider 500/);
  });
});

describe("TriageOrchestrator.run — cached findings", () => {
  let workspace: string;
  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), "sast-cached-")); });
  afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

  it("emits cached rows without invoking triage; fresh rows go through triage", async () => {
    const findingsJson = {
      version: "1.50.0",
      results: [
        { check_id: "rule-1", path: "a.ts", start: { line: 1, col: 0 }, end: { line: 1, col: 0 },
          extra: { message: "m1", severity: "WARNING", metadata: { cwe: [] } } },
        { check_id: "rule-2", path: "b.ts", start: { line: 1, col: 0 }, end: { line: 1, col: 0 },
          extra: { message: "m2", severity: "WARNING", metadata: { cwe: [] } } },
      ],
      errors: [], paths: { scanned: ["a.ts", "b.ts"] },
    };
    const findingsPath = join(workspace, "findings.json");
    writeFileSync(findingsPath, JSON.stringify(findingsJson));
    writeFileSync(join(workspace, "a.ts"), "// a");
    writeFileSync(join(workspace, "b.ts"), "// b");

    // Compute the actual fingerprints used by the orchestrator (sha256 hash slice,
    // not a "rule-1..."-prefixed string).
    const fpRule1 = fingerprintFinding({
      check_id: "rule-1", path: "a.ts",
      start: { line: 1, col: 0, offset: 0 }, end: { line: 1, col: 0, offset: 0 },
      extra: { message: "m1", severity: "WARNING", metadata: { cwe: [], confidence: "MEDIUM", category: "security", technology: [], owasp: [], vulnerability_class: [] }, lines: "", metavars: {} },
    } as Finding);

    const memory = {
      lookupCached: vi.fn().mockImplementation((fp: string) => {
        if (fp === fpRule1) {
          return {
            verdict: { verdict: "false_positive", reasoning: "prior audit", key_evidence: ["sanitizer"] },
            tool_calls: [{ tool: "read", args: { path: "a.ts" } }],
            input_tokens: 100, output_tokens: 50,
            updated_at: "2026-04-01T00:00:00Z",
          };
        }
        return null;
      }),
      store: vi.fn(),
      getHints: () => [],
      close: () => {},
    } as never;

    const orch = new TriageOrchestrator(memory);
    const triageSpy = vi.spyOn(orch, "triage").mockResolvedValue({
      verdict: { verdict: "true_positive", reasoning: "fresh", key_evidence: [] },
      toolCalls: [{ tool: "grep", args: { pattern: "x" } }],
      inputTokens: 200, outputTokens: 80,
    } as never);

    const outputPath = join(workspace, "out.json");
    const cwdBefore = process.cwd();
    process.chdir(workspace);
    try {
      await orch.run({
        provider: "openai", model: "gpt-4o", apiKey: "k",
        findingsPath, outputPath,
        memoryDb: join(workspace, "mem.db"),
        allowBash: false, maxSteps: 5, concurrency: 1,
        baseUrl: undefined, reasoningEffort: undefined,
        headless: true,
      } as never);
    } finally {
      process.chdir(cwdBefore);
    }

    expect(triageSpy).toHaveBeenCalledTimes(1);

    const out = JSON.parse(readFileSync(outputPath, "utf-8"));
    expect(out.summary.total).toBe(2);
    expect(out.summary.cached).toBe(1);
    expect(out.findings).toHaveLength(2);
    const cachedRow = out.findings.find((r: { cached: boolean }) => r.cached);
    expect(cachedRow.verdict.verdict).toBe("false_positive");
    expect(cachedRow.audited_at).toBe("2026-04-01T00:00:00Z");
    const freshRow = out.findings.find((r: { cached: boolean }) => !r.cached);
    expect(freshRow.verdict.verdict).toBe("true_positive");
  });
});
