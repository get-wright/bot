import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Finding } from "./models/finding.js";
import type { TriageVerdict } from "./models/verdict.js";
import type { AgentEvent } from "./models/events.js";
import type { MemoryStore, CachedRecord } from "./memory/store.js";
import type { FindingEntry, FindingStatus } from "./ui/components/findings-table.js";
import { parseSemgrepOutput, fingerprintFinding } from "./parser/semgrep.js";
import { prefilterFinding } from "./parser/prefilter.js";

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
