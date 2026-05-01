import type { GraphClient, NodeInfo } from "./index.js";

export interface FindPathsOptions {
  maxPaths: number;
  maxDepth: number;
}

// BFS upward through callers_of, returning up to maxPaths distinct paths.
// Each path is an array [entrypoint, ..., target]. Cycles are broken via
// per-path visited sets (not global) so the same intermediate node can
// appear in different paths.
//
// Terminal conditions per frontier item (in priority order):
//   1. callers_of returns empty   → reached an entrypoint, flush as path
//   2. all callers are cyclic     → flush as truncated path (otherwise the
//      mutual-recursion case would drain the frontier to empty and return [])
//   3. otherwise                  → expand to next frontier
// At maxDepth, any frontier items still alive get flushed as truncated paths.
//
// Complexity: at most 1 + maxDepth * (maxPaths * 4) queryGraph calls per invocation.
// With maxDepth=4, maxPaths=3: ≤ 49 calls. Callers (e.g. prefetch) should budget accordingly.
export async function findCallPathsToFunction(
  client: GraphClient,
  target: NodeInfo,
  opts: FindPathsOptions,
): Promise<NodeInfo[][]> {
  type Frontier = { node: NodeInfo; pathFromTarget: NodeInfo[] };

  const completed: NodeInfo[][] = [];
  let frontier: Frontier[] = [{ node: target, pathFromTarget: [target] }];

  const flush = (f: Frontier): void => {
    completed.push([...f.pathFromTarget].reverse());
  };

  for (let depth = 0; depth < opts.maxDepth && frontier.length > 0; depth++) {
    const next: Frontier[] = [];
    for (const f of frontier) {
      if (completed.length >= opts.maxPaths) break;
      const callers = await client.queryGraph({
        pattern: "callers_of",
        target: f.node.qualified_name,
      });
      if (callers.length === 0) {
        flush(f);
        continue;
      }
      // Filter callers to those not already in this path (cycle break).
      const fresh = callers.filter(
        c => !f.pathFromTarget.some(n => n.qualified_name === c.qualified_name),
      );
      if (fresh.length === 0) {
        // All callers loop back into this path — flush as truncated terminal.
        flush(f);
        continue;
      }
      for (const c of fresh) {
        if (completed.length + next.length >= opts.maxPaths * 4) break; // soft cap on fan-out
        next.push({ node: c, pathFromTarget: [...f.pathFromTarget, c] });
      }
    }
    frontier = next;
    if (completed.length >= opts.maxPaths) break;
  }

  // If we hit maxDepth with frontier still alive, flush remaining as truncated.
  if (completed.length < opts.maxPaths) {
    for (const f of frontier) {
      if (completed.length >= opts.maxPaths) break;
      flush(f);
    }
  }

  return completed.slice(0, opts.maxPaths);
}
