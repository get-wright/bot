#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { resolveConfig } from "./config.js";
import type { AppConfig } from "./config.js";
import { parseSemgrepOutput, fingerprintFinding } from "./parser/semgrep.js";
import { prefilterFinding } from "./parser/prefilter.js";
import { MemoryStore } from "./memory/store.js";
import { ProjectConfig } from "./config/project-config.js";
import { runAgentLoop } from "./agent/loop.js";
import type { AgentEvent } from "./models/events.js";
import type { Finding } from "./models/finding.js";
import { initLogger, log } from "./logger.js";

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
  .option("--max-steps <n>", "Max agent loop steps per finding", "15")
  .option("--memory-db <path>", "SQLite memory DB path", ".sast-triage/memory.db")
  .option("--effort <level>", "Reasoning effort: low, medium, high")
  .option("--no-log", "Disable debug logging (enabled by default)")
  .action(async (findingsPath: string | undefined, opts) => {
    if (opts.log !== false) {
      const logPath = resolve(process.cwd(), ".sast-triage", "debug.log");
      initLogger(logPath);
      log.info("cli", "Debug logging enabled", { logPath });
    }
    const config = resolveConfig({
      findingsPath,
      provider: opts.provider,
      model: opts.model,
      headless: opts.headless,
      allowBash: opts.allowBash,
      maxSteps: parseInt(opts.maxSteps, 10),
      memoryDb: opts.memoryDb,
    });

    if (opts.effort) {
      (config as Record<string, unknown>).reasoningEffort = opts.effort;
    }

    // Headless mode requires all args
    if (config.headless) {
      if (!config.provider || !config.model) {
        console.error("Headless mode requires --provider and --model");
        process.exit(1);
      }
      if (!config.findingsPath) {
        console.error("Headless mode requires a findings file argument");
        process.exit(1);
      }
      const projectConfig = new ProjectConfig(process.cwd());
      const fullConfig = config as AppConfig;
      fullConfig.apiKey = projectConfig.resolvedApiKey();
      fullConfig.baseUrl = projectConfig.baseUrl;
      await runHeadless(fullConfig, projectConfig);
      return;
    }

    // TUI mode — setup screen handles missing config
    const projectConfig = new ProjectConfig(process.cwd());
    const memory = new MemoryStore(resolve(projectConfig.memoryDbPath));

    // If all args provided, pre-load findings
    if (config.provider && config.model && config.findingsPath) {
      const raw = JSON.parse(readInput(config.findingsPath));
      const allFindings = parseSemgrepOutput(raw);
      const active = allFindings.filter((f) => prefilterFinding(f).passed);

      if (active.length === 0) {
        console.error("No actionable findings after prefilter.");
        memory.close();
        process.exit(1);
      }
    }

    const { runTui } = await import("./ui/app.js");
    await runTui(config, memory, projectConfig);
    memory.close();
  });

async function runHeadless(config: AppConfig, projectConfig: ProjectConfig): Promise<void> {
  const rawInput = readInput(config.findingsPath);
  const raw = JSON.parse(rawInput);
  const findings = parseSemgrepOutput(raw);
  log.info("parser", `Parsed ${findings.length} findings from ${config.findingsPath}`);

  if (findings.length === 0) {
    console.error("No findings parsed from input.");
    process.exit(1);
  }

  const memory = new MemoryStore(resolve(config.memoryDb));

  const active: Finding[] = [];
  for (const f of findings) {
    const result = prefilterFinding(f);
    if (result.passed) {
      active.push(f);
    } else {
      const fp = fingerprintFinding(f);
      log.debug("prefilter", `Filtered ${f.check_id}: ${result.reason}`);
      console.log(JSON.stringify({ type: "filtered", fingerprint: fp, rule: f.check_id, reason: result.reason }));
    }
  }
  log.info("prefilter", `${active.length} active, ${findings.length - active.length} filtered`);

  for (const finding of active) {
    const fp = fingerprintFinding(finding);
    const memoryHints = memory.getHints(finding.check_id, fp);

    const onEvent = (event: AgentEvent) => {
      console.log(JSON.stringify({ ...event, fingerprint: fp }));
    };

    const result = await runAgentLoop({
      finding,
      projectRoot: process.cwd(),
      provider: config.provider,
      model: config.model,
      maxSteps: config.maxSteps,
      allowBash: config.allowBash,
      onEvent,
      memoryHints,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      reasoningEffort: config.reasoningEffort,
      allowedPaths: projectConfig.allowedPaths,
    });

    memory.store({
      fingerprint: fp,
      check_id: finding.check_id,
      path: finding.path,
      verdict: result.verdict.verdict,
      reasoning: result.verdict.reasoning,
      key_evidence: result.verdict.key_evidence,
      suggested_fix: result.verdict.suggested_fix,
      tool_calls: result.toolCalls,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
    });
  }

  memory.close();
}

function readInput(path: string): string {
  if (path === "-") {
    return readFileSync(0, "utf-8");
  }
  return readFileSync(resolve(path), "utf-8");
}

program.parse();
