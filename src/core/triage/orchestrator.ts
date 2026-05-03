import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Finding } from "../models/finding.js";
import type { TriageVerdict } from "../models/verdict.js";
import type { AgentEvent } from "../models/events.js";
import type { AppConfig } from "../../cli/config.js";
import type { AgentLoopResult } from "../agent/loop.js";
import type { FollowUpExchange } from "../agent/follow-up.js";
import { maybeCreateGraphClient, type GraphClient } from "../../infra/graph/index.js";
import { prefetchGraphContext } from "../../infra/graph/prefetch.js";
import { parseSemgrepOutput, fingerprintFinding } from "../parser/semgrep.js";
import { prefilterFinding } from "../parser/prefilter.js";
import { runAgentLoop } from "../agent/loop.js";
import { runFollowUp } from "../agent/follow-up.js";
import { OutputWriter, type OutputRow } from "../../infra/output/writer.js";
import { formatEvent } from "../../infra/output/reporter.js";

export type FindingStatus = "pending" | "in_progress" | "true_positive" | "false_positive" | "needs_review";

export interface FindingEntry {
  fingerprint: string;
  ruleId: string;
  fileLine: string;
  severity: string;
  status: FindingStatus;
}

export interface FindingState {
  entry: FindingEntry;
  finding: Finding;
  events: AgentEvent[];
}

export interface FilteredFinding {
  finding: Finding;
  reason: string;
}

export interface LoadResult {
  active: FindingState[];
  filtered: FilteredFinding[];
  total: number;
}

type RunnerErrorResult = {
  verdict: { verdict: "error"; reasoning: string; key_evidence: string[] };
  toolCalls: [];
  inputTokens: 0;
  outputTokens: 0;
};

export type TriageResult = AgentLoopResult | RunnerErrorResult;

export interface TriageOpts {
  finding: Finding;
  fingerprint: string;
  config: AppConfig;
  onEvent: (event: AgentEvent) => void;
  graphClient?: GraphClient | null;
  graphContext?: string | null;
}

export interface TriageBatchOpts {
  items: { finding: Finding; fingerprint: string }[];
  config: AppConfig;
  concurrency: number;
  onResult: (fingerprint: string, result: TriageResult) => void;
  abortSignal?: AbortSignal;
  onEvent?: (fingerprint: string, event: AgentEvent) => void;
  graphClient?: GraphClient | null;
  graphContexts?: Map<string, string>;
}

export class TriageOrchestrator {
  loadFindings(path: string): LoadResult {
    const filePath = resolve(path);
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    const allFindings = parseSemgrepOutput(raw);

    const active: FindingState[] = [];
    const filtered: FilteredFinding[] = [];

    for (const f of allFindings) {
      const result = prefilterFinding(f);
      if (!result.passed) {
        filtered.push({ finding: f, reason: result.reason ?? "Unknown" });
        continue;
      }

      const fp = fingerprintFinding(f);
      active.push({
        entry: {
          fingerprint: fp,
          ruleId: f.check_id,
          fileLine: `${f.path}:${f.start.line}`,
          severity: f.extra.severity,
          status: "pending",
        },
        finding: f,
        events: [],
      });
    }

    return { active, filtered, total: allFindings.length };
  }

  async triage(opts: TriageOpts): Promise<AgentLoopResult> {
    const { finding, config, onEvent, graphClient, graphContext } = opts;

    return runAgentLoop({
      finding,
      projectRoot: process.cwd(),
      provider: config.provider,
      model: config.model,
      maxSteps: config.maxSteps,
      allowBash: config.allowBash,
      onEvent,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      reasoningEffort: config.reasoningEffort,
      graphClient,
      graphContext,
    });
  }

  async run(config: AppConfig): Promise<void> {
    const { active, filtered, total } = this.loadFindings(config.findingsPath);

    if (total === 0) {
      console.error("No findings parsed from input.");
      process.exit(1);
    }

    const writer = new OutputWriter(
      config.outputPath,
      { provider: config.provider, model: config.model, effort: config.reasoningEffort },
      config.findingsPath,
    );

    for (const f of filtered) {
      const fp = fingerprintFinding(f.finding);
      console.log(JSON.stringify({ type: "filtered", fingerprint: fp, rule: f.finding.check_id, reason: f.reason }));
    }

    const fresh: { finding: Finding; fingerprint: string }[] = active.map((s) => ({
      finding: s.finding,
      fingerprint: s.entry.fingerprint,
    }));

    const graphClient: GraphClient | null = await maybeCreateGraphClient(process.cwd());
    if (graphClient) {
      console.error("[graph] code-review-graph integration active");
    }

    // Optional: prefetch structural context per finding from the graph and
    // inject it into the system prompt to seed the agent's investigation.
    let graphContexts: Map<string, string> | undefined;
    if (graphClient && process.env.SAST_GRAPH_PREFETCH === "1") {
      graphContexts = new Map();
      const root = process.cwd();
      await Promise.all(
        fresh.map(async (item) => {
          try {
            const ctx = await prefetchGraphContext(item.finding, graphClient, root);
            if (ctx) graphContexts!.set(item.fingerprint, ctx);
          } catch {
            // Best-effort — never fail triage because prefetch failed.
          }
        }),
      );
      console.error(`[graph] prefetched context for ${graphContexts.size}/${fresh.length} findings`);
    }

    try {
      await this.triageBatch({
        items: fresh,
        config,
        concurrency: config.concurrency ?? 1,
        onResult: (fingerprint, result) => {
          const item = fresh.find((x) => x.fingerprint === fingerprint);
          if (!item) return;
          writer.append(toOutputRow(item.finding, item.fingerprint, result, new Date().toISOString()));
        },
        onEvent: (fingerprint, event) => {
          console.log(formatEvent(event, fingerprint));
        },
        graphClient,
        graphContexts,
      });
    } finally {
      if (graphClient) {
        await graphClient.close().catch(() => {});
      }
    }

    writer.flush();
  }

  async triageBatch(opts: TriageBatchOpts): Promise<void> {
    const { items, config, concurrency, onResult, abortSignal, onEvent, graphClient, graphContexts } = opts;
    // Stagger delay between launching concurrent requests to avoid
    // thundering herd on provider APIs (empty 200 responses, rate limits).
    const STAGGER_MS = 500;
    let nextIdx = 0;
    let running = 0;
    let dispatching = false;

    return new Promise<void>((resolve) => {
      const dispatch = () => {
        // Prevent re-entrant dispatch from scheduling duplicate stagger chains
        if (dispatching) return;
        dispatching = true;

        const launchNext = () => {
          if (running >= concurrency || nextIdx >= items.length || abortSignal?.aborted) {
            dispatching = false;
            if (running === 0 && (nextIdx >= items.length || abortSignal?.aborted)) resolve();
            return;
          }

          const idx = nextIdx++;
          const item = items[idx]!;
          running++;

          this.triage({
            finding: item.finding,
            fingerprint: item.fingerprint,
            config,
            onEvent: (event) => onEvent?.(item.fingerprint, event),
            graphClient,
            graphContext: graphContexts?.get(item.fingerprint) ?? null,
          })
            .then((result) => {
              onResult(item.fingerprint, result);
            })
            .catch((err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              onResult(item.fingerprint, {
                verdict: { verdict: "error", reasoning: message, key_evidence: [] },
                toolCalls: [],
                inputTokens: 0,
                outputTokens: 0,
              });
            })
            .finally(() => {
              running--;
              dispatch();
            });

          // Stagger the next launch to avoid hitting provider rate limits
          if (running < concurrency && nextIdx < items.length && !abortSignal?.aborted) {
            setTimeout(launchNext, STAGGER_MS);
          } else {
            dispatching = false;
          }
        };

        launchNext();
      };

      dispatch();
    });
  }

  async followUp(
    finding: Finding,
    previousVerdict: TriageVerdict,
    question: string,
    priorExchanges: FollowUpExchange[],
    config: AppConfig,
    onEvent: (event: AgentEvent) => void,
  ): Promise<string> {
    return runFollowUp({
      finding,
      previousVerdict,
      question,
      priorExchanges,
      provider: config.provider,
      model: config.model,
      onEvent,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      reasoningEffort: config.reasoningEffort,
    });
  }
}

function toOutputRow(
  finding: Finding,
  fingerprint: string,
  result: TriageResult,
  auditedAt: string,
): OutputRow {
  return {
    ref: {
      fingerprint,
      check_id: finding.check_id,
      path: finding.path,
      line: finding.start.line,
    },
    verdict: result.verdict,
    tool_calls: result.toolCalls.map((t) => ({ tool: t.tool, args: t.args })),
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    audited_at: auditedAt,
  };
}
