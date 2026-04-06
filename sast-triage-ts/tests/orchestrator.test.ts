import { describe, it, expect } from "vitest";
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
});
