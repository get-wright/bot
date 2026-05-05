import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Finding } from "../models/finding.js";
import type { TriageVerdict } from "../models/verdict.js";
import type { AgentEvent } from "../models/events.js";
import type { AppConfig } from "../../cli/config.js";
import type { AgentLoopResult } from "../agent/loop.js";
import type { FollowUpExchange } from "../agent/follow-up.js";
import { maybeCreateGraphClient, type GraphClient, type NodeInfo } from "../../infra/graph/index.js";
import { prefetchGraphContextFromSummary } from "../../infra/graph/prefetch.js";
import { resolveEnclosingFunctionRangeFromSummary } from "../../infra/graph/function-range.js";
import { parseSemgrepOutput, fingerprintFinding } from "../parser/semgrep.js";
import { prefilterFinding } from "../parser/prefilter.js";
import { runAgentLoop } from "../agent/loop.js";
import { runFollowUp } from "../agent/follow-up.js";
import { createReadTool, type PreferredReadRange, type ReadRegistry, type ReadRegistrySeed } from "../agent/tools/read.js";
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

const FOCUSED_READ_PADDING_LINES = 20;
const FOCUSED_READ_MIN_FILE_LINES = 300;

export interface TriageOpts {
  finding: Finding;
  fingerprint: string;
  config: AppConfig;
  onEvent: (event: AgentEvent) => void;
  graphClient?: GraphClient | null;
  graphContext?: string | null;
  initialCodeContext?: string | null;
  initialReadRegistrySeeds?: ReadRegistrySeed[];
  focusedReadHint?: string | null;
  preferredReadRange?: PreferredReadRange | null;
}

interface FocusedReadPlan {
  hint: string;
  range: PreferredReadRange;
  context?: string | null;
  seeds?: ReadRegistrySeed[];
}

export interface TriageBatchOpts {
  items: {
    finding: Finding;
    fingerprint: string;
    initialCodeContext?: string | null;
    initialReadRegistrySeeds?: ReadRegistrySeed[];
    focusedReadHint?: string | null;
    preferredReadRange?: PreferredReadRange | null;
  }[];
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
      initialCodeContext: opts.initialCodeContext ?? null,
      initialReadRegistrySeeds: opts.initialReadRegistrySeeds,
      focusedReadHint: opts.focusedReadHint ?? null,
      preferredReadRange: opts.preferredReadRange ?? null,
    });
  }

  async run(
    config: AppConfig,
    opts: { tracingEnabled?: boolean; logBaseDir?: string } = {},
  ): Promise<void> {
    const { active, filtered, total } = this.loadFindings(config.findingsPath);

    if (total === 0) {
      console.error("No findings parsed from input.");
      process.exit(1);
    }

    const writer = new OutputWriter(
      config.outputPath,
      { provider: config.provider, model: config.model, effort: config.reasoningEffort },
      resolve(config.findingsPath),
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
    let focusedReadPlans: Map<string, FocusedReadPlan> | undefined;
    if (graphClient && process.env.SAST_GRAPH_PREFETCH === "1") {
      graphContexts = new Map();
      focusedReadPlans = new Map();
      const root = process.cwd();
      await Promise.all(
        fresh.map(async (item) => {
          try {
            const summary = await graphClient.queryGraph({
              pattern: "file_summary",
              target: item.finding.path,
            });
            const ctx = await prefetchGraphContextFromSummary(item.finding, graphClient, root, summary);
            const focused = await resolveFocusedReadPlan(item.finding, summary, root);
            if (ctx) graphContexts!.set(item.fingerprint, ctx);
            if (focused) focusedReadPlans!.set(item.fingerprint, focused);
          } catch {
            // Best-effort — never fail triage because prefetch/focused read failed.
          }
        }),
      );
      console.error(`[graph] prefetched context for ${graphContexts.size}/${fresh.length} findings`);
      console.error(`[graph] focused read hints for ${focusedReadPlans.size}/${fresh.length} findings`);
    }

    if (config.workers > 1) {
      const { WorkerPool } = await import("../worker/pool.js");
      const { GraphBridge } = await import("../worker/graph-bridge.js");
      const bridge = new GraphBridge(graphClient);
      const workerSpec = resolveWorkerEntrySpec();
      const pool = new WorkerPool({
        size: config.workers,
        factory: () => new Worker(workerSpec as any) as any,
        serializedConfig: {
          provider: config.provider,
          model: config.model,
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          maxSteps: config.maxSteps,
          allowBash: config.allowBash,
          reasoningEffort: config.reasoningEffort,
          concurrency: config.concurrency,
        },
        tracingEnabled: opts.tracingEnabled === true,
        langsmithProject: process.env.LANGSMITH_PROJECT,
        graphBridge: bridge,
        workerRestart: config.workerRestart,
        logBaseDir: opts.logBaseDir,
        onEvent: (fp, event) => console.log(formatEvent(event, fp)),
        onResult: (fp, result) => {
          const item = fresh.find((x) => x.fingerprint === fp);
          if (!item) return;
          writer.append(toOutputRow(item.finding, item.fingerprint, result, new Date().toISOString()));
        },
      });
      pool.enqueue(fresh.map((x) => {
        const focused = focusedReadPlans?.get(x.fingerprint);
        return {
          finding: x.finding,
          fingerprint: x.fingerprint,
          graphContext: graphContexts?.get(x.fingerprint),
          initialCodeContext: focused?.context ?? null,
          initialReadRegistrySeeds: focused?.seeds,
          focusedReadHint: focused?.hint ?? null,
          preferredReadRange: focused?.range ?? null,
        };
      }));
      try {
        await pool.run();
      } finally {
        if (graphClient) await graphClient.close().catch(() => {});
      }
      writer.flush();
      return;
    }

    try {
      await this.triageBatch({
        items: fresh.map((x) => {
          const focused = focusedReadPlans?.get(x.fingerprint);
          return {
            ...x,
            initialCodeContext: focused?.context ?? null,
            initialReadRegistrySeeds: focused?.seeds,
            focusedReadHint: focused?.hint ?? null,
            preferredReadRange: focused?.range ?? null,
          };
        }),
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
            initialCodeContext: item.initialCodeContext ?? null,
            initialReadRegistrySeeds: item.initialReadRegistrySeeds,
            focusedReadHint: item.focusedReadHint ?? null,
            preferredReadRange: item.preferredReadRange ?? null,
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

/**
 * Resolve the spec for spawning the worker entry. Branches on dev vs.
 * Bun-compiled binary because of an unfixed Bun bug
 * (oven-sh/bun#15981, #29124; PR #29150 not yet released as of Bun 1.3.11):
 * in `--compile` mode, `new URL("../worker/entry.ts", import.meta.url)`
 * resolves to `file:///$bunfs/...` without the `root/` prefix or `.ts → .js`
 * rewrite that the embedded module graph expects, so Bun's
 * `resolveEntryPointSpecifier` rejects it with `BuildMessage: ModuleNotFound`.
 *
 * Workaround: in compiled mode, pass a string path that is relative to the
 * auto-detected bundle root (`src/`, the common ancestor of `src/index.ts`
 * and `src/core/worker/entry.ts`); in dev mode, the URL form works.
 *
 * Detector: `import.meta.url` starts with `file:///$bunfs/` (POSIX) or
 * `file:///B:/~BUN/` (Windows) only inside the `--compile` runtime.
 */
function resolveWorkerEntrySpec(): URL | string {
  const url = import.meta.url;
  const isCompiled =
    url.startsWith("file:///$bunfs/") || url.startsWith("file:///B:/~BUN");
  return isCompiled
    ? "./core/worker/entry.ts"
    : new URL("../worker/entry.ts", import.meta.url);
}

export async function resolveFocusedReadPlan(
  finding: Finding,
  summary: NodeInfo[],
  projectRoot: string,
): Promise<FocusedReadPlan | null> {
  const range = resolveEnclosingFunctionRangeFromSummary(finding, summary, FOCUSED_READ_PADDING_LINES);
  if (!range) return null;

  const totalLines = countFileLines(resolve(projectRoot, finding.path));
  if (totalLines < FOCUSED_READ_MIN_FILE_LINES) return null;

  const preferredReadRange = { path: range.path, offset: range.readOffset, limit: range.readLimit };
  const hint = JSON.stringify(preferredReadRange);

  // Full focused-code injection is useful for experiments but is not the
  // default: user-message context is replayed across model steps and caused
  // input-token regressions in E2E runs. Default to the cheap exact read hint.
  if (process.env.SAST_FOCUSED_READ_CONTEXT !== "1") {
    return { hint, range: preferredReadRange };
  }

  const registry: ReadRegistry = new Map();
  const readTool = createReadTool({ projectRoot, registry, forceRegister: true });
  const context = await readTool.execute({
    path: range.path,
    offset: range.readOffset,
    limit: range.readLimit,
  }).catch(() => null);

  if (!context) return { hint, range: preferredReadRange };

  return {
    hint,
    range: preferredReadRange,
    context,
    seeds: [...registry.entries()].map(([absPath, entry]) => ({ absPath, entry })),
  };
}

function countFileLines(absPath: string): number {
  const text = readFileSync(absPath, "utf-8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
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
