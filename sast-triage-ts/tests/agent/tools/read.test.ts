import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool } from "../../../src/agent/tools/read.js";

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
    const tool = createReadTool(root);
    const result = await tool.execute({ path: "hello.py" });
    expect(result).toContain("1\tline one");
    expect(result).toContain("2\tline two");
    expect(result).toContain("3\tline three");
  });

  it("respects offset (1-indexed)", async () => {
    writeFileSync(join(root, "file.txt"), "a\nb\nc\nd\n");
    const tool = createReadTool(root);
    const result = await tool.execute({ path: "file.txt", offset: 2 });
    expect(result).not.toContain("1\ta");
    expect(result).toContain("2\tb");
    expect(result).toContain("3\tc");
  });

  it("respects limit", async () => {
    writeFileSync(join(root, "file.txt"), "a\nb\nc\nd\n");
    const tool = createReadTool(root);
    const result = await tool.execute({ path: "file.txt", limit: 2 });
    expect(result).toContain("1\ta");
    expect(result).toContain("2\tb");
    expect(result).not.toContain("3\tc");
  });

  it("reads nested paths", async () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "main.ts"), "export {};\n");
    const tool = createReadTool(root);
    const result = await tool.execute({ path: "src/main.ts" });
    expect(result).toContain("1\texport {};");
  });

  it("rejects path traversal outside project root", async () => {
    const tool = createReadTool(root);
    await expect(tool.execute({ path: "../etc/passwd" })).rejects.toThrow();
  });

  it("rejects absolute paths outside root", async () => {
    const tool = createReadTool(root);
    await expect(tool.execute({ path: "/etc/passwd" })).rejects.toThrow();
  });

  it("throws for nonexistent file", async () => {
    const tool = createReadTool(root);
    await expect(tool.execute({ path: "does_not_exist.txt" })).rejects.toThrow();
  });
});
