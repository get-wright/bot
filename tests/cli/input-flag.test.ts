import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveConfig } from "../../src/cli/config.js";
import { Command } from "commander";

const ENV_KEYS = ["SAST_FINDINGS"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("resolveConfig findingsPath precedence", () => {
  it("explicit findingsPath lands in config", () => {
    const cfg = resolveConfig({ findingsPath: "/abs/from-cli.json" });
    expect(cfg.findingsPath).toBe("/abs/from-cli.json");
  });

  it("SAST_FINDINGS used when neither flag nor positional supplied", () => {
    process.env.SAST_FINDINGS = "/abs/from-env.json";
    const cfg = resolveConfig({});
    expect(cfg.findingsPath).toBe("/abs/from-env.json");
  });

  it("explicit findingsPath beats SAST_FINDINGS", () => {
    process.env.SAST_FINDINGS = "/abs/from-env.json";
    const cfg = resolveConfig({ findingsPath: "/abs/from-cli.json" });
    expect(cfg.findingsPath).toBe("/abs/from-cli.json");
  });
});

describe("--input vs positional resolution in CLI", () => {
  // Contract-pin fixture: mirrors the resolution rule src/cli/cli.ts will
  // adopt in Task 3 (opts.input ?? findingsPath). Locks the behavior in
  // tests before the implementation lands.
  function captureFindingsPath(argv: string[]): string | undefined {
    let captured: string | undefined;
    const program = new Command();
    program
      .argument("[findings]")
      .option("--input <path>")
      .action((findingsPath: string | undefined, opts: any) => {
        captured = opts.input ?? findingsPath;
      });
    program.parse(argv, { from: "user" });
    return captured;
  }

  it("--input wins over positional when both supplied", () => {
    expect(captureFindingsPath(["pos.json", "--input", "flag.json"])).toBe("flag.json");
  });

  it("positional alone is used when --input absent", () => {
    expect(captureFindingsPath(["pos.json"])).toBe("pos.json");
  });

  it("--input alone is used when positional absent", () => {
    expect(captureFindingsPath(["--input", "flag.json"])).toBe("flag.json");
  });

  it("both absent yields undefined", () => {
    expect(captureFindingsPath([])).toBeUndefined();
  });
});
