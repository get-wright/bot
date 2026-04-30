import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool } from "../../../../src/core/agent/tools/read.js";

function setup() {
  return mkdtempSync(join(tmpdir(), "read-pathgate-"));
}

describe("createReadTool path existence gate", () => {
  it("throws plain not-found when basename matches no files", async () => {
    const root = setup();
    const tool = createReadTool({ projectRoot: root });
    await expect(tool.execute({ path: "no-such.js" })).rejects.toThrow(/^File not found: no-such\.js$/);
  });

  it("appends suggestions when basename exists at other paths", async () => {
    const root = setup();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "lib"), { recursive: true });
    writeFileSync(join(root, "src/server.js"), "// real");
    writeFileSync(join(root, "lib/server.js"), "// also real");

    const tool = createReadTool({ projectRoot: root });
    await expect(tool.execute({ path: "app/server.js" })).rejects.toThrow(
      /File not found: app\/server\.js — did you mean: (src\/server\.js|lib\/server\.js)/
    );
  });

  it("ignores node_modules and .git when suggesting", async () => {
    const root = setup();
    mkdirSync(join(root, "node_modules"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "node_modules/server.js"), "// dep");
    writeFileSync(join(root, "src/server.js"), "// real");

    const tool = createReadTool({ projectRoot: root });
    let thrown: Error | undefined;
    try {
      await tool.execute({ path: "missing/server.js" });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/did you mean: src\/server\.js/);
    expect(thrown!.message).not.toMatch(/node_modules/);
  });

  it("returns at most 5 suggestions, sorted by path length", async () => {
    const root = setup();
    for (const dir of ["a", "ab", "abc", "abcd", "abcde", "abcdef", "abcdefg"]) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "x.js"), "");
    }
    const tool = createReadTool({ projectRoot: root });
    let thrown: Error | undefined;
    try {
      await tool.execute({ path: "missing/x.js" });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    // Lookbehind excludes the failing path itself ("missing/x.js"), which would
    // otherwise produce a false "g/x.js" substring match.
    const matches = thrown!.message.match(/(?<![a-z])[a-g]+\/x\.js/g) ?? [];
    expect(matches.length).toBe(5);
    expect(matches[0]).toBe("a/x.js");
  });
});
