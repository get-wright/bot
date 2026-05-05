import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool, type ReadRegistry } from "../../../../src/core/agent/tools/read.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sast-triage-read-"));
}

describe("createReadTool", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
  });

  it("reads a file with line numbers", async () => {
    writeFileSync(join(root, "hello.py"), "line one\nline two\nline three\n");
    const tool = createReadTool({ projectRoot: root });
    const result = await tool.execute({ path: "hello.py" });
    expect(result).toContain("1\tline one");
    expect(result).toContain("2\tline two");
    expect(result).toContain("3\tline three");
  });

  it("respects offset (1-indexed)", async () => {
    writeFileSync(join(root, "file.txt"), "a\nb\nc\nd\n");
    const tool = createReadTool({ projectRoot: root });
    const result = await tool.execute({ path: "file.txt", offset: 2 });
    expect(result).not.toContain("1\ta");
    expect(result).toContain("2\tb");
    expect(result).toContain("3\tc");
  });

  it("respects limit", async () => {
    writeFileSync(join(root, "file.txt"), "a\nb\nc\nd\n");
    const tool = createReadTool({ projectRoot: root });
    const result = await tool.execute({ path: "file.txt", limit: 2 });
    expect(result).toContain("1\ta");
    expect(result).toContain("2\tb");
    expect(result).not.toContain("3\tc");
  });

  it("reads nested paths", async () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "main.ts"), "export {};\n");
    const tool = createReadTool({ projectRoot: root });
    const result = await tool.execute({ path: "src/main.ts" });
    expect(result).toContain("1\texport {};");
  });

  it("rejects path traversal outside project root", async () => {
    const tool = createReadTool({ projectRoot: root });
    await expect(tool.execute({ path: "../etc/passwd" })).rejects.toThrow();
  });

  it("rejects absolute paths outside root", async () => {
    const tool = createReadTool({ projectRoot: root });
    await expect(tool.execute({ path: "/etc/passwd" })).rejects.toThrow();
  });

  it("throws for nonexistent file", async () => {
    const tool = createReadTool({ projectRoot: root });
    await expect(tool.execute({ path: "does_not_exist.txt" })).rejects.toThrow();
  });

  it("appends end-of-file footer when reading full file", async () => {
    writeFileSync(join(root, "short.txt"), "one\ntwo\nthree\n");
    const tool = createReadTool({ projectRoot: root });
    const result = await tool.execute({ path: "short.txt" });
    expect(result).toContain("[End of file — 3 lines total]");
  });

  it("appends pagination hint when file exceeds limit", async () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(root, "long.txt"), content);
    const tool = createReadTool({ projectRoot: root });
    const result = await tool.execute({ path: "long.txt", limit: 10 });
    expect(result).toContain("[Showing lines 1-10 of 50 — use offset=11 to continue]");
  });

  it("indicates EOF when offset reaches end", async () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(root, "file.txt"), content);
    const tool = createReadTool({ projectRoot: root });
    const result = await tool.execute({ path: "file.txt", offset: 15, limit: 10 });
    expect(result).toContain("[End of file — showed lines 15-20 of 20]");
  });

  it("truncates overly long lines", async () => {
    const longLine = "x".repeat(3000);
    writeFileSync(join(root, "minified.js"), longLine);
    const tool = createReadTool({ projectRoot: root });
    const result = await tool.execute({ path: "minified.js" });
    expect(result).toContain("[line truncated, 3000 chars total]");
    expect(result).not.toContain("x".repeat(2500));
  });

  it("forceRegister seeds tiny files and deduplicates repeated reads", async () => {
    mkdirSync(join(root, "src"));
    // Explicitly under DEDUP_MIN_BYTES (200 bytes).
    writeFileSync(join(root, "src/app.js"), "a\nb\nc\n");

    const registry: ReadRegistry = new Map();
    const first = createReadTool({ projectRoot: root, registry, forceRegister: true });
    const full = await first.execute({ path: "src/app.js", offset: 1, limit: 3 });
    expect(full).toContain("1\ta");
    expect(registry.size).toBe(1);

    const seeds = [...registry.entries()].map(([absPath, entry]) => ({ absPath, entry }));
    const seededRegistry: ReadRegistry = new Map(seeds.map((s) => [s.absPath, s.entry]));
    const second = createReadTool({ projectRoot: root, registry: seededRegistry });
    const stub = await second.execute({ path: "src/app.js", offset: 1, limit: 3 });

    expect(stub).toContain("was already read");
  });

  describe("path confinement (no permissions)", () => {
    it("throws when path resolves outside project root", async () => {
      const tool = createReadTool({ projectRoot: "/tmp/some-project" });
      await expect(tool.execute({ path: "../../etc/passwd" })).rejects.toThrow(
        /outside project root/i
      );
    });
  });
});
