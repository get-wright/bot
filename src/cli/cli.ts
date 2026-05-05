#!/usr/bin/env node

import { resolve } from "node:path";
import { Command } from "commander";
import { resolveConfig, validateConfig } from "./config.js";
import { ProjectConfig } from "./project-config.js";
import { TriageOrchestrator } from "../core/triage/orchestrator.js";
import { initLogger, log } from "../infra/logger.js";
import { initTracing, hasLangSmithConfig } from "../infra/tracing.js";

export function parseConcurrency(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return n;
}

export function parseWorkers(raw: string | undefined): number | "auto" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "auto") return "auto";
  const n = parseInt(raw, 10);
  // Strict range validation: silently falling back to default 1 (the prior
  // behavior) made `--workers 20` hard to diagnose because the user got
  // single-threaded execution with no warning. Throw with a clear message
  // and let the CLI surface it to stderr.
  if (!Number.isFinite(n) || n < 1 || n > 16) {
    throw new Error(
      `--workers must be a positive integer 1..16 or 'auto', got: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

export function run(): void {
  const program = new Command();

  program
    .name("sast-triage")
    .description("Agentic SAST finding triage via LLM-driven codebase exploration (headless)")
    .version("0.2.0")
    .argument("[findings]", "Path to Semgrep JSON file (or use --input / SAST_FINDINGS)")
    .option("--input <path>", "Path to Semgrep JSON file (alias for positional arg, or set SAST_FINDINGS)")
    .option("--provider <provider>", "LLM provider (openai, anthropic, google, openrouter, fpt)")
    .option("--model <model>", "Model ID")
    .option("--api-key <key>", "API key (or set SAST_API_KEY / OPENAI_API_KEY / ...)")
    .option("--base-url <url>", "Override provider base URL")
    .option("--allow-bash", "Enable bash tool for agent")
    .option("--max-steps <n>", "Max agent loop steps per finding")
    .option("--effort <level>", "Reasoning effort: low, medium, high")
    .option("--concurrency <n>", "Max concurrent agent loops for batch audit")
    .option("--workers <n>", "Number of Bun Workers (1..16 or 'auto')")
    .option("--worker-restart", "Respawn a crashed worker once and redrive its in-flight tasks")
    .option("--output <path>", "Consolidated findings-out.json path")
    .option("--no-log", "Disable debug logging (enabled by default)")
    .option("--langsmith", "Enable LangSmith tracing (or set LANGSMITH_TRACING=true)")
    .action(async (findingsPath: string | undefined, opts: any) => {
      let logBaseDir: string | undefined;
      if (opts.log !== false && process.env.SAST_LOG !== "0") {
        logBaseDir = resolve(process.cwd(), ".sast-triage");
        const logPath = resolve(logBaseDir, "debug.log");
        initLogger(logPath);
        log.info("cli", "Debug logging enabled", { logPath });
      }

      let tracingEnabled = false;
      if (opts.langsmith || hasLangSmithConfig()) {
        tracingEnabled = await initTracing();
        if (!tracingEnabled && opts.langsmith) {
          console.error("LangSmith tracing requested but LANGSMITH_API_KEY is not set.");
          console.error("Set: LANGSMITH_API_KEY, LANGSMITH_TRACING=true, LANGSMITH_PROJECT");
          process.exit(1);
        }
      }

      // Load TOML BEFORE resolveConfig so the precedence chain can see it.
      // CRITICAL: only pass projectConfig if a real .sast-triage.toml exists.
      // ProjectConfig initializes with class defaults (provider="openai", model="gpt-4o")
      // even when no file is present — passing it unconditionally would let those defaults
      // satisfy the required-field check.
      const projectConfig = new ProjectConfig(process.cwd());
      const tomlConfig = projectConfig.hasConfig() ? projectConfig : undefined;

      const concurrency = parseConcurrency(opts.concurrency);
      let workers: number | "auto" | undefined;
      try {
        workers = parseWorkers(opts.workers);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      const maxSteps = opts.maxSteps !== undefined ? parseInt(opts.maxSteps, 10) : undefined;
      const inputPath = opts.input ?? findingsPath;

      const resolved = resolveConfig({
        findingsPath: inputPath,
        provider: opts.provider,
        model: opts.model,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        allowBash: opts.allowBash,
        maxSteps,
        concurrency,
        workers,
        workerRestart: opts.workerRestart === true ? true : undefined,
        outputPath: opts.output,
        reasoningEffort: opts.effort,
      }, tomlConfig);

      // validateConfig exits on missing required fields; returns AppConfig.
      const config = validateConfig(resolved);

      const orchestrator = new TriageOrchestrator();
      await orchestrator.run(config, { tracingEnabled, logBaseDir });
    });

  program.parse();
}
