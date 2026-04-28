import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ProjectConfig } from "../../src/config/project-config.js";

describe("ProjectConfig", () => {
  let workspace: string;

  beforeEach(({ task }) => {
    // vitest tmp directory — recreate fresh each run
    workspace = join(import.meta.dirname, ".tmp", task.id);
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
  });

  it("returns defaults when no toml exists", () => {
    const cfg = new ProjectConfig(workspace);
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-4o");
    expect(cfg.apiKey).toBeUndefined();
  });

  it("loads values from .sast-triage.toml", () => {
    writeFileSync(
      join(workspace, ".sast-triage.toml"),
      [
        "[provider]",
        'name = "anthropic"',
        'model = "claude-sonnet-4-20250514"',
        "",
        "[provider.api_keys]",
        'anthropic = "sk-ant-test"',
      ].join("\n"),
    );
    const cfg = new ProjectConfig(workspace);
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-20250514");
    expect(cfg.apiKey).toBe("sk-ant-test");
  });

  it("detectedProviders checks env vars", () => {
    const cfg = new ProjectConfig(workspace);
    const detected = cfg.detectedProviders();
    // At minimum returns all 5 providers with hasKey booleans
    expect(detected).toHaveLength(5);
    expect(detected[0]).toHaveProperty("name");
    expect(detected[0]).toHaveProperty("hasKey");
  });

  it("hasConfig() returns false when no toml exists", () => {
    const cfg = new ProjectConfig(workspace);
    expect(cfg.hasConfig()).toBe(false);
  });

  it("hasConfig() returns true when toml exists", () => {
    writeFileSync(
      join(workspace, ".sast-triage.toml"),
      '[provider]\nname = "openai"\nmodel = "gpt-4o"\n',
    );
    const cfg = new ProjectConfig(workspace);
    expect(cfg.hasConfig()).toBe(true);
  });

  it("loads reasoning_effort from toml", () => {
    writeFileSync(
      join(workspace, ".sast-triage.toml"),
      [
        "[provider]",
        'name = "openai"',
        'model = "o3-mini"',
        'reasoning_effort = "high"',
      ].join("\n"),
    );
    const cfg = new ProjectConfig(workspace);
    expect(cfg.reasoningEffort).toBe("high");
  });

  it("loads allowed_paths from toml", () => {
    writeFileSync(
      join(workspace, ".sast-triage.toml"),
      [
        "[provider]",
        'name = "openai"',
        'model = "gpt-4o"',
        "",
        "[workspace]",
        'allowed_paths = ["/tmp/extra", "/opt/lib"]',
      ].join("\n"),
    );
    const cfg = new ProjectConfig(workspace);
    expect(cfg.allowedPaths).toEqual(["/tmp/extra", "/opt/lib"]);
  });

  it("defaults reasoning_effort to undefined and allowed_paths to empty", () => {
    const cfg = new ProjectConfig(workspace);
    expect(cfg.reasoningEffort).toBeUndefined();
    expect(cfg.allowedPaths).toEqual([]);
  });

  it("defaults concurrency to 1", () => {
    const cfg = new ProjectConfig(workspace);
    expect(cfg.concurrency).toBe(1);
  });

  it("loads concurrency from toml", () => {
    writeFileSync(
      join(workspace, ".sast-triage.toml"),
      '[provider]\nname = "openai"\nmodel = "gpt-4o"\n\n[triage]\nconcurrency = 5\n',
    );
    const cfg = new ProjectConfig(workspace);
    expect(cfg.concurrency).toBe(5);
  });

  it("savedApiKeys populated from [provider.api_keys]", () => {
    writeFileSync(
      join(workspace, ".sast-triage.toml"),
      [
        "[provider]",
        'name = "openai"',
        'model = "gpt-4o"',
        "",
        "[provider.api_keys]",
        'openai = "sk-openai"',
        'anthropic = "sk-ant"',
      ].join("\n"),
    );
    const cfg = new ProjectConfig(workspace);
    expect(cfg.savedApiKeys.openai).toBe("sk-openai");
    expect(cfg.savedApiKeys.anthropic).toBe("sk-ant");
  });

  it("resolvedApiKey returns apiKey over savedApiKeys over env", () => {
    writeFileSync(
      join(workspace, ".sast-triage.toml"),
      [
        "[provider]",
        'name = "openai"',
        'model = "gpt-4o"',
        "",
        "[provider.api_keys]",
        'openai = "sk-saved"',
      ].join("\n"),
    );
    const cfg = new ProjectConfig(workspace);
    // savedApiKey picked up when no explicit override
    expect(cfg.resolvedApiKey()).toBe("sk-saved");
    // explicit override wins
    cfg.apiKey = "sk-explicit";
    expect(cfg.resolvedApiKey()).toBe("sk-explicit");
  });
});
