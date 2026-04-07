import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { SUPPORTED_PROVIDERS, type ProviderName } from "../provider/registry.js";
import type { ReasoningEffort } from "../provider/reasoning.js";

const TOML_FILE = ".sast-triage.toml";

const ENV_KEYS: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  fpt: "FPT_API_KEY",
};

export class ProjectConfig {
  private workspace: string;

  provider: ProviderName = "openai";
  model = "gpt-4o";
  apiKey: string | undefined;
  baseUrl: string | undefined;
  memoryDbPath: string;
  reasoningEffort: ReasoningEffort | undefined;
  allowedPaths: string[] = [];
  concurrency = 1;
  savedApiKeys: Partial<Record<ProviderName, string>> = {};

  constructor(workspace: string) {
    this.workspace = workspace;
    this.memoryDbPath = join(workspace, ".sast-triage", "memory.db");
    this.load();
  }

  private get tomlPath(): string {
    return join(this.workspace, TOML_FILE);
  }

  hasConfig(): boolean {
    return existsSync(this.tomlPath);
  }

  private load(): void {
    if (!this.hasConfig()) return;
    const raw = readFileSync(this.tomlPath, "utf-8");
    const data = parse(raw) as Record<string, unknown>;

    const provider = data.provider as Record<string, unknown> | undefined;
    if (provider) {
      if (typeof provider.name === "string" && SUPPORTED_PROVIDERS.includes(provider.name as ProviderName)) {
        this.provider = provider.name as ProviderName;
      }
      if (typeof provider.model === "string") {
        this.model = provider.model;
      }
      if (typeof provider.base_url === "string") {
        this.baseUrl = provider.base_url;
      }

      const apiKeys = provider.api_keys as Record<string, string> | undefined;
      if (apiKeys) {
        // Store all provider keys so detectedProviders() can show them
        for (const [name, key] of Object.entries(apiKeys)) {
          if (SUPPORTED_PROVIDERS.includes(name as ProviderName) && typeof key === "string") {
            this.savedApiKeys[name as ProviderName] = key;
          }
        }
        // Try current provider first, then any key
        const key = apiKeys[this.provider] ?? Object.values(apiKeys)[0];
        if (key) this.apiKey = key;
      }

      if (typeof provider.reasoning_effort === "string") {
        const effort = provider.reasoning_effort;
        if (effort === "low" || effort === "medium" || effort === "high") {
          this.reasoningEffort = effort;
        }
      }
    }

    const memory = data.memory as Record<string, unknown> | undefined;
    if (memory && typeof memory.db_path === "string") {
      this.memoryDbPath = join(this.workspace, memory.db_path);
    }

    const workspace = data.workspace as Record<string, unknown> | undefined;
    if (workspace && Array.isArray(workspace.allowed_paths)) {
      this.allowedPaths = workspace.allowed_paths.filter(
        (p): p is string => typeof p === "string",
      );
    }

    const triage = data.triage as Record<string, unknown> | undefined;
    if (triage) {
      if (typeof triage.concurrency === "number" && triage.concurrency >= 1 && triage.concurrency <= 10) {
        this.concurrency = triage.concurrency;
      }
    }
  }

  save(): void {
    // Merge current apiKey into savedApiKeys so keys persist across provider switches
    if (this.apiKey) {
      this.savedApiKeys[this.provider] = this.apiKey;
    }
    const apiKeys = Object.fromEntries(
      Object.entries(this.savedApiKeys).filter(([, v]) => v),
    );
    const data: Record<string, unknown> = {
      provider: {
        name: this.provider,
        model: this.model,
        ...(Object.keys(apiKeys).length > 0 ? { api_keys: apiKeys } : {}),
        ...(this.baseUrl ? { base_url: this.baseUrl } : {}),
        ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
      },
      memory: {
        db_path: ".sast-triage/memory.db",
      },
      ...(this.allowedPaths.length > 0
        ? { workspace: { allowed_paths: this.allowedPaths } }
        : {}),
      ...(this.concurrency > 1 ? { triage: { concurrency: this.concurrency } } : {}),
    };
    writeFileSync(this.tomlPath, stringify(data) + "\n");
  }

  detectedProviders(): { name: ProviderName; hasKey: boolean }[] {
    return SUPPORTED_PROVIDERS.map((name) => ({
      name,
      hasKey: !!process.env[ENV_KEYS[name]] || !!this.savedApiKeys[name],
    }));
  }

  /** Returns API key: explicit override > saved > env var */
  resolvedApiKey(): string | undefined {
    return this.apiKey ?? this.savedApiKeys[this.provider] ?? process.env[ENV_KEYS[this.provider]];
  }
}
