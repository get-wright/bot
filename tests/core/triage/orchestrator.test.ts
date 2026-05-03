import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { TriageOrchestrator } from "../../../src/core/triage/orchestrator.js";
import type { Finding } from "../../../src/core/models/finding.js";
import type { AppConfig } from "../../../src/cli/config.js";

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
  describe("loadFindings", () => {
    const fixturePath = resolve(import.meta.dirname, "../../fixtures/semgrep-output.json");

    it("parses and classifies findings from a file", () => {
      const orchestrator = new TriageOrchestrator();
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

    it("throws on nonexistent file", () => {
      const orchestrator = new TriageOrchestrator();
      expect(() => orchestrator.loadFindings("/nonexistent/file.json")).toThrow();
    });
  });

  describe("triageBatch", () => {
    it("runs findings concurrently up to the limit", async () => {
      const orchestrator = new TriageOrchestrator();
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

      const fixturePath = resolve(import.meta.dirname, "../../fixtures/semgrep-output.json");
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
        concurrency: 3,
      };

      const results: any[] = [];
      await orchestrator.triageBatch({
        items,
        config,
        concurrency: 3,
        onResult: (fingerprint, result) => {
          results.push({ fingerprint, result });
        },
      });

      expect(orchestrator.triage).toHaveBeenCalledTimes(6);
      expect(maxConcurrent).toBeLessThanOrEqual(3);
      expect(maxConcurrent).toBeGreaterThan(1);
      expect(results).toHaveLength(6);
    });

    it("respects abort signal to stop dispatching new items", async () => {
      const orchestrator = new TriageOrchestrator();
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

      const fixturePath = resolve(import.meta.dirname, "../../fixtures/semgrep-output.json");
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
        headless: false, allowBash: false, maxSteps: 15, concurrency: 2,
      };

      const abortController = new AbortController();
      setTimeout(() => abortController.abort(), 50);

      await orchestrator.triageBatch({
        items,
        config,
        concurrency: 2,
        onResult: () => {},
        abortSignal: abortController.signal,
      });
      expect(callCount).toBeLessThan(6);
    });
  });
});

describe("TriageOrchestrator.triageBatch — error rows", () => {
  it("emits error result via onResult when triage throws", async () => {
    const orch = new TriageOrchestrator();

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
    } as AppConfig;

    const results: Array<{ fp: string; result: unknown }> = [];
    await orch.triageBatch({
      items,
      config,
      concurrency: 1,
      onResult: (fp, result) => { results.push({ fp, result }); },
      onEvent: () => {},
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.fp).toBe("fp1");
    const r = results[0]!.result as { verdict: { verdict: string; reasoning: string } };
    expect(r.verdict.verdict).toBe("error");
    expect(r.verdict.reasoning).toMatch(/provider 500/);
  });
});
