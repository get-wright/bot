import { describe, it, expect, vi } from "vitest";
import { prefetchGraphContext } from "../../../src/infra/graph/prefetch.js";
import type { GraphClient, NodeInfo } from "../../../src/infra/graph/index.js";
import type { Finding } from "../../../src/core/models/finding.js";

function makeFinding(path: string, line: number): Finding {
  return {
    check_id: "test.rule",
    path,
    start: { line, col: 1 },
    end: { line, col: 80 },
    extra: {
      severity: "ERROR",
      message: "test finding",
      lines: "code",
      metadata: { cwe: ["CWE-79"], category: "security", technology: ["javascript"] },
      dataflow_trace: undefined,
    },
  } as Finding;
}

function fnNode(qualified: string, path: string, start: number, end: number): NodeInfo {
  return {
    name: qualified.split("::").pop() ?? qualified,
    qualified_name: qualified,
    kind: "Function",
    file_path: path,
    line_start: start,
    line_end: end,
  } as NodeInfo;
}

function mockClient(by: Record<string, NodeInfo[]>): GraphClient {
  return {
    queryGraph: vi.fn(async (args) => by[`${args.pattern}:${args.target}`] ?? []),
    searchSymbol: vi.fn(async () => []),
    close: vi.fn(),
  };
}

describe("prefetchGraphContext", () => {
  it("returns null when file_summary is empty (file not in graph)", async () => {
    const client = mockClient({});
    const out = await prefetchGraphContext(makeFinding("app/foo.js", 5), client, "/repo");
    expect(out).toBeNull();
  });

  it("formats file summary + enclosing function only (no callers/callees)", async () => {
    const client = mockClient({
      "file_summary:app/foo.js": [
        fnNode("/repo/app/foo.js::handler", "/repo/app/foo.js", 10, 30),
        fnNode("/repo/app/foo.js::helper", "/repo/app/foo.js", 35, 50),
      ],
    });
    const out = await prefetchGraphContext(makeFinding("app/foo.js", 15), client, "/repo");
    expect(out).not.toBeNull();
    expect(out).toContain("File contains 2 symbols");
    expect(out).toContain("app/foo.js::handler");
    expect(out).toContain("app/foo.js::helper");
    expect(out).toContain("Enclosing function:");
    // file_path is relativized; qualified_name preserved as opaque graph identifier.
    expect(out).toMatch(/app\/foo\.js:10-30/);
    expect(out).not.toMatch(/\/repo\/app\/foo\.js:10-30/);
    // Trimmed prefetch: no callers/callees — they bias the model toward FP by
    // making the wrapper function "look safe" without reading the sink.
    expect(out).not.toContain("Callers");
    expect(out).not.toContain("Callees");
    // Only file_summary should be queried — no callers_of/callees_of round-trips.
    expect(client.queryGraph).toHaveBeenCalledTimes(1);
  });

  it("emits file_summary even when no enclosing function found", async () => {
    const client = mockClient({
      "file_summary:app/foo.js": [
        fnNode("/repo/app/foo.js::handler", "/repo/app/foo.js", 10, 30),
      ],
    });
    const out = await prefetchGraphContext(makeFinding("app/foo.js", 100), client, "/repo");
    expect(out).not.toBeNull();
    expect(out).toContain("File contains 1 symbol");
    expect(out).not.toContain("Enclosing function");
    expect(client.queryGraph).toHaveBeenCalledTimes(1);
  });

  it("caps long lists to keep prompt size bounded", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      fnNode(`/repo/app/foo.js::sym${i}`, "/repo/app/foo.js", i * 5 + 1, i * 5 + 4),
    );
    const client = mockClient({ "file_summary:app/foo.js": many });
    const out = await prefetchGraphContext(makeFinding("app/foo.js", 7), client, "/repo");
    expect(out).toContain("File contains 30 symbols");
    // First 10 symbols should be enumerated, the rest summarized as "...and N more".
    const symLines = (out!.match(/sym\d+/g) ?? []).length;
    expect(symLines).toBeLessThanOrEqual(15); // at most 10 enumerated + maybe some in enclosing/callers
  });
});
