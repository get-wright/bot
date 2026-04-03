#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { resolveConfig } from "./config.js";
import { parseSemgrepOutput, fingerprintFinding } from "./parser/semgrep.js";
import { prefilterFinding } from "./parser/prefilter.js";
import { MemoryStore } from "./memory/store.js";
import { runAgentLoop } from "./agent/loop.js";
import type { AgentEvent } from "./models/events.js";
import type { Finding } from "./models/finding.js";

const program = new Command();

program
  .name("sast-triage")
  .description("Agentic SAST finding triage via LLM-driven codebase exploration")
  .version("0.1.0")
  .argument("[findings]", "Path to Semgrep JSON output file")
  .requiredOption("--provider <provider>", "LLM provider (openai, anthropic, google, openrouter)")
  .requiredOption("--model <model>", "Model ID")
  .option("--headless", "Output NDJSON to stdout instead of TUI", false)
  .option("--allow-bash", "Enable bash tool for agent", false)
  .option("--max-steps <n>", "Max agent loop steps per finding", "15")
  .option("--memory-db <path>", "SQLite memory DB path", ".sast-triage/memory.db")
  .action(async (findingsPath: string | undefined, opts) => {
    const config = resolveConfig({
      findingsPath: findingsPath ?? "-",
      provider: opts.provider,
      model: opts.model,
      headless: opts.headless,
      allowBash: opts.allowBash,
      maxSteps: parseInt(opts.maxSteps, 10),
      memoryDb: opts.memoryDb,
    });

    let rawInput: string;
    if (config.findingsPath === "-") {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      rawInput = Buffer.concat(chunks).toString("utf-8");
    } else {
      rawInput = readFileSync(resolve(config.findingsPath), "utf-8");
    }

    const raw = JSON.parse(rawInput);
    const findings = parseSemgrepOutput(raw);

    if (findings.length === 0) {
      console.error("No findings parsed from input.");
      process.exit(1);
    }

    const memory = new MemoryStore(resolve(config.memoryDb));
    const memoryLookup = memory.createLookup();

    const active: Finding[] = [];
    for (const f of findings) {
      const result = prefilterFinding(f, memoryLookup);
      if (result.passed) {
        active.push(f);
      } else if (config.headless) {
        const fp = fingerprintFinding(f);
        console.log(JSON.stringify({ type: "filtered", fingerprint: fp, rule: f.check_id, reason: result.reason }));
      }
    }

    if (config.headless) {
      await runHeadless(active, config, memory);
    } else {
      const { runTui } = await import("./ui/app.js");
      await runTui(active, findings.length, config, memory);
    }

    memory.close();
  });

async function runHeadless(
  findings: Finding[],
  config: ReturnType<typeof resolveConfig>,
  memory: MemoryStore,
): Promise<void> {
  for (const finding of findings) {
    const fp = fingerprintFinding(finding);
    const memoryHints = memory.getHints(finding.check_id, fp);

    const onEvent = (event: AgentEvent) => {
      console.log(JSON.stringify({ ...event, fingerprint: fp }));
    };

    const verdict = await runAgentLoop({
      finding,
      projectRoot: process.cwd(),
      provider: config.provider,
      model: config.model,
      maxSteps: config.maxSteps,
      allowBash: config.allowBash,
      onEvent,
      memoryHints,
    });

    memory.store({
      fingerprint: fp,
      check_id: finding.check_id,
      path: finding.path,
      verdict: verdict.verdict,
      reasoning: verdict.reasoning,
    });
  }
}

program.parse();
