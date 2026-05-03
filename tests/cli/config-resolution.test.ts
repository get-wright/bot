import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveConfig } from "../../src/cli/config.js";
import { ProjectConfig } from "../../src/cli/project-config.js";

const ENV_KEYS = [
  "SAST_PROVIDER", "SAST_MODEL", "SAST_API_KEY", "SAST_BASE_URL",
  "SAST_EFFORT", "SAST_MAX_STEPS", "SAST_CONCURRENCY", "SAST_ALLOW_BASH",
  "SAST_FINDINGS", "SAST_OUTPUT",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
];

let saved: Record<string, string | undefined>;
let workspace: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  workspace = mkdtempSync(join(tmpdir(), "sast-cfg-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function writeToml(content: string): ProjectConfig {
  writeFileSync(join(workspace, ".sast-triage.toml"), content);
  return new ProjectConfig(workspace);
}

describe("resolveConfig precedence: CLI > env > TOML > default", () => {
  it("CLI flag overrides env var", () => {
    process.env.SAST_PROVIDER = "anthropic";
    const cfg = resolveConfig({ provider: "openai" });
    expect(cfg.provider).toBe("openai");
  });

  it("env var beats TOML", () => {
    const toml = writeToml(`[provider]\nname = "google"\nmodel = "gemini-2"\n`);
    process.env.SAST_PROVIDER = "anthropic";
    const cfg = resolveConfig({}, toml);
    expect(cfg.provider).toBe("anthropic");
  });

  it("TOML beats default when CLI and env absent", () => {
    const toml = writeToml(`[provider]\nname = "google"\nmodel = "gemini-2"\n`);
    const cfg = resolveConfig({}, toml);
    expect(cfg.provider).toBe("google");
    expect(cfg.model).toBe("gemini-2");
  });

  it("CLI beats TOML model", () => {
    const toml = writeToml(`[provider]\nname = "openai"\nmodel = "gpt-4o"\n`);
    const cfg = resolveConfig({ model: "gpt-4o-mini" }, toml);
    expect(cfg.model).toBe("gpt-4o-mini");
  });

  it("default used when CLI, env, TOML all absent", () => {
    const cfg = resolveConfig({});
    expect(cfg.provider).toBeUndefined();
    expect(cfg.model).toBeUndefined();
  });

  it("max-steps env parses to number", () => {
    process.env.SAST_MAX_STEPS = "50";
    const cfg = resolveConfig({});
    expect(cfg.maxSteps).toBe(50);
  });

  it("CLI max-steps overrides env", () => {
    process.env.SAST_MAX_STEPS = "50";
    const cfg = resolveConfig({ maxSteps: 100 });
    expect(cfg.maxSteps).toBe(100);
  });

  it("allow-bash env coerces from '1' to true", () => {
    process.env.SAST_ALLOW_BASH = "1";
    const cfg = resolveConfig({});
    expect(cfg.allowBash).toBe(true);
  });

  it("default outputPath ends in findings-out.json", () => {
    const cfg = resolveConfig({});
    expect(cfg.outputPath).toMatch(/findings-out\.json$/);
  });

  it("API key resolution follows selected provider, not TOML default", () => {
    const toml = writeToml(`
[provider]
name = "openai"
model = "gpt-4o"

[provider.api_keys]
openai = "openai-key"
anthropic = "anthropic-key"
`);
    const cfg = resolveConfig({ provider: "anthropic" }, toml);
    expect(cfg.apiKey).toBe("anthropic-key");
  });

  it("API key falls back to env var matching selected provider (with TOML)", () => {
    const toml = writeToml(`[provider]\nname = "openai"\nmodel = "gpt-4o"\n`);
    process.env.ANTHROPIC_API_KEY = "env-anthropic";
    const cfg = resolveConfig({ provider: "anthropic" }, toml);
    expect(cfg.apiKey).toBe("env-anthropic");
  });

  it("API key falls back to provider env var WITHOUT a TOML", () => {
    process.env.OPENAI_API_KEY = "env-openai-only";
    const cfg = resolveConfig({ provider: "openai" });
    expect(cfg.apiKey).toBe("env-openai-only");
  });
});
