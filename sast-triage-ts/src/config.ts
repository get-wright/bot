export interface AppConfig {
  findingsPath: string;
  provider: string;
  model: string;
  headless: boolean;
  allowBash: boolean;
  maxSteps: number;
  memoryDb: string;
}

export function resolveConfig(opts: {
  findingsPath: string;
  provider: string;
  model: string;
  headless?: boolean;
  allowBash?: boolean;
  maxSteps?: number;
  memoryDb?: string;
}): AppConfig {
  return {
    findingsPath: opts.findingsPath,
    provider: opts.provider,
    model: opts.model,
    headless: opts.headless ?? false,
    allowBash: opts.allowBash ?? false,
    maxSteps: opts.maxSteps ?? 15,
    memoryDb: opts.memoryDb ?? ".sast-triage/memory.db",
  };
}
