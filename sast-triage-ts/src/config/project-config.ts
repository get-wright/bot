import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { SUPPORTED_PROVIDERS, type ProviderName } from "../provider/registry.js";

const TOML_FILE = ".sast-triage.toml";

const ENV_KEYS: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export class ProjectConfig {
  private workspace: string;

  provider: ProviderName = "openai";
  model = "gpt-4o";
  apiKey: string | undefined;
  memoryDbPath: string;

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

      const apiKeys = provider.api_keys as Record<string, string> | undefined;
      if (apiKeys) {
        // Try current provider first, then any key
        const key = apiKeys[this.provider] ?? Object.values(apiKeys)[0];
        if (key) this.apiKey = key;
      }
    }

    const memory = data.memory as Record<string, unknown> | undefined;
    if (memory && typeof memory.db_path === "string") {
      this.memoryDbPath = join(this.workspace, memory.db_path);
    }
  }

  save(): void {
    const data: Record<string, unknown> = {
      provider: {
        name: this.provider,
        model: this.model,
        ...(this.apiKey ? { api_keys: { [this.provider]: this.apiKey } } : {}),
      },
      memory: {
        db_path: ".sast-triage/memory.db",
      },
    };
    writeFileSync(this.tomlPath, stringify(data) + "\n");
  }

  detectedProviders(): { name: ProviderName; hasKey: boolean }[] {
    return SUPPORTED_PROVIDERS.map((name) => ({
      name,
      hasKey: !!process.env[ENV_KEYS[name]],
    }));
  }

  /** Returns API key: explicit override > toml > env var */
  resolvedApiKey(): string | undefined {
    return this.apiKey ?? process.env[ENV_KEYS[this.provider]];
  }
}
