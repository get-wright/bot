import { describe, it, expect } from "vitest";
import { parseConcurrency } from "../../src/cli/cli.js";

describe("parseConcurrency", () => {
  it("returns undefined when no flag passed", () => {
    expect(parseConcurrency(undefined)).toBeUndefined();
  });

  it("parses positive integers", () => {
    expect(parseConcurrency("1")).toBe(1);
    expect(parseConcurrency("5")).toBe(5);
    expect(parseConcurrency("10")).toBe(10);
  });

  it("does NOT cap values above 10 — caller chose them deliberately", () => {
    expect(parseConcurrency("11")).toBe(11);
    expect(parseConcurrency("20")).toBe(20);
    expect(parseConcurrency("100")).toBe(100);
  });

  it("rejects non-positive values by returning undefined (orchestrator default applies)", () => {
    expect(parseConcurrency("0")).toBeUndefined();
    expect(parseConcurrency("-3")).toBeUndefined();
  });

  it("rejects non-numeric input by returning undefined", () => {
    expect(parseConcurrency("abc")).toBeUndefined();
    expect(parseConcurrency("")).toBeUndefined();
  });
});
