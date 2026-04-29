import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrepTool } from "../../../src/core/agent/tools/grep.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sast-triage-grep-"));
}

describe("createGrepTool", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
    writeFileSync(join(root, "app.py"), "import os\npassword = 'secret'\nprint(password)\n");
    writeFileSync(join(root, "utils.py"), "def helper():\n    return 42\n");
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "config.py"), "DEBUG = True\nSECRET_KEY = 'abc'\n");
    writeFileSync(join(root, "notes.txt"), "password reminder here\n");
  });

  it("finds matches across files", async () => {
    const tool = createGrepTool(root);
    const result = await tool.execute({ pattern: "password" });
    expect(result).toContain("app.py");
    expect(result).toContain("notes.txt");
  });

  it("filters by subdirectory path", async () => {
    const tool = createGrepTool(root);
    const result = await tool.execute({ pattern: "SECRET", path: "sub" });
    expect(result).toContain("config.py");
    expect(result).not.toContain("app.py");
  });

  it("filters by include glob", async () => {
    const tool = createGrepTool(root);
    const result = await tool.execute({ pattern: "password", include: "*.py" });
    expect(result).toContain("app.py");
    expect(result).not.toContain("notes.txt");
  });

  it("returns 'No matches found.' when nothing matches", async () => {
    const tool = createGrepTool(root);
    const result = await tool.execute({ pattern: "ZZZUNLIKELY_PATTERN_XYZ" });
    expect(result).toBe("No matches found.");
  });

  it("returns file:line:content format", async () => {
    const tool = createGrepTool(root);
    const result = await tool.execute({ pattern: "helper" });
    expect(result).toMatch(/utils\.py:\d+:.*helper/);
  });
});
