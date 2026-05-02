import { describe, it, expect, vi } from "vitest";
import { findCallPathsToFunction } from "../../../src/infra/graph/multipath.js";
import type { GraphClient, NodeInfo } from "../../../src/infra/graph/index.js";

function fnNode(qname: string, path: string, start: number, end: number): NodeInfo {
  return {
    name: qname.split("::").pop() ?? qname,
    qualified_name: qname,
    kind: "Function",
    file_path: path,
    line_start: start,
    line_end: end,
  } as NodeInfo;
}

function mockClient(callersByTarget: Record<string, NodeInfo[]>): GraphClient {
  return {
    queryGraph: vi.fn(async (args) => {
      if (args.pattern !== "callers_of") return [];
      return callersByTarget[args.target] ?? [];
    }),
    searchSymbol: vi.fn(async () => []),
    close: vi.fn(),
  };
}

describe("findCallPathsToFunction", () => {
  it("returns single-element path when target has no callers", async () => {
    const client = mockClient({});
    const target = fnNode("/repo/app/foo.js::handler", "/repo/app/foo.js", 10, 30);
    const paths = await findCallPathsToFunction(client, target, { maxPaths: 3, maxDepth: 4 });
    expect(paths).toEqual([[target]]);
  });

  it("walks one level up when target has a single caller", async () => {
    const target = fnNode("/repo/app/foo.js::handler", "/repo/app/foo.js", 10, 30);
    const router = fnNode("/repo/server.js::wireRoutes", "/repo/server.js", 100, 120);
    const client = mockClient({
      "/repo/app/foo.js::handler": [router],
      "/repo/server.js::wireRoutes": [], // entrypoint
    });
    const paths = await findCallPathsToFunction(client, target, { maxPaths: 3, maxDepth: 4 });
    expect(paths).toHaveLength(1);
    expect(paths[0].map(n => n.qualified_name)).toEqual([
      "/repo/server.js::wireRoutes",
      "/repo/app/foo.js::handler",
    ]);
  });

  it("returns up to maxPaths distinct paths when multiple entry points exist", async () => {
    const target = fnNode("/repo/lib/helper.js::sanitize", "/repo/lib/helper.js", 5, 15);
    const a = fnNode("/repo/routes/a.js::handleA", "/repo/routes/a.js", 10, 30);
    const b = fnNode("/repo/routes/b.js::handleB", "/repo/routes/b.js", 10, 30);
    const c = fnNode("/repo/routes/c.js::handleC", "/repo/routes/c.js", 10, 30);
    const d = fnNode("/repo/routes/d.js::handleD", "/repo/routes/d.js", 10, 30);
    const client = mockClient({
      "/repo/lib/helper.js::sanitize": [a, b, c, d],
      "/repo/routes/a.js::handleA": [],
      "/repo/routes/b.js::handleB": [],
      "/repo/routes/c.js::handleC": [],
      "/repo/routes/d.js::handleD": [],
    });
    const paths = await findCallPathsToFunction(client, target, { maxPaths: 3, maxDepth: 4 });
    expect(paths).toHaveLength(3);
    // First path's entrypoint must come from the four candidates
    expect(["/repo/routes/a.js::handleA", "/repo/routes/b.js::handleB", "/repo/routes/c.js::handleC", "/repo/routes/d.js::handleD"])
      .toContain(paths[0][0].qualified_name);
  });

  it("stops at maxDepth even if callers chain continues", async () => {
    const target = fnNode("/repo/x.js::sink", "/repo/x.js", 5, 10);
    const lvl1 = fnNode("/repo/x.js::lvl1", "/repo/x.js", 20, 30);
    const lvl2 = fnNode("/repo/x.js::lvl2", "/repo/x.js", 35, 45);
    const lvl3 = fnNode("/repo/x.js::lvl3", "/repo/x.js", 50, 60);
    const lvl4 = fnNode("/repo/x.js::lvl4", "/repo/x.js", 70, 80);
    const client = mockClient({
      "/repo/x.js::sink": [lvl1],
      "/repo/x.js::lvl1": [lvl2],
      "/repo/x.js::lvl2": [lvl3],
      "/repo/x.js::lvl3": [lvl4],
      "/repo/x.js::lvl4": [], // entry, but maxDepth=2 should stop earlier
    });
    const paths = await findCallPathsToFunction(client, target, { maxPaths: 3, maxDepth: 2 });
    expect(paths).toHaveLength(1);
    expect(paths[0].map(n => n.qualified_name)).toEqual([
      "/repo/x.js::lvl2",
      "/repo/x.js::lvl1",
      "/repo/x.js::sink",
    ]);
  });

  it("breaks cycles by flushing the truncated path instead of looping forever", async () => {
    const a = fnNode("/repo/x.js::a", "/repo/x.js", 1, 5);
    const b = fnNode("/repo/x.js::b", "/repo/x.js", 6, 10);
    const client = mockClient({
      "/repo/x.js::a": [b],
      "/repo/x.js::b": [a], // mutual recursion — every caller eventually loops back
    });
    const paths = await findCallPathsToFunction(client, a, { maxPaths: 3, maxDepth: 5 });
    // Critical: must return at least one path. If the BFS skips cyclic callers
    // and lets the frontier drain to empty, completed[] stays empty → []. The
    // implementation must treat "no non-cyclic callers left" as a truncated
    // terminal and flush the current path.
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.length).toBeLessThanOrEqual(3);
    for (const p of paths) {
      const names = p.map(n => n.qualified_name);
      expect(new Set(names).size).toBe(names.length); // no dupes within a path
    }
  });
});
