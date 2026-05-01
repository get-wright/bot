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

// <5 nodes means the build succeeded but indexed nothing meaningful (empty or unsupported-language repo).
const MIN_GRAPH_NODES = 5;

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

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

interface SparseDb {
  countNodes(): number;
  close(): void;
}

async function openGraphDb(dbPath: string): Promise<SparseDb | null> {
  try {
    if (isBun) {
      const mod = await import("bun:sqlite");
      const db = new mod.Database(dbPath, { readonly: true });
      return {
        countNodes: () => (db.query("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c,
        close: () => db.close(),
      };
    }
    const mod = await import("better-sqlite3");
    const db = new mod.default(dbPath, { readonly: true });
    return {
      countNodes: () => (db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c,
      close: () => db.close(),
    };
  } catch {
    return null;
  }
}

/**
 * Pure helper: returns true when `<repoRoot>/.code-review-graph/graph.db` is
 * missing OR contains fewer than MIN_GRAPH_NODES rows in the `nodes` table.
 * Exported so it can be tested directly.
 */
export async function isGraphDbSparse(repoRoot: string, minNodes = MIN_GRAPH_NODES): Promise<boolean> {
  const dbPath = join(repoRoot, ".code-review-graph", "graph.db");
  if (!existsSync(dbPath)) return true;
  const db = await openGraphDb(dbPath);
  if (!db) return true;
  try {
    return db.countNodes() < minNodes;
  } catch {
    return true;
  } finally {
    db.close();
  }
}

export interface MaybeCreateGraphClientDeps {
  findBinary?: () => string | null;
  ensureBuilt?: (repoRoot: string, binary: string) => Promise<void>;
  isSparse?: (repoRoot: string) => Promise<boolean>;
  createClient?: (opts: { repoRoot: string; binaryPath: string }) => Promise<GraphClient | null>;
}

export async function maybeCreateGraphClient(
  repoRoot: string,
  deps: MaybeCreateGraphClientDeps = {},
): Promise<GraphClient | null> {
  if (process.env.SAST_USE_GRAPH !== "1") return null;
  const findBinary   = deps.findBinary   ?? findGraphBinary;
  const ensureBuilt  = deps.ensureBuilt  ?? ensureGraphBuilt;
  const isSparse     = deps.isSparse     ?? isGraphDbSparse;
  const mkClient     = deps.createClient ?? createGraphClient;

  const binary = findBinary();
  if (!binary) return null;
  try {
    await ensureBuilt(repoRoot, binary);
  } catch (e) {
    console.error(`[graph] build failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (await isSparse(repoRoot)) {
    console.error("[graph] sparse or missing DB — disabling graph integration");
    return null;
  }
  return mkClient({ repoRoot, binaryPath: binary });
}
