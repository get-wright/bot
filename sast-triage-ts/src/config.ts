import type { ReasoningEffort } from "./provider/reasoning.js";

export interface AppConfig {
  findingsPath: string;
  provider: string;
  model: string;
  headless: boolean;
  allowBash: boolean;
  maxSteps: number;
  memoryDb: string;
  apiKey?: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
  allowedPaths?: string[];
  concurrency: number;
}

export function resolveConfig(opts: {
  findingsPath?: string;
  provider?: string;
  model?: string;
  headless?: boolean;
  allowBash?: boolean;
  maxSteps?: number;
  memoryDb?: string;
  concurrency?: number;
}): Partial<AppConfig> {
  return {
    findingsPath: opts.findingsPath || undefined,
    provider: opts.provider || undefined,
    model: opts.model || undefined,
    headless: opts.headless ?? false,
    allowBash: opts.allowBash ?? false,
    maxSteps: opts.maxSteps ?? 15,
    memoryDb: opts.memoryDb ?? ".sast-triage/memory.db",
    concurrency: opts.concurrency ?? 1,
  };
}
