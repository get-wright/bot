import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

export const SUPPORTED_PROVIDERS = ["openai", "anthropic", "google", "openrouter"] as const;
export type ProviderName = (typeof SUPPORTED_PROVIDERS)[number];

const ENV_KEYS: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export function detectProviders(): { name: ProviderName; hasKey: boolean }[] {
  return SUPPORTED_PROVIDERS.map((name) => ({
    name,
    hasKey: !!process.env[ENV_KEYS[name]],
  }));
}

export function resolveProvider(provider: string, model: string, apiKey?: string): LanguageModel {
  if (!SUPPORTED_PROVIDERS.includes(provider as ProviderName)) {
    throw new Error(`Unknown provider: "${provider}". Supported: ${SUPPORTED_PROVIDERS.join(", ")}`);
  }

  const name = provider as ProviderName;
  const resolvedKey = apiKey ?? process.env[ENV_KEYS[name]];

  switch (name) {
    case "openai": {
      const openai = createOpenAI({ apiKey: resolvedKey });
      return openai(model);
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: resolvedKey });
      return anthropic(model);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey: resolvedKey });
      return google(model);
    }
    case "openrouter": {
      const openrouter = createOpenRouter({ apiKey: resolvedKey });
      return openrouter(model) as unknown as LanguageModel;
    }
  }
}
