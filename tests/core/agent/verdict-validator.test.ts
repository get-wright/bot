import { describe, it, expect } from "vitest";
import { validateVerdict } from "../../../src/core/agent/verdict-validator.js";
import type { TriageVerdict } from "../../../src/core/models/verdict.js";

const baseTP: TriageVerdict = {
  verdict: "true_positive",
  reasoning: "req.params.id flows into Mongo find without sanitization.",
  key_evidence: ["routes/orderHistory.ts:36"],
  sink_line_quoted: "ordersCollection.update({ _id: req.params.id }",
  attacker_payload: "?id[$ne]=1",
};

describe("validateVerdict", () => {
  it("passes through when sink quote appears in a read output", () => {
    const reads = ["35\t\n36\tordersCollection.update({ _id: req.params.id }, { $set: ... })\n"];
    const out = validateVerdict(baseTP, reads);
    expect(out.verdict.verdict).toBe("true_positive");
    expect(out.downgraded).toBe(false);
  });

  it("downgrades true_positive to needs_review when sink quote is not in any read output", () => {
    const reads = ["// unrelated file content\n"];
    const out = validateVerdict(baseTP, reads);
    expect(out.verdict.verdict).toBe("needs_review");
    expect(out.downgraded).toBe(true);
    expect(out.verdict.reasoning).toContain("sink_line_quoted not found");
  });

  it("downgrades true_positive when attacker_payload is empty or 'N/A'", () => {
    const reads = ["35\t\n36\tordersCollection.update({ _id: req.params.id }, ...)\n"];
    const v: TriageVerdict = { ...baseTP, attacker_payload: "N/A" };
    const out = validateVerdict(v, reads);
    expect(out.verdict.verdict).toBe("needs_review");
    expect(out.downgraded).toBe(true);
    expect(out.verdict.reasoning).toContain("attacker_payload missing");
  });

  it("does NOT require attacker_payload when verdict is false_positive", () => {
    const reads = ["35\t\n36\tordersCollection.update({ _id: req.params.id }, ...)\n"];
    const v: TriageVerdict = { ...baseTP, verdict: "false_positive", attacker_payload: "" };
    const out = validateVerdict(v, reads);
    expect(out.verdict.verdict).toBe("false_positive");
    expect(out.downgraded).toBe(false);
  });

  it("downgrades false_positive to needs_review when sink quote is not found", () => {
    const v: TriageVerdict = { ...baseTP, verdict: "false_positive" };
    const out = validateVerdict(v, ["// unrelated content\n"]);
    expect(out.verdict.verdict).toBe("needs_review");
    expect(out.downgraded).toBe(true);
  });

  it("does not require sink quote when verdict is needs_review", () => {
    const v: TriageVerdict = { ...baseTP, verdict: "needs_review", sink_line_quoted: "" };
    const out = validateVerdict(v, []);
    expect(out.verdict.verdict).toBe("needs_review");
    expect(out.downgraded).toBe(false);
  });

  it("treats short quotes (<20 chars) as missing evidence and downgrades", () => {
    const reads = ["36\tfoo\n"];
    const v: TriageVerdict = { ...baseTP, sink_line_quoted: "foo" };
    const out = validateVerdict(v, reads);
    expect(out.verdict.verdict).toBe("needs_review");
    expect(out.downgraded).toBe(true);
  });
});
