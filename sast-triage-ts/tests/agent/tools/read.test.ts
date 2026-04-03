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

  describe("permission flow", () => {
    it("allows pre-approved paths without asking", async () => {
      const outside = makeTempDir();
      writeFileSync(join(outside, "data.txt"), "secret\n");

      const tool = createReadTool(root, {
        isPathAllowed: () => true,
        requestPermission: async () => "deny",
      });
      const result = await tool.execute({ path: join(outside, "data.txt") });
      expect(result).toContain("secret");
    });

    it("asks permission for out-of-root paths and proceeds on 'once'", async () => {
      const outside = makeTempDir();
      writeFileSync(join(outside, "data.txt"), "content\n");

      let askedPath = "";
      const tool = createReadTool(root, {
        isPathAllowed: () => false,
        requestPermission: async (path) => {
          askedPath = path;
          return "once";
        },
      });
      const result = await tool.execute({ path: join(outside, "data.txt") });
      expect(result).toContain("content");
      expect(askedPath).toBe(join(outside, "data.txt"));
    });

    it("denies access when permission rejected", async () => {
      const outside = makeTempDir();
      writeFileSync(join(outside, "data.txt"), "content\n");

      const tool = createReadTool(root, {
        isPathAllowed: () => false,
        requestPermission: async () => "deny",
      });
      await expect(tool.execute({ path: join(outside, "data.txt") })).rejects.toThrow(
        "Access denied",
      );
    });

    it("rejects out-of-root paths when no permission handler provided", async () => {
      const tool = createReadTool(root);
      await expect(tool.execute({ path: "../etc/passwd" })).rejects.toThrow();
    });
  });
});
