import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const ENTRY = resolve(import.meta.dirname, "../src/index.ts");

// Clear all provider env vars so the second test always hits missing-required-config.
const cleanEnv = {
  ...process.env,
  OPENAI_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  GOOGLE_API_KEY: "",
  OPENROUTER_API_KEY: "",
  FPT_API_KEY: "",
  SAST_API_KEY: "",
  SAST_PROVIDER: "",
  SAST_MODEL: "",
  SAST_FINDINGS: "",
};

describe("CLI smoke", () => {
  it("--help exits 0 and prints usage", () => {
    const out = execSync(`bun run ${ENTRY} --help`, { encoding: "utf-8", env: cleanEnv });
    expect(out).toMatch(/Agentic SAST finding triage/i);
    expect(out).toMatch(/--provider/);
    expect(out).toMatch(/--output/);
  });

  it("missing required args exits non-zero with named field", () => {
    let exitCode = 0;
    let stderr = "";
    try {
      execSync(`bun run ${ENTRY}`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: cleanEnv,
      });
    } catch (err) {
      const e = err as { status: number; stderr: string };
      exitCode = e.status;
      stderr = e.stderr ?? "";
    }
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/Missing required config/);
    expect(stderr).toMatch(/--provider|SAST_PROVIDER/);
  });
});
