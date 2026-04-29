import { describe, it, expect } from "vitest";
import { resolveProvider, SUPPORTED_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "../../src/provider/registry.js";

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

  it("includes fpt in supported providers", () => {
    expect(SUPPORTED_PROVIDERS).toContain("fpt");
  });

  it("exports display names for all providers", () => {
    for (const p of SUPPORTED_PROVIDERS) {
      expect(PROVIDER_DISPLAY_NAMES[p]).toBeDefined();
      expect(typeof PROVIDER_DISPLAY_NAMES[p]).toBe("string");
    }
    expect(PROVIDER_DISPLAY_NAMES.fpt).toBe("FPT AI Marketplace");
  });
});
