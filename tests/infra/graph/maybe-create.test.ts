import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  isGraphDbSparse,
  maybeCreateGraphClient,
} from "../../../src/infra/graph/index.js";
import type { GraphClient } from "../../../src/infra/graph/index.js";

function makeRepoWithDb(rows: number): string {
  const dir = mkdtempSync(join(tmpdir(), "graph-sparse-"));
  mkdirSync(join(dir, ".code-review-graph"), { recursive: true });
  const db = new Database(join(dir, ".code-review-graph", "graph.db"));
  db.exec("CREATE TABLE nodes (id INTEGER PRIMARY KEY, name TEXT)");
  const ins = db.prepare("INSERT INTO nodes (name) VALUES (?)");
  for (let i = 0; i < rows; i++) ins.run(`n${i}`);
  db.close();
  return dir;
}

describe("isGraphDbSparse (pure helper)", () => {
  it("returns true when graph.db is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-missing-"));
    expect(await isGraphDbSparse(dir)).toBe(true);
  });

  it("returns true when nodes table has fewer than 5 rows", async () => {
    const dir = makeRepoWithDb(2);
    expect(await isGraphDbSparse(dir)).toBe(true);
  });

  it("returns false when nodes table has 5 or more rows", async () => {
    const dir = makeRepoWithDb(5);
    expect(await isGraphDbSparse(dir)).toBe(false);
  });

  it("respects custom minNodes threshold", async () => {
    const dir = makeRepoWithDb(3);
    expect(await isGraphDbSparse(dir, 2)).toBe(false);
    expect(await isGraphDbSparse(dir, 4)).toBe(true);
  });
});

describe("maybeCreateGraphClient (with DI)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null when SAST_USE_GRAPH is not set", async () => {
    vi.stubEnv("SAST_USE_GRAPH", "");
    const out = await maybeCreateGraphClient("/tmp/whatever");
    expect(out).toBeNull();
  });

  it("returns null when isSparse returns true (does not call createClient)", async () => {
    vi.stubEnv("SAST_USE_GRAPH", "1");
    const createClient = vi.fn();
    const out = await maybeCreateGraphClient("/tmp/repo", {
      findBinary: () => "/fake/bin/code-review-graph",
      ensureBuilt: async () => {},
      isSparse: async () => true,
      createClient,
    });
    expect(out).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns the client when graph is healthy", async () => {
    vi.stubEnv("SAST_USE_GRAPH", "1");
    const fakeClient = { queryGraph: vi.fn(), searchSymbol: vi.fn(), close: vi.fn() };
    const out = await maybeCreateGraphClient("/tmp/repo", {
      findBinary: () => "/fake/bin/code-review-graph",
      ensureBuilt: async () => {},
      isSparse: async () => false,
      createClient: async () => fakeClient as unknown as GraphClient,
    });
    expect(out).toBe(fakeClient);
  });

  it("returns null when build throws (independent of sparseness)", async () => {
    vi.stubEnv("SAST_USE_GRAPH", "1");
    const isSparse = vi.fn();
    const out = await maybeCreateGraphClient("/tmp/repo", {
      findBinary: () => "/fake/bin/code-review-graph",
      ensureBuilt: async () => { throw new Error("build failed"); },
      isSparse,
      createClient: async () => null,
    });
    expect(out).toBeNull();
    expect(isSparse).not.toHaveBeenCalled();
  });
});
