import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGraphClient, findGraphBinary } from "../src/infra/graph/index.js";
import type { GraphClient } from "../src/infra/graph/index.js";

const binary = findGraphBinary();
const skip = !binary;

describe.skipIf(skip)("code-review-graph integration", () => {
  let workDir: string;
  let client: GraphClient;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "graph-int-"));
    cpSync(resolve(import.meta.dirname, "fixtures/sample-repo"), workDir, { recursive: true });
    execFileSync(binary!, ["build"], { cwd: workDir, timeout: 60_000 });
    const c = await createGraphClient({ repoRoot: workDir, binaryPath: binary! });
    if (!c) throw new Error("graph client failed to initialise");
    client = c;
  }, 90_000);

  afterAll(async () => {
    if (client) await client.close().catch(() => {});
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("searchSymbol finds evalUserInput", async () => {
    const results = await client.searchSymbol({ query: "evalUserInput" });
    expect(results.length).toBeGreaterThan(0);
    const node = results.find(r => r.name === "evalUserInput");
    expect(node).toBeDefined();
    expect(node!.file_path).toMatch(/server\.js$/);
    expect(node!.line_start).toBe(1);
  });

  it("queryGraph callers_of returns main as caller of evalUserInput", async () => {
    const results = await client.queryGraph({ pattern: "callers_of", target: "evalUserInput" });
    const names = results.map(r => r.name);
    expect(names).toContain("main");
  });
});
