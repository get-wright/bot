import { describe, it, expect } from "vitest";
import { parseWorkers } from "../../src/cli/cli.js";

describe("parseWorkers", () => {
  it("returns undefined when no flag passed", () => {
    expect(parseWorkers(undefined)).toBeUndefined();
  });

  it("parses 'auto' as the literal", () => {
    expect(parseWorkers("auto")).toBe("auto");
  });

  it("parses positive integers in range 1..16", () => {
    expect(parseWorkers("1")).toBe(1);
    expect(parseWorkers("4")).toBe(4);
    expect(parseWorkers("16")).toBe(16);
  });

  // Bug 3 regression: out-of-range values used to silently fall through to
  // default 1 (parseWorkers returned the value, resolveWorkers rejected it,
  // resolveConfig defaulted to 1). Now they throw with a clear message so
  // the CLI can surface the error instead of silently single-threading.
  it("throws on values above the 1..16 range", () => {
    expect(() => parseWorkers("17")).toThrow(/1\.\.16|range/i);
    expect(() => parseWorkers("20")).toThrow(/1\.\.16|range/i);
    expect(() => parseWorkers("100")).toThrow(/1\.\.16|range/i);
  });

  it("throws on non-positive values", () => {
    expect(() => parseWorkers("0")).toThrow(/1\.\.16|positive/i);
    expect(() => parseWorkers("-3")).toThrow(/1\.\.16|positive/i);
  });

  it("throws on non-numeric input", () => {
    expect(() => parseWorkers("abc")).toThrow();
    expect(() => parseWorkers("")).toThrow();
  });
});
