import { existsSync } from "node:fs";
import type { ReasoningEffort } from "./provider/reasoning.js";

export interface AppConfig {
  findingsPath: string;
  outputPath: string;
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
  concurrency?: number;
}

export interface ResolveOpts {
  findingsPath?: string;
  outputPath?: string;
  provider?: string;
  model?: string;
  headless?: boolean;
  allowBash?: boolean;
  maxSteps?: number;
  memoryDb?: string;
  concurrency?: number;
}

export function resolveConfig(opts: ResolveOpts): Partial<AppConfig> {
  return {
    findingsPath: opts.findingsPath || undefined,
    outputPath: opts.outputPath ?? process.env.SAST_OUTPUT ?? defaultOutputPath(),
    provider: opts.provider || undefined,
    model: opts.model || undefined,
    headless: opts.headless ?? false,
    allowBash: opts.allowBash ?? false,
    maxSteps: opts.maxSteps ?? 25,
    memoryDb: opts.memoryDb ?? ".sast-triage/memory.db",
    concurrency: opts.concurrency ?? 1,
  };
}

function defaultOutputPath(): string {
  return existsSync("/work") ? "/work/findings-out.json" : "./findings-out.json";
}
