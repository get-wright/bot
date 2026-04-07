import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { TriageOrchestrator } from "../src/orchestrator.js";
import { MemoryStore } from "../src/memory/store.js";

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
        await new Promise((r) => setTimeout(r, 50));
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
