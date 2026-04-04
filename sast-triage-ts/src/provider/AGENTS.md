# Provider Subsystem

Multi-provider LLM resolution via AI SDK v5.

## Key Files

- `registry.ts` — `resolveProvider(provider, model, apiKey?, baseUrl?)` returns AI SDK model instance. `SUPPORTED_PROVIDERS` list. `detectedProviders()` checks env vars for key availability.
- `reasoning.ts` — `resolveProviderOptions(provider, effort)` maps `"low"|"medium"|"high"` to provider-specific `providerOptions`.

## Provider Resolution

| Provider | SDK | Notes |
|----------|-----|-------|
| openai | `@ai-sdk/openai` | Direct |
| anthropic | `@ai-sdk/anthropic` | Direct |
| google | `@ai-sdk/google` | Direct |
| openrouter | `@ai-sdk/openai` | `createOpenAI({ baseURL })` — must use `.chat(model)` not `provider(model)` to avoid Responses API |

## Reasoning Effort Mapping

| Effort | OpenAI/OpenRouter | Anthropic | Google |
|--------|-------------------|-----------|--------|
| low | `reasoningEffort: "low"` | `thinking.budgetTokens: 1024` | `thinkingBudget: 1024` |
| medium | `reasoningEffort: "medium"` | `thinking.budgetTokens: 8192` | `thinkingBudget: 8192` |
| high | `reasoningEffort: "high"` | `thinking.budgetTokens: 32768` | `thinkingBudget: 32768` |

Returns `undefined` when effort is unset (provider uses its default).
