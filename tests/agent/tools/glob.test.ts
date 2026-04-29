import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobTool } from "../../../src/agent/tools/glob.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sast-triage-glob-"));
}

describe("createGlobTool", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
    writeFileSync(join(root, "app.py"), "");
    writeFileSync(join(root, "README.md"), "");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "main.ts"), "");
    writeFileSync(join(root, "src", "utils.ts"), "");
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "");
  });

  it("finds files matching a glob pattern", async () => {
    const tool = createGlobTool(root);
    const result = await tool.execute({ pattern: "**/*.py" });
    expect(result).toContain("app.py");
    expect(result).not.toContain("main.ts");
  });

  it("auto-ignores node_modules", async () => {
    const tool = createGlobTool(root);
    const result = await tool.execute({ pattern: "**/*.js" });
    expect(result).not.toContain("node_modules");
  });

  it("filters to a subdirectory path", async () => {
    const tool = createGlobTool(root);
    const result = await tool.execute({ pattern: "**/*.ts", path: "src" });
    expect(result).toContain("main.ts");
    expect(result).not.toContain("app.py");
  });

  it("returns 'No files found.' when nothing matches", async () => {
    const tool = createGlobTool(root);
    const result = await tool.execute({ pattern: "**/*.xyz_nonexistent" });
    expect(result).toBe("No files found.");
  });

  it("matches multiple file types", async () => {
    const tool = createGlobTool(root);
    const result = await tool.execute({ pattern: "**/*.ts" });
    expect(result).toContain("main.ts");
    expect(result).toContain("utils.ts");
  });
});
