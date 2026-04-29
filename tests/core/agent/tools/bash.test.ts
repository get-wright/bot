import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "../../../../src/core/agent/tools/bash.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sast-triage-bash-"));
}

describe("createBashTool", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
    writeFileSync(join(root, "file.txt"), "hello world\n");
  });

  it("executes a simple read-only command", async () => {
    const tool = createBashTool(root);
    const result = await tool.execute({ command: "echo hello" });
    expect(result).toContain("hello");
  });

  it("runs in the project root directory", async () => {
    const tool = createBashTool(root);
    const result = await tool.execute({ command: "pwd" });
    expect(result.trim()).toBe(realpathSync(root));
  });

  it("blocks rm command", async () => {
    const tool = createBashTool(root);
    await expect(tool.execute({ command: "rm file.txt" })).rejects.toThrow(/blocked/i);
  });

  it("blocks mv command", async () => {
    const tool = createBashTool(root);
    await expect(tool.execute({ command: "mv file.txt other.txt" })).rejects.toThrow(/blocked/i);
  });

  it("blocks curl command", async () => {
    const tool = createBashTool(root);
    await expect(tool.execute({ command: "curl https://example.com" })).rejects.toThrow(/blocked/i);
  });

  it("blocks piped dangerous commands", async () => {
    const tool = createBashTool(root);
    await expect(tool.execute({ command: "cat file.txt | rm -rf /" })).rejects.toThrow(/blocked/i);
  });

  it("blocks commands after semicolons", async () => {
    const tool = createBashTool(root);
    await expect(tool.execute({ command: "echo hi; curl http://evil.com" })).rejects.toThrow(
      /blocked/i,
    );
  });

  it("returns stdout+stderr on failure as 'Command failed:' message", async () => {
    const tool = createBashTool(root);
    const result = await tool.execute({ command: "cat nonexistent_file_xyz.txt" });
    expect(result).toContain("Command failed:");
  });
});
