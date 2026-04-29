import { describe, it, expect } from "vitest";
import { resolveProviderOptions } from "../../../src/infra/providers/reasoning.js";

describe("resolveProviderOptions", () => {
  it("returns OpenAI reasoningEffort for openai provider", () => {
    const opts = resolveProviderOptions("openai", "medium");
    expect(opts).toEqual({ openai: { reasoningEffort: "medium" } });
  });

  it("returns OpenAI reasoningEffort for openrouter provider", () => {
    const opts = resolveProviderOptions("openrouter", "high");
    expect(opts).toEqual({ openai: { reasoningEffort: "high" } });
  });

  it("returns Anthropic thinking budget for anthropic provider", () => {
    const opts = resolveProviderOptions("anthropic", "low");
    expect(opts).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
    });
  });

  it("returns Anthropic thinking budget for medium effort", () => {
    const opts = resolveProviderOptions("anthropic", "medium");
    expect(opts).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 10000 } },
    });
  });

  it("returns Anthropic thinking budget for high effort", () => {
    const opts = resolveProviderOptions("anthropic", "high");
    expect(opts).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 32000 } },
    });
  });

  it("returns Google thinkingConfig for google provider", () => {
    const opts = resolveProviderOptions("google", "medium");
    expect(opts).toEqual({
      google: { thinkingConfig: { thinkingBudget: 10000 } },
    });
  });

  it("returns OpenAI reasoningEffort for fpt provider", () => {
    const opts = resolveProviderOptions("fpt", "high");
    expect(opts).toEqual({ openai: { reasoningEffort: "high" } });
  });

  it("maps all effort levels correctly", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      const opts = resolveProviderOptions("openai", effort);
      expect(opts.openai.reasoningEffort).toBe(effort);
    }
  });
});
