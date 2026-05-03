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

export function run(): void {
  const program = new Command();

  program
    .name("sast-triage")
    .description("Agentic SAST finding triage via LLM-driven codebase exploration (headless)")
    .version("0.1.7")
    .argument("[findings]", "Path to Semgrep JSON output file (or set SAST_FINDINGS)")
    .option("--provider <provider>", "LLM provider (openai, anthropic, google, openrouter, fpt)")
    .option("--model <model>", "Model ID")
    .option("--api-key <key>", "API key (or set SAST_API_KEY / OPENAI_API_KEY / ...)")
    .option("--base-url <url>", "Override provider base URL")
    .option("--allow-bash", "Enable bash tool for agent")
    .option("--max-steps <n>", "Max agent loop steps per finding")
    .option("--effort <level>", "Reasoning effort: low, medium, high")
    .option("--concurrency <n>", "Max concurrent agent loops for batch audit")
    .option("--output <path>", "Consolidated findings-out.json path")
    .option("--no-log", "Disable debug logging (enabled by default)")
    .option("--langsmith", "Enable LangSmith tracing (or set LANGSMITH_TRACING=true)")
    .action(async (findingsPath: string | undefined, opts: any) => {
      if (opts.log !== false && process.env.SAST_LOG !== "0") {
        const logPath = resolve(process.cwd(), ".sast-triage", "debug.log");
        initLogger(logPath);
        log.info("cli", "Debug logging enabled", { logPath });
      }

      if (opts.langsmith || hasLangSmithConfig()) {
        const ok = await initTracing();
        if (!ok && opts.langsmith) {
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
      const maxSteps = opts.maxSteps !== undefined ? parseInt(opts.maxSteps, 10) : undefined;

      const resolved = resolveConfig({
        findingsPath,
        provider: opts.provider,
        model: opts.model,
        apiKey: opts.apiKey,
        baseUrl: opts.baseUrl,
        allowBash: opts.allowBash,
        maxSteps,
        concurrency,
        outputPath: opts.output,
        reasoningEffort: opts.effort,
      }, tomlConfig);

      // validateConfig exits on missing required fields; returns AppConfig.
      const config = validateConfig(resolved);

      const orchestrator = new TriageOrchestrator();
      await orchestrator.run(config);
    });

  program.parse();
}
