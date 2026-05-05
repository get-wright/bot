import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphClient, NodeInfo } from "../../../src/infra/graph/index.js";

vi.mock("../../../src/infra/graph/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/infra/graph/index.js")>();
  return {
    ...actual,
    maybeCreateGraphClient: vi.fn(),
  };
});

const { maybeCreateGraphClient } = await import("../../../src/infra/graph/index.js");
const { TriageOrchestrator, resolveFocusedReadPlan } = await import("../../../src/core/triage/orchestrator.js");

describe("resolveFocusedReadPlan", () => {
  const originalPrefetchContext = process.env.SAST_FOCUSED_READ_CONTEXT;

  afterEach(() => {
    if (originalPrefetchContext === undefined) {
      delete process.env.SAST_FOCUSED_READ_CONTEXT;
    } else {
      process.env.SAST_FOCUSED_READ_CONTEXT = originalPrefetchContext;
    }
  });

  it("returns hint, context, and registry seeds when focused context injection is explicitly enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "sast-triage-focused-context-"));
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src/example.ts"),
      Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n"),
    );
    process.env.SAST_FOCUSED_READ_CONTEXT = "1";

    const summary: NodeInfo[] = [{
      name: "handler",
      qualified_name: "src/example.ts::handler",
      kind: "Function",
      file_path: join(root, "src/example.ts"),
      line_start: 200,
      line_end: 210,
    } as NodeInfo];

    const plan = await resolveFocusedReadPlan({
      check_id: "test.rule",
      path: "src/example.ts",
      start: { line: 205, col: 1, offset: 0 },
      end: { line: 205, col: 10, offset: 0 },
      extra: {
        message: "test finding",
        severity: "WARNING",
        lines: "two",
        metadata: { cwe: ["CWE-95"] },
      },
    } as any, summary, root);

    expect(plan).toMatchObject({
      hint: '{"path":"src/example.ts","offset":180,"limit":51}',
      range: { path: "src/example.ts", offset: 180, limit: 51 },
    });
    expect(plan!.context).toContain("205\tline 205");
    expect(plan!.seeds?.length).toBe(1);
  });

  it("skips focused read hints for small files", async () => {
    const root = mkdtempSync(join(tmpdir(), "sast-triage-focused-small-"));
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src/example.ts"),
      Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"),
    );

    const summary: NodeInfo[] = [{
      name: "handler",
      qualified_name: "src/example.ts::handler",
      kind: "Function",
      file_path: join(root, "src/example.ts"),
      line_start: 40,
      line_end: 50,
    } as NodeInfo];

    const plan = await resolveFocusedReadPlan({
      check_id: "test.rule",
      path: "src/example.ts",
      start: { line: 45, col: 1, offset: 0 },
      end: { line: 45, col: 10, offset: 0 },
      extra: {
        message: "test finding",
        severity: "WARNING",
        lines: "line 45",
        metadata: { cwe: ["CWE-95"] },
      },
    } as any, summary, root);

    expect(plan).toBeNull();
  });
});

describe("TriageOrchestrator graph prefetch", () => {
  const originalCwd = process.cwd();
  const originalPrefetch = process.env.SAST_GRAPH_PREFETCH;

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalPrefetch === undefined) {
      delete process.env.SAST_GRAPH_PREFETCH;
    } else {
      process.env.SAST_GRAPH_PREFETCH = originalPrefetch;
    }
    vi.mocked(maybeCreateGraphClient).mockReset();
  });

  it("fetches file_summary once per finding when building graph context and focused reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "sast-triage-prefetch-"));
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src/example.ts"),
      Array.from({ length: 500 }, (_, i) => `${i + 1}: line`).join("\n"),
    );
    const findingsPath = join(root, "findings.json");
    writeFileSync(findingsPath, JSON.stringify({
      results: [{
        check_id: "test.rule",
        path: "src/example.ts",
        start: { line: 205, col: 1, offset: 0 },
        end: { line: 205, col: 10, offset: 0 },
        extra: {
          message: "test finding",
          severity: "WARNING",
          lines: "205: line",
          metadata: { cwe: ["CWE-95"] },
        },
      }],
    }));

    const summary: NodeInfo[] = [{
      name: "handler",
      qualified_name: "src/example.ts::handler",
      kind: "Function",
      file_path: join(root, "src/example.ts"),
      line_start: 200,
      line_end: 210,
    } as NodeInfo];
    const queryGraph = vi.fn(async (args: { pattern: string; target: string }) => {
      if (args.pattern === "file_summary") return summary;
      return [];
    });
    const graphClient = {
      queryGraph,
      searchSymbol: vi.fn(async () => []),
      close: vi.fn(async () => {}),
    } as unknown as GraphClient;
    vi.mocked(maybeCreateGraphClient).mockResolvedValue(graphClient);

    process.chdir(root);
    process.env.SAST_GRAPH_PREFETCH = "1";

    const orchestrator = new TriageOrchestrator();
    orchestrator.triageBatch = vi.fn(async () => {});

    await orchestrator.run({
      findingsPath,
      outputPath: join(root, "findings-out.json"),
      provider: "openai",
      model: "gpt-4o",
      headless: true,
      allowBash: false,
      maxSteps: 15,
      concurrency: 1,
      workers: 1,
      workerRestart: false,
    } as any);

    const fileSummaryCalls = queryGraph.mock.calls.filter(
      ([args]) => args.pattern === "file_summary" && args.target === "src/example.ts",
    );
    expect(fileSummaryCalls).toHaveLength(1);
    const batchArg = vi.mocked(orchestrator.triageBatch).mock.calls[0]![0];
    expect(batchArg.items[0]!.focusedReadHint).toBe('{"path":"src/example.ts","offset":180,"limit":51}');
    expect(batchArg.items[0]!.preferredReadRange).toEqual({ path: "src/example.ts", offset: 180, limit: 51 });
    expect(batchArg.items[0]!.initialCodeContext).toBeNull();
    expect(batchArg.items[0]!.initialReadRegistrySeeds).toBeUndefined();
  });
});
