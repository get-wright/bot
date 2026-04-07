import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

  it("save() writes toml and round-trips", () => {
    const cfg = new ProjectConfig(workspace);
    cfg.provider = "google";
    cfg.model = "gemini-2.5-pro";
    cfg.apiKey = "AIza-test";
    cfg.save();

    const raw = readFileSync(join(workspace, ".sast-triage.toml"), "utf-8");
    expect(raw).toContain('name = "google"');
    expect(raw).toContain('model = "gemini-2.5-pro"');
    expect(raw).toContain('google = "AIza-test"');

    // Round-trip
    const cfg2 = new ProjectConfig(workspace);
    expect(cfg2.provider).toBe("google");
    expect(cfg2.model).toBe("gemini-2.5-pro");
    expect(cfg2.apiKey).toBe("AIza-test");
  });

  it("detectedProviders checks env vars", () => {
    const cfg = new ProjectConfig(workspace);
    const detected = cfg.detectedProviders();
    // At minimum returns all 5 providers with hasKey booleans
    expect(detected).toHaveLength(5);
    expect(detected[0]).toHaveProperty("name");
    expect(detected[0]).toHaveProperty("hasKey");
  });

  it("hasConfig() returns false with no toml, true after save", () => {
    const cfg = new ProjectConfig(workspace);
    expect(cfg.hasConfig()).toBe(false);
    cfg.save();
    expect(cfg.hasConfig()).toBe(true);
  });

  it("loads and saves reasoning_effort", () => {
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

    cfg.reasoningEffort = "low";
    cfg.save();

    const cfg2 = new ProjectConfig(workspace);
    expect(cfg2.reasoningEffort).toBe("low");
  });

  it("loads and saves allowed_paths", () => {
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

    cfg.allowedPaths = ["/new/path"];
    cfg.save();

    const cfg2 = new ProjectConfig(workspace);
    expect(cfg2.allowedPaths).toEqual(["/new/path"]);
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

  it("persists and loads concurrency setting", () => {
    const cfg = new ProjectConfig(workspace);
    cfg.concurrency = 5;
    cfg.save();

    const cfg2 = new ProjectConfig(workspace);
    expect(cfg2.concurrency).toBe(5);
  });
});
