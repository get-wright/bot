export type ReasoningEffort = "low" | "medium" | "high";

const ANTHROPIC_BUDGETS: Record<ReasoningEffort, number> = {
  low: 4096,
  medium: 10000,
  high: 32000,
};

const GOOGLE_BUDGETS: Record<ReasoningEffort, number> = {
  low: 4096,
  medium: 10000,
  high: 32000,
};

export function resolveProviderOptions(
  provider: string,
  effort: ReasoningEffort,
): Record<string, Record<string, unknown>> {
  switch (provider) {
    case "openai":
    case "openrouter":
      return { openai: { reasoningEffort: effort } };
    case "anthropic":
      return {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: ANTHROPIC_BUDGETS[effort] },
        },
      };
    case "google":
      return {
        google: {
          thinkingConfig: { thinkingBudget: GOOGLE_BUDGETS[effort] },
        },
      };
    default:
      return {};
  }
}
