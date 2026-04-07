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
    case "fpt":
      return { openai: { reasoningEffort: effort } };
    case "openrouter":
      // OpenRouter proxies many providers — reasoningEffort only works
      // for OpenAI reasoning models (o1/o3). For other models it causes
      // empty responses. Skip provider options; models that support
      // reasoning will use their default behavior.
      return {};
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
