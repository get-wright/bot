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
const { TriageOrchestrator } = await import("../../../src/core/triage/orchestrator.js");

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
      Array.from({ length: 30 }, (_, i) => `${i + 1}: line`).join("\n"),
    );
    const findingsPath = join(root, "findings.json");
    writeFileSync(findingsPath, JSON.stringify({
      results: [{
        check_id: "test.rule",
        path: "src/example.ts",
        start: { line: 12, col: 1, offset: 0 },
        end: { line: 12, col: 10, offset: 0 },
        extra: {
          message: "test finding",
          severity: "WARNING",
          lines: "12: line",
          metadata: { cwe: ["CWE-95"] },
        },
      }],
    }));

    const summary: NodeInfo[] = [{
      name: "handler",
      qualified_name: "src/example.ts::handler",
      kind: "Function",
      file_path: join(root, "src/example.ts"),
      line_start: 10,
      line_end: 20,
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
    expect(batchArg.items[0]!.focusedReadHint).toBe('read("src/example.ts", offset=10, limit=11)');
    expect(batchArg.items[0]!.initialCodeContext).toBeNull();
    expect(batchArg.items[0]!.initialReadRegistrySeeds).toBeUndefined();
  });
});
