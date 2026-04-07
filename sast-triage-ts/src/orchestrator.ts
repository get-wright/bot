import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Finding } from "./models/finding.js";
import type { TriageVerdict } from "./models/verdict.js";
import type { AgentEvent } from "./models/events.js";
import type { MemoryStore, CachedRecord } from "./memory/store.js";
import type { FindingEntry, FindingStatus } from "./ui/components/findings-table.js";
import type { AppConfig } from "./config.js";
import type { AgentLoopResult } from "./agent/loop.js";
import type { FollowUpExchange } from "./agent/follow-up.js";
import { parseSemgrepOutput, fingerprintFinding } from "./parser/semgrep.js";
import { prefilterFinding } from "./parser/prefilter.js";
import { runAgentLoop } from "./agent/loop.js";
import { runFollowUp } from "./agent/follow-up.js";

export interface FindingState {
  entry: FindingEntry;
  finding: Finding;
  events: AgentEvent[];
  verdict?: TriageVerdict;
  cachedAt?: string;
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

export class TriageOrchestrator {
  private memory: MemoryStore;

  constructor(memory: MemoryStore) {
    this.memory = memory;
  }

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
      const cached = this.memory.lookupCached(fp);
      const events = synthesizeCachedEvents(cached);

      active.push({
        entry: {
          fingerprint: fp,
          ruleId: f.check_id,
          fileLine: `${f.path}:${f.start.line}`,
          severity: f.extra.severity,
          status: (cached?.verdict.verdict ?? "pending") as FindingStatus,
        },
        finding: f,
        events,
        verdict: cached?.verdict,
        cachedAt: cached?.updated_at,
      });
    }

    return { active, filtered, total: allFindings.length };
  }

  async triage(
    finding: Finding,
    fingerprint: string,
    config: AppConfig,
    onEvent: (event: AgentEvent) => void,
  ): Promise<AgentLoopResult> {
    const memoryHints = this.memory.getHints(finding.check_id, fingerprint);

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
      allowedPaths: config.allowedPaths,
    });

    this.memory.store({
      fingerprint,
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

    return result;
  }

  async runHeadless(config: AppConfig): Promise<void> {
    const { active, filtered, total } = this.loadFindings(config.findingsPath);

    if (total === 0) {
      console.error("No findings parsed from input.");
      process.exit(1);
    }

    for (const f of filtered) {
      const fp = fingerprintFinding(f.finding);
      console.log(JSON.stringify({ type: "filtered", fingerprint: fp, rule: f.finding.check_id, reason: f.reason }));
    }

    if (active.length === 0) {
      console.error("No actionable findings after prefilter.");
      process.exit(1);
    }

    const items = active.map((s) => ({
      finding: s.finding,
      fingerprint: s.entry.fingerprint,
    }));

    await this.triageBatch(
      items,
      config,
      config.concurrency ?? 1,
      (fingerprint, result) => {
        console.log(JSON.stringify({ type: "verdict", fingerprint, verdict: result.verdict }));
      },
      undefined,
      (fingerprint, event) => {
        console.log(JSON.stringify({ ...event, fingerprint }));
      },
    );
  }

  async triageBatch(
    items: { finding: Finding; fingerprint: string }[],
    config: AppConfig,
    concurrency: number,
    onResult: (fingerprint: string, result: AgentLoopResult) => void,
    abortSignal?: AbortSignal,
    onEvent?: (fingerprint: string, event: AgentEvent) => void,
  ): Promise<void> {
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

          this.triage(item.finding, item.fingerprint, config, (event) => {
            onEvent?.(item.fingerprint, event);
          })
            .then((result) => {
              onResult(item.fingerprint, result);
            })
            .catch(() => {
              // Error already emitted via onEvent
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

function synthesizeCachedEvents(cached: CachedRecord | null): AgentEvent[] {
  if (!cached) return [];
  const events: AgentEvent[] = [];
  for (const tc of cached.tool_calls) {
    events.push({ type: "tool_start", tool: tc.tool, args: tc.args });
  }
  events.push({ type: "verdict", verdict: cached.verdict });
  if (cached.input_tokens > 0 || cached.output_tokens > 0) {
    events.push({
      type: "usage",
      inputTokens: cached.input_tokens,
      outputTokens: cached.output_tokens,
      totalTokens: cached.input_tokens + cached.output_tokens,
    });
  }
  return events;
}
