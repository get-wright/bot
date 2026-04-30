import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool, type ReadRegistry } from "../../../../src/core/agent/tools/read.js";

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "read-dedup-"));
}

describe("createReadTool dedup", () => {
  it("returns stub on second read of same file when content unchanged", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.js"), "function foo() { return 1; }\nfunction bar() { return 2; }\n".repeat(20));
    const registry: ReadRegistry = new Map();
    let step = 0;
    const tool = createReadTool({ projectRoot: root, registry, getStep: () => step });

    step = 1;
    const first = await tool.execute({ path: "a.js" });
    expect(first).toContain("function foo");

    step = 4;
    const second = await tool.execute({ path: "a.js" });
    expect(second).toContain("[File a.js was already read at step 1");
    expect(second).toContain("content unchanged");
    expect(second).not.toContain("function foo");
  });

  it("returns fresh content when mtime changes between reads", async () => {
    const root = makeRoot();
    const file = join(root, "a.js");
    writeFileSync(file, "const v = 1;\n".repeat(20));
    const registry: ReadRegistry = new Map();
    let step = 0;
    const tool = createReadTool({ projectRoot: root, registry, getStep: () => step });

    step = 1;
    await tool.execute({ path: "a.js" });

    writeFileSync(file, "const v = 2;\n".repeat(20));
    const future = new Date(Date.now() + 5_000);
    utimesSync(file, future, future);

    step = 3;
    const second = await tool.execute({ path: "a.js" });
    expect(second).toContain("const v = 2");
    expect(second).toContain("[File modified since step 1 — re-reading]");
  });

  it("does NOT dedup when requested range is not covered (different offset)", async () => {
    const root = makeRoot();
    const lines = Array.from({ length: 50 }, (_, i) => `// line ${i + 1}`).join("\n");
    writeFileSync(join(root, "a.js"), lines);
    const registry: ReadRegistry = new Map();
    const tool = createReadTool({ projectRoot: root, registry, getStep: () => 1 });

    await tool.execute({ path: "a.js", offset: 1, limit: 10 });
    const second = await tool.execute({ path: "a.js", offset: 20, limit: 10 });
    expect(second).toContain("// line 20");
    expect(second).not.toContain("already read");
  });

  it("does NOT dedup full-file request after a partial earlier read", async () => {
    const root = makeRoot();
    const lines = Array.from({ length: 50 }, (_, i) => `// line ${i + 1}`).join("\n");
    writeFileSync(join(root, "a.js"), lines);
    const registry: ReadRegistry = new Map();
    const tool = createReadTool({ projectRoot: root, registry, getStep: () => 1 });

    await tool.execute({ path: "a.js", offset: 1, limit: 10 });
    const full = await tool.execute({ path: "a.js" });
    expect(full).toContain("// line 1");
    expect(full).toContain("// line 50");
    expect(full).not.toContain("already read");
  });

  it("DOES dedup partial request that is fully covered by a prior full read", async () => {
    const root = makeRoot();
    const lines = Array.from({ length: 50 }, (_, i) => `// line ${i + 1}`).join("\n");
    writeFileSync(join(root, "a.js"), lines);
    const registry: ReadRegistry = new Map();
    const tool = createReadTool({ projectRoot: root, registry, getStep: () => 2 });

    await tool.execute({ path: "a.js" });
    const second = await tool.execute({ path: "a.js", offset: 5, limit: 5 });
    expect(second).toContain("already read");
  });

  it("does NOT dedup tiny files (under 200 bytes)", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.js"), "x");
    const registry: ReadRegistry = new Map();
    const tool = createReadTool({ projectRoot: root, registry, getStep: () => 1 });

    await tool.execute({ path: "a.js" });
    const second = await tool.execute({ path: "a.js" });
    expect(second).not.toContain("already read");
    expect(second).toContain("1\tx");
  });

  it("works without a registry (backwards compatible)", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.js"), "const v = 1;\n".repeat(20));
    const tool = createReadTool({ projectRoot: root });

    const out = await tool.execute({ path: "a.js" });
    expect(out).toContain("const v = 1");
  });

  it("merges disjoint partial reads in registry and dedups a fourth covered read", async () => {
    const root = makeRoot();
    const lines = Array.from({ length: 100 }, (_, i) => `// line ${i + 1}`).join("\n");
    writeFileSync(join(root, "a.js"), lines);
    const registry: ReadRegistry = new Map();
    const tool = createReadTool({ projectRoot: root, registry, getStep: () => 1 });

    await tool.execute({ path: "a.js", offset: 1, limit: 10 });   // [1,10]
    await tool.execute({ path: "a.js", offset: 30, limit: 10 });  // [30,39]
    await tool.execute({ path: "a.js", offset: 60, limit: 10 });  // [60,69]
    const fourth = await tool.execute({ path: "a.js", offset: 32, limit: 5 }); // [32,36] ⊆ [30,39]
    expect(fourth).toContain("already read");
    expect(fourth).toContain("1-10, 30-39, 60-69");
  });

  it("registry isolates state across instances (per-loop scope)", async () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.js"), "const v = 1;\n".repeat(20));

    const reg1: ReadRegistry = new Map();
    const tool1 = createReadTool({ projectRoot: root, registry: reg1, getStep: () => 1 });
    await tool1.execute({ path: "a.js" });

    const reg2: ReadRegistry = new Map();
    const tool2 = createReadTool({ projectRoot: root, registry: reg2, getStep: () => 1 });
    const second = await tool2.execute({ path: "a.js" });
    expect(second).not.toContain("already read");
  });
});
