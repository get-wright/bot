#!/usr/bin/env bun
import { readFileSync } from "node:fs";

interface Row {
  fingerprint?: string;
  finding?: { fingerprint?: string };
  input_tokens?: number;
  output_tokens?: number;
  tool_calls?: unknown[];
  cached?: boolean;
}

function loadRows(path: string): Row[] {
  const txt = readFileSync(path, "utf8");
  const trimmed = txt.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed.split("\n").filter(Boolean).map(l => JSON.parse(l));
}

function summarize(rows: Row[]) {
  const fresh = rows.filter(r => !r.cached);
  return fresh.reduce(
    (acc, r) => ({
      input_tokens: acc.input_tokens + (r.input_tokens ?? 0),
      output_tokens: acc.output_tokens + (r.output_tokens ?? 0),
      tool_calls: acc.tool_calls + (r.tool_calls?.length ?? 0),
      n: acc.n + 1,
    }),
    { input_tokens: 0, output_tokens: 0, tool_calls: 0, n: 0 },
  );
}

const [, , baselinePath, currentPath] = process.argv;
if (!baselinePath || !currentPath) {
  console.error("usage: bun scripts/compare-baseline.ts <baseline.json> <current.json>");
  process.exit(2);
}

const base = summarize(loadRows(baselinePath));
const cur = summarize(loadRows(currentPath));

const fmt = (a: number, b: number) =>
  `${a} → ${b} (${b < a ? "-" : "+"}${Math.abs(((b - a) / Math.max(1, a)) * 100).toFixed(1)}%)`;

console.log(`fresh findings: ${base.n} → ${cur.n}`);
console.log(`input_tokens:   ${fmt(base.input_tokens, cur.input_tokens)}`);
console.log(`output_tokens:  ${fmt(base.output_tokens, cur.output_tokens)}`);
console.log(`tool_calls:     ${fmt(base.tool_calls, cur.tool_calls)}`);

const inputDelta = (cur.input_tokens - base.input_tokens) / Math.max(1, base.input_tokens);
const toolDelta = (cur.tool_calls - base.tool_calls) / Math.max(1, base.tool_calls);

if (inputDelta > 0 || toolDelta > 0) {
  console.error("REGRESSION: tokens or tool-calls increased vs baseline");
  process.exit(1);
}
process.exit(0);
