import { describe, it, expect } from "vitest";
import { resolveProvider, SUPPORTED_PROVIDERS } from "../../src/provider/registry.js";

describe("resolveProvider", () => {
  it("lists supported providers", () => {
    expect(SUPPORTED_PROVIDERS).toContain("openai");
    expect(SUPPORTED_PROVIDERS).toContain("anthropic");
    expect(SUPPORTED_PROVIDERS).toContain("google");
    expect(SUPPORTED_PROVIDERS).toContain("openrouter");
  });

  it("throws on unknown provider", () => {
    expect(() => resolveProvider("unknown", "model")).toThrow(/unknown provider/i);
  });

  it("accepts valid provider names", () => {
    for (const p of SUPPORTED_PROVIDERS) {
      expect(() => resolveProvider(p, "test-model")).not.toThrow(/unknown provider/i);
    }
  });
});
