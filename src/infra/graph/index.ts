import { execFile, execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createGraphClient, type GraphClient } from "./mcp-client.js";

export { createGraphClient } from "./mcp-client.js";
export type { GraphClient } from "./mcp-client.js";
export type { NodeInfo, QueryGraphArgs, SearchSymbolArgs } from "./types.js";

const execFileAsync = promisify(execFile);
// Graph builds are expensive (~10s for a 500-file repo); 24h refresh is the
// trade-off between freshness and cost for a long-running agent loop.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function findGraphBinary(): string | null {
  try {
    const path = execFileSync("which", ["code-review-graph"], { encoding: "utf8" }).trim();
    return path || null;
  } catch {
    return null;
  }
}

export function isGraphStale(repoRoot: string): boolean {
  // Upstream emits `.code-review-graph/graph.db` (SQLite file).
  const dbPath = join(repoRoot, ".code-review-graph", "graph.db");
  if (!existsSync(dbPath)) return true;
  const ageMs = Date.now() - statSync(dbPath).mtimeMs;
  return ageMs > STALE_AFTER_MS;
}

export async function ensureGraphBuilt(repoRoot: string, binary: string): Promise<void> {
  if (!isGraphStale(repoRoot)) return;
  await execFileAsync(binary, ["build"], {
    cwd: repoRoot,
    timeout: 120_000,
  });
}

export async function maybeCreateGraphClient(repoRoot: string): Promise<GraphClient | null> {
  if (process.env.SAST_USE_GRAPH !== "1") return null;
  const binary = findGraphBinary();
  if (!binary) return null;
  try {
    await ensureGraphBuilt(repoRoot, binary);
  } catch (e) {
    console.error(`[graph] build failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  return createGraphClient({ repoRoot, binaryPath: binary });
}
