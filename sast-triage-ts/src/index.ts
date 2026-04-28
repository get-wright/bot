#!/usr/bin/env node

import { resolve } from "node:path";
import { Command } from "commander";
import { resolveConfig } from "./config.js";
import type { AppConfig } from "./config.js";
import { MemoryStore } from "./memory/store.js";
import { ProjectConfig } from "./config/project-config.js";
import { TriageOrchestrator } from "./orchestrator.js";
import { initLogger, log } from "./logger.js";
import { initTracing, hasLangSmithConfig } from "./tracing.js";

const program = new Command();

program
  .name("sast-triage")
  .description("Agentic SAST finding triage via LLM-driven codebase exploration")
  .version("0.1.0")
  .argument("[findings]", "Path to Semgrep JSON output file")
  .option("--provider <provider>", "LLM provider (openai, anthropic, google, openrouter, fpt)")
  .option("--model <model>", "Model ID")
  .option("--headless", "Output NDJSON to stdout instead of TUI", false)
  .option("--allow-bash", "Enable bash tool for agent", false)
  .option("--max-steps <n>", "Max agent loop steps per finding", "25")
  .option("--memory-db <path>", "SQLite memory DB path", ".sast-triage/memory.db")
  .option("--effort <level>", "Reasoning effort: low, medium, high")
  .option("--concurrency <n>", "Max concurrent agent loops for batch audit", "1")
  .option("--no-log", "Disable debug logging (enabled by default)")
  .option("--langsmith", "Enable LangSmith tracing (or set LANGSMITH_TRACING=true)", false)
  .action(async (findingsPath: string | undefined, opts) => {
    if (opts.log !== false) {
      const logPath = resolve(process.cwd(), ".sast-triage", "debug.log");
      initLogger(logPath);
      log.info("cli", "Debug logging enabled", { logPath });
    }

    // Initialize LangSmith tracing if requested via flag or env vars
    if (opts.langsmith || hasLangSmithConfig()) {
      const ok = await initTracing();
      if (!ok && opts.langsmith) {
        console.error("LangSmith tracing requested but LANGSMITH_API_KEY is not set.");
        console.error("Set: LANGSMITH_API_KEY, LANGSMITH_TRACING=true, LANGSMITH_PROJECT");
        process.exit(1);
      }
    }

    const concurrency = parseInt(opts.concurrency, 10);
    const config = resolveConfig({
      findingsPath,
      provider: opts.provider,
      model: opts.model,
      headless: opts.headless,
      allowBash: opts.allowBash,
      maxSteps: parseInt(opts.maxSteps, 10),
      memoryDb: opts.memoryDb,
      concurrency: concurrency >= 1 && concurrency <= 10 ? concurrency : undefined,
    });

    if (opts.effort) {
      (config as Record<string, unknown>).reasoningEffort = opts.effort;
    }

    const projectConfig = new ProjectConfig(process.cwd());
    const memory = new MemoryStore(resolve(projectConfig.memoryDbPath));
    const orchestrator = new TriageOrchestrator(memory);

    if (config.headless) {
      if (!config.provider || !config.model) {
        console.error("Headless mode requires --provider and --model");
        process.exit(1);
      }
      if (!config.findingsPath) {
        console.error("Headless mode requires a findings file argument");
        process.exit(1);
      }
      const fullConfig = config as AppConfig;
      fullConfig.apiKey = projectConfig.resolvedApiKey();
      fullConfig.baseUrl = projectConfig.baseUrl;
      await orchestrator.run(fullConfig);
      memory.close();
      return;
    }

    // TODO(Task 14): Remove this entirely. Currently commented out so tsc passes
    // after src/ui deletion in Task 7.
    // const { runTui } = await import("./ui/app.js");
    // await runTui(orchestrator, config, projectConfig);
    console.error("TUI mode is no longer supported. Use --headless.");
    memory.close();
    process.exit(1);
  });

program.parse();
