import { existsSync } from "node:fs";
import type { ProjectConfig } from "./project-config.js";
import type { ProviderName } from "../infra/providers/registry.js";
import type { ReasoningEffort } from "../infra/providers/reasoning.js";

// Per-provider env var names (mirror src/config/project-config.ts ENV_KEYS).
const PROVIDER_ENV_KEYS: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  fpt: "FPT_API_KEY",
};

function resolveWorkers(value: number | "auto" | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value === "auto") {
    const cores = (globalThis as any).navigator?.hardwareConcurrency ?? 1;
    return Math.min(16, Math.max(1, cores));
  }
  if (typeof value === "number" && value >= 1 && value <= 16) return value;
  return undefined;
}

/**
 * Pre-validation config. Used to inspect what was supplied before required-field
 * validation. Orchestrator never sees this type.
 */
export interface ResolvedConfig {
  provider: ProviderName | undefined;
  model: string | undefined;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  findingsPath: string | undefined;
  outputPath: string;
  allowBash: boolean;
  maxSteps: number;
  concurrency: number;
  workers: number;
  workerRestart: boolean;
  reasoningEffort: ReasoningEffort | undefined;
  headless: true;
}

/**
 * Validated config. Required fields guaranteed populated. Orchestrator consumes this.
 */
export interface AppConfig extends ResolvedConfig {
  provider: ProviderName;
  model: string;
  apiKey: string;
  findingsPath: string;
}

export interface ResolveOpts {
  findingsPath?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  allowBash?: boolean;
  maxSteps?: number;
  concurrency?: number;
  workers?: number | "auto";
  workerRestart?: boolean;
  outputPath?: string;
  reasoningEffort?: string;
}

export function resolveConfig(opts: ResolveOpts, toml?: ProjectConfig): ResolvedConfig {
  const env = process.env;
  const num = (s: string | undefined) => s === undefined ? undefined : Number(s);
  const bool = (s: string | undefined): boolean | undefined =>
    s === undefined ? undefined : (s === "1" || s === "true");

  const provider = (opts.provider ?? env.SAST_PROVIDER ?? toml?.provider) as ProviderName | undefined;

  // API key precedence: --api-key > SAST_API_KEY > TOML's resolvedApiKey(provider) > <PROVIDER>_API_KEY.
  // Provider-env fallback works EVEN WITHOUT a TOML.
  const providerEnvKey = provider ? env[PROVIDER_ENV_KEYS[provider]] : undefined;
  const apiKey = opts.apiKey
              ?? env.SAST_API_KEY
              ?? (provider && toml ? toml.resolvedApiKey(provider) : undefined)
              ?? providerEnvKey;

  return {
    provider,
    model: opts.model ?? env.SAST_MODEL ?? toml?.model,
    apiKey,
    baseUrl: opts.baseUrl ?? env.SAST_BASE_URL ?? toml?.baseUrl,
    findingsPath: opts.findingsPath ?? env.SAST_FINDINGS ?? defaultFindingsPath(),
    outputPath: opts.outputPath ?? env.SAST_OUTPUT ?? defaultOutputPath(),
    allowBash: opts.allowBash ?? bool(env.SAST_ALLOW_BASH) ?? false,
    maxSteps: opts.maxSteps ?? num(env.SAST_MAX_STEPS) ?? 20,
    concurrency: opts.concurrency ?? num(env.SAST_CONCURRENCY) ?? toml?.concurrency ?? 1,
    workers: resolveWorkers(opts.workers)
          ?? resolveWorkers(env.SAST_WORKERS === "auto" ? "auto" : num(env.SAST_WORKERS) as number | undefined)
          ?? toml?.workers
          ?? 1,
    workerRestart: opts.workerRestart
                ?? bool(env.SAST_WORKER_RESTART)
                ?? toml?.workerRestart
                ?? false,
    reasoningEffort: (opts.reasoningEffort ?? env.SAST_EFFORT ?? toml?.reasoningEffort) as ReasoningEffort | undefined,
    headless: true,
  };
}

function defaultOutputPath(): string {
  return existsSync("/work") ? "/work/findings-out.json" : "./findings-out.json";
}
function defaultFindingsPath(): string | undefined {
  if (existsSync("/work/findings.json")) return "/work/findings.json";
  return undefined;
}

/**
 * Validate a resolved config has all required fields populated.
 * Exits process with code 1 and a clear message on failure; returns AppConfig on success.
 */
export function validateConfig(resolved: ResolvedConfig): AppConfig {
  const missing: string[] = [];
  if (!resolved.provider) missing.push("--provider / SAST_PROVIDER / [provider] name");
  if (!resolved.model) missing.push("--model / SAST_MODEL / [provider] model");
  if (!resolved.findingsPath) missing.push("findings argument / SAST_FINDINGS");
  if (missing.length > 0) {
    console.error(`Missing required config: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!resolved.apiKey) {
    console.error(
      `Missing API key for provider ${resolved.provider}. Set --api-key, SAST_API_KEY, or ${PROVIDER_ENV_KEYS[resolved.provider!]}.`,
    );
    process.exit(1);
  }
  return resolved as AppConfig;
}
