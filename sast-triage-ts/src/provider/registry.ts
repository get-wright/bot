import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { log } from "../logger.js";

export const SUPPORTED_PROVIDERS = ["openai", "anthropic", "google", "openrouter", "fpt"] as const;
export type ProviderName = (typeof SUPPORTED_PROVIDERS)[number];

const ENV_KEYS: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  fpt: "FPT_API_KEY",
};

export const PROVIDER_DISPLAY_NAMES: Record<ProviderName, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google AI",
  openrouter: "OpenRouter",
  fpt: "FPT AI Marketplace",
};

export function detectProviders(): { name: ProviderName; hasKey: boolean }[] {
  return SUPPORTED_PROVIDERS.map((name) => ({
    name,
    hasKey: !!process.env[ENV_KEYS[name]],
  }));
}

export function resolveProvider(provider: string, model: string, apiKey?: string, baseUrl?: string): LanguageModel {
  if (!SUPPORTED_PROVIDERS.includes(provider as ProviderName)) {
    throw new Error(`Unknown provider: "${provider}". Supported: ${SUPPORTED_PROVIDERS.join(", ")}`);
  }

  const name = provider as ProviderName;
  const resolvedKey = apiKey ?? process.env[ENV_KEYS[name]];
  log.info("provider", `Resolving ${name}/${model}`, { baseUrl: baseUrl ?? "default", hasKey: !!resolvedKey });

  switch (name) {
    case "openai": {
      const openai = createOpenAI({ apiKey: resolvedKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
      return openai(model);
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: resolvedKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
      return anthropic(model);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey: resolvedKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
      return google(model);
    }
    case "openrouter": {
      const openrouter = createOpenAI({
        apiKey: resolvedKey,
        baseURL: baseUrl ?? "https://openrouter.ai/api/v1",
      });
      return openrouter.chat(model);
    }
    case "fpt": {
      const fpt = createOpenAI({
        apiKey: resolvedKey,
        baseURL: baseUrl ?? "https://mkp-api.fptcloud.com/v1",
      });
      return fpt.chat(model);
    }
  }
}
