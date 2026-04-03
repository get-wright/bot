# Feature Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 9 features to the TS rewrite: workspace permissions, reasoning effort, token usage, batch audit, re-audit, follow-up, provider switching.

**Architecture:** Extend the existing event-driven architecture. New event types flow through `onEvent`. Permission uses a deferred-promise pattern. Batch queue, re-audit, follow-up, and provider switching are TUI state. Reasoning effort maps to provider-specific `providerOptions` in AI SDK v5.

**Tech Stack:** AI SDK v5 (`streamText`, `providerOptions`, `totalUsage`), Ink 6 + React 19, Zod, smol-toml, vitest

---

### Task 1: Extend Event Types

**Files:**
- Modify: `sast-triage-ts/src/models/events.ts`

- [ ] **Step 1: Add new event types to AgentEvent union**

In `sast-triage-ts/src/models/events.ts`, replace the entire file:

```typescript
import type { TriageVerdict } from "./verdict.js";

export type PermissionDecision = "once" | "always" | "deny";

export type AgentEvent =
  | { type: "tool_start"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; summary: string; full: string }
  | { type: "thinking"; delta: string }
  | { type: "verdict"; verdict: TriageVerdict }
  | { type: "error"; message: string }
  | {
      type: "permission_request";
      path: string;
      directory: string;
      resolve: (decision: PermissionDecision) => void;
    }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      reasoningTokens?: number;
      cachedInputTokens?: number;
    }
  | { type: "followup_start"; question: string };
```

- [ ] **Step 2: Verify types compile**

Run: `cd sast-triage-ts && npx tsc --noEmit`
Expected: No new errors (existing code doesn't handle new event types yet — that's fine, switch statements will need `default` or be updated later).

- [ ] **Step 3: Commit**

```bash
cd sast-triage-ts && git add src/models/events.ts && git commit -m "feat: add permission_request, usage, followup_start event types"
```

---

### Task 2: Unified Reasoning Effort

**Files:**
- Create: `sast-triage-ts/src/provider/reasoning.ts`
- Test: `sast-triage-ts/tests/provider/reasoning.test.ts`

- [ ] **Step 1: Write the failing test**

Create `sast-triage-ts/tests/provider/reasoning.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveProviderOptions } from "../../src/provider/reasoning.js";

describe("resolveProviderOptions", () => {
  it("returns OpenAI reasoningEffort for openai provider", () => {
    const opts = resolveProviderOptions("openai", "medium");
    expect(opts).toEqual({ openai: { reasoningEffort: "medium" } });
  });

  it("returns OpenAI reasoningEffort for openrouter provider", () => {
    const opts = resolveProviderOptions("openrouter", "high");
    expect(opts).toEqual({ openai: { reasoningEffort: "high" } });
  });

  it("returns Anthropic thinking budget for anthropic provider", () => {
    const opts = resolveProviderOptions("anthropic", "low");
    expect(opts).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
    });
  });

  it("returns Anthropic thinking budget for medium effort", () => {
    const opts = resolveProviderOptions("anthropic", "medium");
    expect(opts).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 10000 } },
    });
  });

  it("returns Anthropic thinking budget for high effort", () => {
    const opts = resolveProviderOptions("anthropic", "high");
    expect(opts).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 32000 } },
    });
  });

  it("returns Google thinkingConfig for google provider", () => {
    const opts = resolveProviderOptions("google", "medium");
    expect(opts).toEqual({
      google: { thinkingConfig: { thinkingBudget: 10000 } },
    });
  });

  it("maps all effort levels correctly", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      const opts = resolveProviderOptions("openai", effort);
      expect(opts.openai.reasoningEffort).toBe(effort);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sast-triage-ts && npx vitest run tests/provider/reasoning.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement resolveProviderOptions**

Create `sast-triage-ts/src/provider/reasoning.ts`:

```typescript
export type ReasoningEffort = "low" | "medium" | "high";

const ANTHROPIC_BUDGETS: Record<ReasoningEffort, number> = {
  low: 4096,
  medium: 10000,
  high: 32000,
};

const GOOGLE_BUDGETS: Record<ReasoningEffort, number> = {
  low: 4096,
  medium: 10000,
  high: 32000,
};

export function resolveProviderOptions(
  provider: string,
  effort: ReasoningEffort,
): Record<string, Record<string, unknown>> {
  switch (provider) {
    case "openai":
    case "openrouter":
      return { openai: { reasoningEffort: effort } };
    case "anthropic":
      return {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: ANTHROPIC_BUDGETS[effort] },
        },
      };
    case "google":
      return {
        google: {
          thinkingConfig: { thinkingBudget: GOOGLE_BUDGETS[effort] },
        },
      };
    default:
      return {};
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd sast-triage-ts && npx vitest run tests/provider/reasoning.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
cd sast-triage-ts && git add src/provider/reasoning.ts tests/provider/reasoning.test.ts && git commit -m "feat: add unified reasoning effort to provider options mapping"
```

---

### Task 3: Workspace Permissions in Read Tool

**Files:**
- Modify: `sast-triage-ts/src/agent/tools/read.ts`
- Modify: `sast-triage-ts/tests/agent/tools/read.test.ts`

- [ ] **Step 1: Write failing tests for permission flow**

Append to `sast-triage-ts/tests/agent/tools/read.test.ts` inside the existing `describe("createReadTool")` block:

```typescript
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
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `cd sast-triage-ts && npx vitest run tests/agent/tools/read.test.ts`
Expected: New tests FAIL — `createReadTool` doesn't accept permission params

- [ ] **Step 3: Update createReadTool to accept permission callbacks**

Replace `sast-triage-ts/src/agent/tools/read.ts`:

```typescript
import { readFileSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import type { PermissionDecision } from "../../models/events.js";

const MAX_BYTES = 50 * 1024;
const DEFAULT_LIMIT = 200;

export interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface PermissionCallbacks {
  isPathAllowed: (absPath: string) => boolean;
  requestPermission: (absPath: string) => Promise<PermissionDecision>;
}

export interface ReadTool {
  execute(input: ReadToolInput): Promise<string>;
}

export function createReadTool(projectRoot: string, permissions?: PermissionCallbacks): ReadTool {
  const root = resolve(projectRoot);

  return {
    async execute({ path, offset = 1, limit = DEFAULT_LIMIT }: ReadToolInput): Promise<string> {
      const abs = resolve(root, path);
      const rel = relative(root, abs);
      const isOutside = rel.startsWith("..") || rel === abs;

      if (isOutside) {
        if (!permissions) {
          throw new Error(`Path outside project root: ${path}`);
        }

        if (!permissions.isPathAllowed(abs)) {
          const decision = await permissions.requestPermission(abs);
          if (decision === "deny") {
            throw new Error(`Access denied: ${path} — outside project root. User denied access.`);
          }
          // "once" and "always" both proceed — "always" handling is done by the caller
        }
      }

      let buf: Buffer;
      try {
        buf = readFileSync(abs);
      } catch {
        throw new Error(`File not found: ${path}`);
      }

      // Binary check: look for null bytes in first 8KB
      const probe = buf.subarray(0, 8192);
      if (probe.includes(0)) {
        throw new Error(`Binary file not supported: ${path}`);
      }

      const capped = buf.subarray(0, MAX_BYTES);
      const lines = capped.toString("utf8").split("\n");
      // Remove trailing empty element from trailing newline
      if (lines.at(-1) === "") lines.pop();

      const start = Math.max(1, offset);
      const slice = lines.slice(start - 1, start - 1 + limit);

      return slice.map((line, i) => `${start + i}\t${line}`).join("\n");
    },
  };
}
```

- [ ] **Step 4: Run all read tests**

Run: `cd sast-triage-ts && npx vitest run tests/agent/tools/read.test.ts`
Expected: All tests PASS (old tests still work since `permissions` is optional)

- [ ] **Step 5: Commit**

```bash
cd sast-triage-ts && git add src/agent/tools/read.ts tests/agent/tools/read.test.ts && git commit -m "feat: add interactive permission flow to read tool for out-of-root paths"
```

---

### Task 4: Wire Permissions Through Tools Index and Agent Loop

**Files:**
- Modify: `sast-triage-ts/src/agent/tools/index.ts`
- Modify: `sast-triage-ts/src/agent/loop.ts`
- Modify: `sast-triage-ts/src/config.ts`

- [ ] **Step 1: Update ToolConfig to accept permission callbacks**

In `sast-triage-ts/src/agent/tools/index.ts`, update `ToolConfig` and pass permissions to `createReadTool`:

Replace the `ToolConfig` interface and `createTools` function:

```typescript
import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { createReadTool, type PermissionCallbacks } from "./read.js";
import { createGrepTool } from "./grep.js";
import { createGlobTool } from "./glob.js";
import { createBashTool } from "./bash.js";
import { TriageVerdictSchema } from "../../models/verdict.js";

export interface ToolConfig {
  projectRoot: string;
  allowBash: boolean;
  permissions?: PermissionCallbacks;
}

export function createTools(config: ToolConfig): ToolSet {
  const readImpl = createReadTool(config.projectRoot, config.permissions);
  const grepImpl = createGrepTool(config.projectRoot);
  const globImpl = createGlobTool(config.projectRoot);
```

The rest of the function stays unchanged — `readImpl` already receives permissions via `createReadTool`.

- [ ] **Step 2: Update AgentLoopConfig and loop.ts**

In `sast-triage-ts/src/agent/loop.ts`:

Add imports at the top (after existing imports):

```typescript
import type { PermissionDecision } from "../models/events.js";
import { resolveProviderOptions, type ReasoningEffort } from "../provider/reasoning.js";
import { dirname } from "node:path";
```

Update `AgentLoopConfig`:

```typescript
export interface AgentLoopConfig {
  finding: Finding;
  projectRoot: string;
  provider: string;
  model: string;
  maxSteps: number;
  allowBash: boolean;
  onEvent: (event: AgentEvent) => void;
  memoryHints: string[];
  apiKey?: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
  allowedPaths?: string[];
}
```

In `runAgentLoop`, before the `streamText` call, add permission handling and a session-approved set:

```typescript
  const sessionApproved = new Set<string>(config.allowedPaths ?? []);

  const isPathAllowed = (absPath: string): boolean => {
    return [...sessionApproved].some(
      (dir) => absPath === dir || absPath.startsWith(dir.endsWith("/") ? dir : dir + "/"),
    );
  };

  const requestPermission = (absPath: string): Promise<PermissionDecision> => {
    return new Promise<PermissionDecision>((resolvePromise) => {
      const dir = dirname(absPath);
      onEvent({
        type: "permission_request",
        path: absPath,
        directory: dir,
        resolve: (decision) => {
          if (decision === "always") {
            sessionApproved.add(dir);
          }
          resolvePromise(decision);
        },
      });
    });
  };

  const tools = createTools({ projectRoot, allowBash, permissions: { isPathAllowed, requestPermission } });
```

Remove the old `const tools = createTools(...)` line.

In the `streamText()` call, add `providerOptions`:

```typescript
  const providerOptions = config.reasoningEffort
    ? resolveProviderOptions(config.provider, config.reasoningEffort)
    : undefined;

  const result = streamText({
    model: languageModel,
    system: systemPromptParts.join("\n\n"),
    messages: [{ role: "user", content: userMessage }],
    tools,
    stopWhen: stepCountIs(maxSteps),
    providerOptions,
    // ... existing onChunk and onStepFinish callbacks
```

After `await result.text` (after the try/catch block), add usage emission:

```typescript
  // Emit token usage
  try {
    const totalUsage = await result.totalUsage;
    onEvent({
      type: "usage",
      inputTokens: totalUsage.inputTokens ?? 0,
      outputTokens: totalUsage.outputTokens ?? 0,
      totalTokens: totalUsage.totalTokens ?? 0,
      reasoningTokens: (totalUsage as Record<string, unknown>).reasoningTokens as number | undefined,
      cachedInputTokens: (totalUsage as Record<string, unknown>).cachedInputTokens as number | undefined,
    });
  } catch {
    // Usage not available — ignore
  }
```

- [ ] **Step 3: Update AppConfig**

In `sast-triage-ts/src/config.ts`, add `reasoningEffort` and `allowedPaths`:

```typescript
import type { ReasoningEffort } from "./provider/reasoning.js";

export interface AppConfig {
  findingsPath: string;
  provider: string;
  model: string;
  headless: boolean;
  allowBash: boolean;
  maxSteps: number;
  memoryDb: string;
  apiKey?: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
  allowedPaths?: string[];
}
```

No change to `resolveConfig` — the new fields are optional.

- [ ] **Step 4: Run type check and all tests**

Run: `cd sast-triage-ts && npx tsc --noEmit && npx vitest run`
Expected: Type check passes. All existing tests pass.

- [ ] **Step 5: Commit**

```bash
cd sast-triage-ts && git add src/agent/tools/index.ts src/agent/loop.ts src/config.ts && git commit -m "feat: wire permissions, reasoning effort, and token usage through agent loop"
```

---

### Task 5: ProjectConfig + CLI Updates

**Files:**
- Modify: `sast-triage-ts/src/config/project-config.ts`
- Modify: `sast-triage-ts/src/index.ts`
- Modify: `sast-triage-ts/tests/config/project-config.test.ts`

- [ ] **Step 1: Write failing test for new config fields**

Append to `sast-triage-ts/tests/config/project-config.test.ts` inside the existing `describe("ProjectConfig")`:

```typescript
  it("loads and saves reasoning_effort", () => {
    writeFileSync(
      join(workspace, ".sast-triage.toml"),
      [
        "[provider]",
        'name = "openai"',
        'model = "o3-mini"',
        'reasoning_effort = "high"',
      ].join("\n"),
    );
    const cfg = new ProjectConfig(workspace);
    expect(cfg.reasoningEffort).toBe("high");

    cfg.reasoningEffort = "low";
    cfg.save();

    const cfg2 = new ProjectConfig(workspace);
    expect(cfg2.reasoningEffort).toBe("low");
  });

  it("loads and saves allowed_paths", () => {
    writeFileSync(
      join(workspace, ".sast-triage.toml"),
      [
        "[provider]",
        'name = "openai"',
        'model = "gpt-4o"',
        "",
        "[workspace]",
        'allowed_paths = ["/tmp/extra", "/opt/lib"]',
      ].join("\n"),
    );
    const cfg = new ProjectConfig(workspace);
    expect(cfg.allowedPaths).toEqual(["/tmp/extra", "/opt/lib"]);

    cfg.allowedPaths = ["/new/path"];
    cfg.save();

    const cfg2 = new ProjectConfig(workspace);
    expect(cfg2.allowedPaths).toEqual(["/new/path"]);
  });

  it("defaults reasoning_effort to undefined and allowed_paths to empty", () => {
    const cfg = new ProjectConfig(workspace);
    expect(cfg.reasoningEffort).toBeUndefined();
    expect(cfg.allowedPaths).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd sast-triage-ts && npx vitest run tests/config/project-config.test.ts`
Expected: FAIL — properties don't exist

- [ ] **Step 3: Update ProjectConfig**

In `sast-triage-ts/src/config/project-config.ts`:

Add import for `ReasoningEffort`:

```typescript
import type { ReasoningEffort } from "../provider/reasoning.js";
```

Add fields to the class (after `memoryDbPath`):

```typescript
  reasoningEffort: ReasoningEffort | undefined;
  allowedPaths: string[] = [];
```

In the `load()` method, after the `provider` block (after line 61 `}`):

```typescript
      if (typeof provider.reasoning_effort === "string") {
        const effort = provider.reasoning_effort;
        if (effort === "low" || effort === "medium" || effort === "high") {
          this.reasoningEffort = effort;
        }
      }
```

After the `memory` block (after line 67 `}`), add:

```typescript
    const workspace = data.workspace as Record<string, unknown> | undefined;
    if (workspace && Array.isArray(workspace.allowed_paths)) {
      this.allowedPaths = workspace.allowed_paths.filter(
        (p): p is string => typeof p === "string",
      );
    }
```

In the `save()` method, update the data object:

```typescript
  save(): void {
    const data: Record<string, unknown> = {
      provider: {
        name: this.provider,
        model: this.model,
        ...(this.apiKey ? { api_keys: { [this.provider]: this.apiKey } } : {}),
        ...(this.baseUrl ? { base_url: this.baseUrl } : {}),
        ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
      },
      memory: {
        db_path: ".sast-triage/memory.db",
      },
      ...(this.allowedPaths.length > 0
        ? { workspace: { allowed_paths: this.allowedPaths } }
        : {}),
    };
    writeFileSync(this.tomlPath, stringify(data) + "\n");
  }
```

- [ ] **Step 4: Run config tests**

Run: `cd sast-triage-ts && npx vitest run tests/config/project-config.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Add --effort CLI flag**

In `sast-triage-ts/src/index.ts`, add the option after `--memory-db`:

```typescript
  .option("--effort <level>", "Reasoning effort: low, medium, high")
```

In the `.action()` callback, pass it through to `resolveConfig`:

```typescript
    const config = resolveConfig({
      findingsPath,
      provider: opts.provider,
      model: opts.model,
      headless: opts.headless,
      allowBash: opts.allowBash,
      maxSteps: parseInt(opts.maxSteps, 10),
      memoryDb: opts.memoryDb,
    });

    // Apply reasoning effort if provided
    if (opts.effort) {
      (config as Record<string, unknown>).reasoningEffort = opts.effort;
    }
```

In the headless `runAgentLoop` call (around line 113), add:

```typescript
      reasoningEffort: config.reasoningEffort,
      allowedPaths: projectConfig.allowedPaths,
```

- [ ] **Step 6: Run full test suite**

Run: `cd sast-triage-ts && npx tsc --noEmit && npx vitest run`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
cd sast-triage-ts && git add src/config/project-config.ts src/index.ts tests/config/project-config.test.ts && git commit -m "feat: add reasoning_effort and allowed_paths to config and CLI"
```

---

### Task 6: Follow-up Conversation

**Files:**
- Create: `sast-triage-ts/src/agent/follow-up.ts`
- Test: `sast-triage-ts/tests/agent/follow-up.test.ts`

- [ ] **Step 1: Write failing test**

Create `sast-triage-ts/tests/agent/follow-up.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildFollowUpMessages } from "../../src/agent/follow-up.js";
import { FindingSchema } from "../../src/models/finding.js";
import type { TriageVerdict } from "../../src/models/verdict.js";

const TEST_FINDING = FindingSchema.parse({
  check_id: "test.rule",
  path: "src/app.py",
  start: { line: 10, col: 1 },
  end: { line: 10, col: 20 },
  extra: {
    message: "Test finding",
    severity: "ERROR",
    metadata: { cwe: ["CWE-89"], confidence: "HIGH", category: "security" },
    lines: "cursor.execute(sql)",
    metavars: {},
  },
});

const TEST_VERDICT: TriageVerdict = {
  verdict: "false_positive",
  reasoning: "The SQL query uses parameterized inputs.",
  key_evidence: ["Line 10 uses parameterized query"],
};

describe("buildFollowUpMessages", () => {
  it("builds messages with finding context, verdict, and user question", () => {
    const messages = buildFollowUpMessages(TEST_FINDING, TEST_VERDICT, "Why is this safe?");
    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toContain("test.rule");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toContain("false_positive");
    expect(messages[1]!.content).toContain("parameterized inputs");
    expect(messages[2]!.role).toBe("user");
    expect(messages[2]!.content).toBe("Why is this safe?");
  });

  it("accumulates prior follow-ups", () => {
    const priorExchanges = [
      { question: "Is the input validated?", answer: "Yes, via Pydantic model." },
    ];
    const messages = buildFollowUpMessages(
      TEST_FINDING,
      TEST_VERDICT,
      "What about edge cases?",
      priorExchanges,
    );
    expect(messages).toHaveLength(5);
    expect(messages[2]!.role).toBe("user");
    expect(messages[2]!.content).toBe("Is the input validated?");
    expect(messages[3]!.role).toBe("assistant");
    expect(messages[3]!.content).toBe("Yes, via Pydantic model.");
    expect(messages[4]!.role).toBe("user");
    expect(messages[4]!.content).toBe("What about edge cases?");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sast-triage-ts && npx vitest run tests/agent/follow-up.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement follow-up module**

Create `sast-triage-ts/src/agent/follow-up.ts`:

```typescript
import { streamText } from "ai";
import type { Finding } from "../models/finding.js";
import type { TriageVerdict } from "../models/verdict.js";
import type { AgentEvent } from "../models/events.js";
import { formatFindingMessage } from "./system-prompt.js";
import { resolveProvider } from "../provider/registry.js";
import { resolveProviderOptions, type ReasoningEffort } from "../provider/reasoning.js";

const FOLLOWUP_SYSTEM = `You are an expert application security engineer in a follow-up discussion about a SAST finding you previously triaged. Answer the user's question based on the finding context and your previous analysis. Be specific, cite line numbers and code when relevant. Do not output JSON — this is a conversation.`;

export interface FollowUpExchange {
  question: string;
  answer: string;
}

export function buildFollowUpMessages(
  finding: Finding,
  previousVerdict: TriageVerdict,
  question: string,
  priorExchanges: FollowUpExchange[] = [],
): { role: "user" | "assistant"; content: string }[] {
  const messages: { role: "user" | "assistant"; content: string }[] = [];

  // Original finding context
  messages.push({ role: "user", content: formatFindingMessage(finding) });

  // Previous verdict as assistant response
  const verdictSummary = [
    `Verdict: ${previousVerdict.verdict}`,
    `Reasoning: ${previousVerdict.reasoning}`,
    previousVerdict.key_evidence.length > 0
      ? `Evidence:\n${previousVerdict.key_evidence.map((e) => `- ${e}`).join("\n")}`
      : "",
    previousVerdict.suggested_fix ? `Suggested fix: ${previousVerdict.suggested_fix}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  messages.push({ role: "assistant", content: verdictSummary });

  // Prior follow-up exchanges
  for (const exchange of priorExchanges) {
    messages.push({ role: "user", content: exchange.question });
    messages.push({ role: "assistant", content: exchange.answer });
  }

  // Current question
  messages.push({ role: "user", content: question });

  return messages;
}

export interface FollowUpConfig {
  finding: Finding;
  previousVerdict: TriageVerdict;
  question: string;
  priorExchanges?: FollowUpExchange[];
  provider: string;
  model: string;
  onEvent: (event: AgentEvent) => void;
  apiKey?: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
}

export async function runFollowUp(config: FollowUpConfig): Promise<string> {
  const {
    finding,
    previousVerdict,
    question,
    priorExchanges = [],
    provider,
    model: modelId,
    onEvent,
  } = config;

  config.onEvent({ type: "followup_start", question });

  const languageModel = resolveProvider(provider, modelId, config.apiKey, config.baseUrl);
  const messages = buildFollowUpMessages(finding, previousVerdict, question, priorExchanges);

  const providerOptions = config.reasoningEffort
    ? resolveProviderOptions(provider, config.reasoningEffort)
    : undefined;

  let fullText = "";

  const result = streamText({
    model: languageModel,
    system: FOLLOWUP_SYSTEM,
    messages,
    providerOptions,
    onChunk({ chunk }) {
      if (chunk.type === "text-delta") {
        onEvent({ type: "thinking", delta: chunk.text });
        fullText += chunk.text;
      }
    },
  });

  try {
    await result.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent({ type: "error", message: `Follow-up error: ${message}` });
  }

  return fullText;
}
```

- [ ] **Step 4: Run tests**

Run: `cd sast-triage-ts && npx vitest run tests/agent/follow-up.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd sast-triage-ts && git add src/agent/follow-up.ts tests/agent/follow-up.test.ts && git commit -m "feat: add follow-up conversation module with message builder"
```

---

### Task 7: Headless Reporter Updates

**Files:**
- Modify: `sast-triage-ts/src/headless/reporter.ts`

- [ ] **Step 1: Update reporter to handle new event types**

The `permission_request` event contains a `resolve` callback which can't be serialized. In headless mode, permission is auto-resolved from config — so the reporter should skip it. The `usage` and `followup_start` events serialize normally.

Replace `sast-triage-ts/src/headless/reporter.ts`:

```typescript
import type { AgentEvent } from "../models/events.js";

export function formatEvent(event: AgentEvent, fingerprint: string): string {
  // permission_request has a non-serializable resolve callback — skip it in NDJSON
  if (event.type === "permission_request") {
    return JSON.stringify({
      type: "permission_request",
      path: event.path,
      directory: event.directory,
      fingerprint,
    });
  }
  return JSON.stringify({ ...event, fingerprint });
}
```

- [ ] **Step 2: Run full test suite**

Run: `cd sast-triage-ts && npx tsc --noEmit && npx vitest run`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
cd sast-triage-ts && git add src/headless/reporter.ts && git commit -m "feat: handle new event types in headless NDJSON reporter"
```

---

### Task 8: FindingsTable Multi-Select

**Files:**
- Modify: `sast-triage-ts/src/ui/components/findings-table.tsx`

- [ ] **Step 1: Add selection state and visual indicators**

Replace `sast-triage-ts/src/ui/components/findings-table.tsx`:

```typescript
import React from "react";
import { Box, Text } from "ink";

export type FindingStatus = "pending" | "in_progress" | "true_positive" | "false_positive" | "needs_review";

export interface FindingEntry {
  fingerprint: string;
  ruleId: string;
  fileLine: string;
  severity: string;
  status: FindingStatus;
}

const STATUS_COLORS: Record<FindingStatus, string> = {
  pending: "gray",
  in_progress: "yellow",
  true_positive: "red",
  false_positive: "green",
  needs_review: "#FF8C00",
};

const STATUS_ICONS: Record<FindingStatus, string> = {
  pending: " ",
  in_progress: "~",
  true_positive: "!",
  false_positive: ".",
  needs_review: "?",
};

export function FindingsTable({
  findings,
  selectedIndex,
  triaged,
  selectedIndices,
}: {
  findings: FindingEntry[];
  selectedIndex: number;
  triaged: number;
  selectedIndices?: Set<number>;
}) {
  const sel = selectedIndices ?? new Set<number>();
  return (
    <Box flexDirection="column" width="100%">
      <Box marginBottom={1}>
        <Text bold>
          Findings {triaged}/{findings.length}
          {sel.size > 0 ? ` (${sel.size} selected)` : ""}
        </Text>
      </Box>
      {findings.map((f, i) => {
        const highlighted = i === selectedIndex;
        const color = STATUS_COLORS[f.status];
        const icon = STATUS_ICONS[f.status];
        const ruleShort = f.ruleId.split(".").pop() ?? f.ruleId;
        const mark = sel.has(i) ? "●" : " ";
        return (
          <Box key={f.fingerprint}>
            <Text color={color}>
              {highlighted ? ">" : " "}{mark} {icon} {ruleShort.slice(0, 20).padEnd(20)} {f.fileLine}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd sast-triage-ts && npx tsc --noEmit`
Expected: Pass (the `selectedIndices` prop is optional with a default)

- [ ] **Step 3: Commit**

```bash
cd sast-triage-ts && git add src/ui/components/findings-table.tsx && git commit -m "feat: add multi-select indicators to findings table"
```

---

### Task 9: Sidebar Enhancements

**Files:**
- Modify: `sast-triage-ts/src/ui/components/sidebar.tsx`

- [ ] **Step 1: Add queue progress and token usage to sidebar**

Replace `sast-triage-ts/src/ui/components/sidebar.tsx`:

```typescript
import React from "react";
import { Box, Text } from "ink";

export interface QueueItem {
  label: string;
  status: "pending" | "done" | "active";
  verdict?: string;
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function Sidebar({
  total,
  active,
  filtered,
  triaged,
  tp,
  fp,
  nr,
  provider,
  model,
  queue,
  sessionUsage,
  currentUsage,
}: {
  total: number;
  active: number;
  filtered: number;
  triaged: number;
  tp: number;
  fp: number;
  nr: number;
  provider: string;
  model: string;
  queue?: QueueItem[];
  sessionUsage?: UsageStats;
  currentUsage?: UsageStats;
}) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Stats</Text>
      <Text>Total: {total}</Text>
      <Text>Active: {active}</Text>
      <Text>Filtered: {filtered}</Text>
      <Text>Done: {triaged}</Text>
      <Text> </Text>
      <Text color="red">TP: {tp}</Text>
      <Text color="green">FP: {fp}</Text>
      <Text color="#FF8C00">NR: {nr}</Text>
      <Text> </Text>
      <Text bold>Model</Text>
      <Text dimColor>{provider}</Text>
      <Text dimColor>{model}</Text>
      {queue && queue.length > 0 && (
        <>
          <Text> </Text>
          <Text bold>
            Queue: {queue.filter((q) => q.status === "done").length}/{queue.length}
          </Text>
          {queue.map((item, i) => {
            const icon = item.status === "done" ? "✓" : item.status === "active" ? "▸" : " ";
            const verdictLabel = item.verdict
              ? item.verdict === "true_positive"
                ? "TP"
                : item.verdict === "false_positive"
                  ? "FP"
                  : "NR"
              : "";
            const verdictColor =
              item.verdict === "true_positive"
                ? "red"
                : item.verdict === "false_positive"
                  ? "green"
                  : item.verdict === "needs_review"
                    ? "#FF8C00"
                    : undefined;
            return (
              <Text key={i} dimColor={item.status === "pending"}>
                {"  "}{icon} {item.label.slice(0, 16)}
                {verdictLabel ? <Text color={verdictColor}> {verdictLabel}</Text> : ""}
              </Text>
            );
          })}
        </>
      )}
      {currentUsage && (
        <>
          <Text> </Text>
          <Text bold>Tokens</Text>
          <Text dimColor>
            {formatTokens(currentUsage.inputTokens)} in / {formatTokens(currentUsage.outputTokens)} out
          </Text>
        </>
      )}
      {sessionUsage && sessionUsage.totalTokens > 0 && (
        <Text dimColor>
          Session: {formatTokens(sessionUsage.totalTokens)}
        </Text>
      )}
      <Text> </Text>
      <Text dimColor>q: quit</Text>
      <Text dimColor>Enter: triage</Text>
      <Text dimColor>Space: select</Text>
      <Text dimColor>a: select all</Text>
      <Text dimColor>Tab: switch view</Text>
      <Text dimColor>r: re-audit</Text>
      <Text dimColor>f: follow-up</Text>
      <Text dimColor>^P: provider</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd sast-triage-ts && npx tsc --noEmit`
Expected: Pass (will warn about unused new props in app.tsx — that's fine, we wire them in the next task)

- [ ] **Step 3: Commit**

```bash
cd sast-triage-ts && git add src/ui/components/sidebar.tsx && git commit -m "feat: add queue progress and token usage to sidebar"
```

---

### Task 10: Agent Panel Enhancements

**Files:**
- Modify: `sast-triage-ts/src/ui/components/agent-panel.tsx`

- [ ] **Step 1: Add rendering for new event types + follow-up input**

In `sast-triage-ts/src/ui/components/agent-panel.tsx`:

Add imports:

```typescript
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
```

Replace the existing `import React from "react";` and `import { Box, Text } from "ink";`.

Add `onFollowUp` and `showFollowUpInput` props to `AgentPanel`:

```typescript
export function AgentPanel({
  events,
  isActive,
  width,
  showFollowUpInput,
  onFollowUp,
  onPermissionResolve,
}: {
  events: AgentEvent[];
  isActive: boolean;
  width: number;
  showFollowUpInput?: boolean;
  onFollowUp?: (question: string) => void;
  onPermissionResolve?: (decision: "once" | "always" | "deny") => void;
}) {
```

Add follow-up input state inside the component:

```typescript
  const [followUpText, setFollowUpText] = useState("");
```

Before the closing `</Box>`, add permission prompt + follow-up input + usage rendering:

```typescript
      {/* Permission prompt — show the last pending permission_request */}
      {(() => {
        const permEvent = events.findLast((e) => e.type === "permission_request");
        if (permEvent && permEvent.type === "permission_request" && onPermissionResolve) {
          return (
            <Box flexDirection="column" marginTop={1} paddingX={2}>
              <Text color="yellow" bold>Permission required</Text>
              <Text>Read file outside project root:</Text>
              <Text dimColor>{permEvent.path}</Text>
              <Text> </Text>
              <Text>
                <Text color="green" bold>[a]</Text> Allow once{"  "}
                <Text color="cyan" bold>[d]</Text> Allow dir always{"  "}
                <Text color="red" bold>[x]</Text> Deny
              </Text>
            </Box>
          );
        }
        return null;
      })()}
      {showFollowUpInput && onFollowUp && (
        <Box marginTop={1} paddingX={2}>
          <Text bold color="cyan">&gt; </Text>
          <TextInput
            value={followUpText}
            onChange={setFollowUpText}
            onSubmit={(value) => {
              if (value.trim()) {
                onFollowUp(value.trim());
                setFollowUpText("");
              }
            }}
            placeholder="Ask a follow-up question..."
          />
        </Box>
      )}
```

Update `EventLine` to handle new types:

```typescript
function EventLine({ event, maxWidth }: { event: AgentEvent; maxWidth: number }) {
  switch (event.type) {
    case "tool_start":
      return <Text color="cyan">{clip(`  * ${formatToolStart(event.tool, event.args)}`, maxWidth)}</Text>;
    case "tool_result": {
      const lines = event.summary.split("\n");
      return (
        <>
          {lines.map((line, i) => {
            const prefix = i === 0 ? "    -> " : "       ";
            return <Text key={i} dimColor>{clip(`${prefix}${line}`, maxWidth)}</Text>;
          })}
        </>
      );
    }
    case "thinking":
      return <Text wrap="wrap">{event.delta}</Text>;
    case "verdict":
      return <VerdictBanner verdict={event.verdict} />;
    case "error":
      return <Text color="red">{clip(`  ! ${event.message}`, maxWidth)}</Text>;
    case "usage":
      return (
        <Text dimColor>
          {clip(`  Tokens: ${formatTokenCount(event.inputTokens)} in / ${formatTokenCount(event.outputTokens)} out`, maxWidth)}
        </Text>
      );
    case "followup_start":
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>{clip(`  > ${event.question}`, maxWidth)}</Text>
        </Box>
      );
    case "permission_request":
      return null; // Rendered separately as interactive prompt
  }
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd sast-triage-ts && npx tsc --noEmit`
Expected: Pass

- [ ] **Step 3: Commit**

```bash
cd sast-triage-ts && git add src/ui/components/agent-panel.tsx && git commit -m "feat: add permission prompt, follow-up input, and usage display to agent panel"
```

---

### Task 11: Setup Screen — Reasoning Effort Step + Partial Re-entry

**Files:**
- Modify: `sast-triage-ts/src/ui/components/setup-screen.tsx`

- [ ] **Step 1: Add reasoning effort step and startStep prop**

In `sast-triage-ts/src/ui/components/setup-screen.tsx`:

Add `reasoningEffort` to `SetupResult`:

```typescript
export interface SetupResult {
  provider: string;
  model: string;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  findingsPath: string;
  reasoningEffort: string | undefined;
}
```

Update step order to include `"effort"` after `"model"`:

```typescript
type SetupStep = "trust" | "provider" | "apikey" | "baseurl" | "model" | "effort" | "file";
const STEP_ORDER: SetupStep[] = ["trust", "provider", "apikey", "baseurl", "model", "effort", "file"];
```

Add `startStep` prop for partial re-entry:

```typescript
export function SetupScreen({
  cwd,
  projectConfig,
  onComplete,
  startStep: startStepProp,
}: {
  cwd: string;
  projectConfig: ProjectConfig;
  onComplete: (result: SetupResult) => void;
  startStep?: SetupStep;
}) {
  const saved = projectConfig.hasConfig();
  const [step, setStep] = useState<SetupStep>(
    startStepProp ?? (saved ? "file" : "trust"),
  );
```

Add effort state:

```typescript
  const [effortIndex, setEffortIndex] = useState(() => {
    const efforts = ["low", "medium", "high"];
    const idx = efforts.indexOf(projectConfig.reasoningEffort ?? "");
    return idx >= 0 ? idx : -1; // -1 = none/skip
  });
```

Update the `model` step's `onSubmit` to advance to `"effort"` instead of `"file"`:

In the model TextInput `onSubmit`, change `setStep("file")` to `setStep("effort")`.

Add the effort step UI before the file step return:

```typescript
  // --- Reasoning Effort ---
  if (step === "effort") {
    const efforts = ["low", "medium", "high"];
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Reasoning Effort</Text>
        <Text dimColor>Controls thinking budget for reasoning models. Skip if not using reasoning models.</Text>
        <Text> </Text>
        {efforts.map((e, i) => {
          const sel = i === effortIndex;
          return (
            <Text key={e}>
              <Text color={sel ? "cyan" : undefined} bold={sel}>
                {" "}{sel ? ">" : " "} {e}
              </Text>
            </Text>
          );
        })}
        <Text>
          <Text color={effortIndex === -1 ? "cyan" : undefined} bold={effortIndex === -1}>
            {" "}{effortIndex === -1 ? ">" : " "} skip (use provider default)
          </Text>
        </Text>
        <Text> </Text>
        <Text dimColor>↑/↓ select · Enter confirm · Esc back</Text>
      </Box>
    );
  }
```

Add input handling for the effort step in the `useInput` callback — inside the existing `useInput`, add after the provider block:

```typescript
    if (step === "effort") {
      const totalOptions = 4; // low, medium, high, skip(-1)
      if (key.upArrow) {
        setEffortIndex((prev) => (prev <= -1 ? 2 : prev - 1));
      }
      if (key.downArrow) {
        setEffortIndex((prev) => (prev >= 2 ? -1 : prev + 1));
      }
      if (key.return) {
        setStep("file");
      }
    }
```

In the file step's `onSubmit` callback, include `reasoningEffort` in the result:

```typescript
            const efforts = ["low", "medium", "high"];
            const effort = effortIndex >= 0 ? efforts[effortIndex] : undefined;

            onComplete({
              provider: selectedProvider,
              model: modelInput,
              apiKey: apiKeyInput || projectConfig.resolvedApiKey(),
              baseUrl: baseUrlInput || undefined,
              findingsPath: value || "findings.json",
              reasoningEffort: effort,
            });
```

Also update the auto-complete `useEffect` to include `reasoningEffort`:

```typescript
      onComplete({
        provider: projectConfig.provider,
        model: projectConfig.model,
        apiKey: projectConfig.resolvedApiKey(),
        baseUrl: projectConfig.baseUrl,
        findingsPath: "findings.json",
        reasoningEffort: projectConfig.reasoningEffort,
      });
```

And update the `save()` call to include reasoningEffort:

```typescript
            projectConfig.reasoningEffort = effort as any;
```

- [ ] **Step 2: Verify types compile**

Run: `cd sast-triage-ts && npx tsc --noEmit`
Expected: Pass

- [ ] **Step 3: Commit**

```bash
cd sast-triage-ts && git add src/ui/components/setup-screen.tsx && git commit -m "feat: add reasoning effort step and partial re-entry to setup screen"
```

---

### Task 12: Main App — Batch Queue, Re-audit, Follow-up, Provider Switch, Permissions

This is the largest task — wiring everything together in `app.tsx`.

**Files:**
- Modify: `sast-triage-ts/src/ui/app.tsx`

- [ ] **Step 1: Add imports and state types**

At the top of `sast-triage-ts/src/ui/app.tsx`, update imports:

```typescript
import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { withFullScreen } from "fullscreen-ink";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Finding } from "../models/finding.js";
import type { AppConfig } from "../config.js";
import type { MemoryStore } from "../memory/store.js";
import type { AgentEvent, PermissionDecision } from "../models/events.js";
import type { TriageVerdict } from "../models/verdict.js";
import { parseSemgrepOutput, fingerprintFinding } from "../parser/semgrep.js";
import { prefilterFinding } from "../parser/prefilter.js";
import { runAgentLoop } from "../agent/loop.js";
import { runFollowUp, type FollowUpExchange } from "../agent/follow-up.js";
import { FindingsTable, type FindingEntry, type FindingStatus } from "./components/findings-table.js";
import { AgentPanel } from "./components/agent-panel.js";
import { Sidebar, type QueueItem, type UsageStats } from "./components/sidebar.js";
import { SetupScreen, type SetupResult } from "./components/setup-screen.js";
import { ProjectConfig } from "../config/project-config.js";
```

- [ ] **Step 2: Add state for batch queue, selection, usage, follow-ups**

In `MainScreen`, add state after `isTriaging`:

```typescript
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [queueState, setQueueState] = useState<{
    items: number[];
    currentIndex: number;
    isRunning: boolean;
  } | null>(null);
  const [sessionUsage, setSessionUsage] = useState<UsageStats>({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  const [currentUsage, setCurrentUsage] = useState<UsageStats | undefined>();
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [followUpExchanges, setFollowUpExchanges] = useState<Map<number, FollowUpExchange[]>>(new Map());
  const stopQueueRef = useRef(false);
  const pendingPermissionRef = useRef<((decision: PermissionDecision) => void) | null>(null);
```

- [ ] **Step 3: Rewrite triageCurrent to support batch queue**

Replace the `triageCurrent` callback with `triageIndex` and `startBatchQueue`:

```typescript
  const triageIndex = useCallback(
    async (idx: number) => {
      const state = findingStates[idx];
      if (!state || state.verdict) return;

      setFindingStates((prev) =>
        prev.map((s, i) =>
          i === idx
            ? { ...s, entry: { ...s.entry, status: "in_progress" as FindingStatus }, events: [] }
            : s,
        ),
      );
      setCurrentUsage(undefined);
      setSelectedIndex(idx);

      const fp = state.entry.fingerprint;
      const memoryHints = memory.getHints(state.finding.check_id, fp);

      const verdict = await runAgentLoop({
        finding: state.finding,
        projectRoot: process.cwd(),
        provider: config.provider,
        model: config.model,
        maxSteps: config.maxSteps,
        allowBash: config.allowBash,
        onEvent: (event) => {
          if (event.type === "usage") {
            const usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens };
            setCurrentUsage(usage);
            setSessionUsage((prev) => ({
              inputTokens: prev.inputTokens + event.inputTokens,
              outputTokens: prev.outputTokens + event.outputTokens,
              totalTokens: prev.totalTokens + event.totalTokens,
            }));
          }
          if (event.type === "permission_request") {
            pendingPermissionRef.current = event.resolve;
          }
          setFindingStates((prev) =>
            prev.map((s, i) => (i === idx ? { ...s, events: [...s.events, event] } : s)),
          );
        },
        memoryHints,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        reasoningEffort: config.reasoningEffort,
        allowedPaths: config.allowedPaths,
      });

      memory.store({
        fingerprint: fp,
        check_id: state.finding.check_id,
        path: state.finding.path,
        verdict: verdict.verdict,
        reasoning: verdict.reasoning,
      });

      setFindingStates((prev) =>
        prev.map((s, i) =>
          i === idx
            ? { ...s, verdict, entry: { ...s.entry, status: verdict.verdict as FindingStatus } }
            : s,
        ),
      );
      pendingPermissionRef.current = null;

      return verdict;
    },
    [findingStates, config, memory],
  );

  const startBatchQueue = useCallback(
    async (indices: number[]) => {
      if (isTriaging || indices.length === 0) return;
      setIsTriaging(true);
      stopQueueRef.current = false;

      setQueueState({ items: indices, currentIndex: 0, isRunning: true });

      for (let qi = 0; qi < indices.length; qi++) {
        if (stopQueueRef.current) break;
        setQueueState({ items: indices, currentIndex: qi, isRunning: true });
        await triageIndex(indices[qi]!);
      }

      setQueueState(null);
      setIsTriaging(false);
      setSelectedIndices(new Set());
    },
    [isTriaging, triageIndex],
  );
```

- [ ] **Step 4: Add re-audit handler**

```typescript
  const reauditCurrent = useCallback(async () => {
    if (isTriaging) return;
    const state = findingStates[selectedIndex];
    if (!state || !state.verdict) return;

    // Clear verdict and events
    setFindingStates((prev) =>
      prev.map((s, i) =>
        i === selectedIndex
          ? { ...s, verdict: undefined, events: [], entry: { ...s.entry, status: "pending" as FindingStatus } }
          : s,
      ),
    );
    setFollowUpExchanges((prev) => {
      const next = new Map(prev);
      next.delete(selectedIndex);
      return next;
    });

    setIsTriaging(true);
    await triageIndex(selectedIndex);
    setIsTriaging(false);
  }, [selectedIndex, findingStates, isTriaging, triageIndex]);
```

- [ ] **Step 5: Add follow-up handler**

```typescript
  const handleFollowUp = useCallback(
    async (question: string) => {
      const state = findingStates[selectedIndex];
      if (!state?.verdict) return;

      setShowFollowUp(false);
      setIsTriaging(true);

      const priorExchanges = followUpExchanges.get(selectedIndex) ?? [];

      const answer = await runFollowUp({
        finding: state.finding,
        previousVerdict: state.verdict,
        question,
        priorExchanges,
        provider: config.provider,
        model: config.model,
        onEvent: (event) => {
          setFindingStates((prev) =>
            prev.map((s, i) =>
              i === selectedIndex ? { ...s, events: [...s.events, event] } : s,
            ),
          );
        },
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        reasoningEffort: config.reasoningEffort,
      });

      setFollowUpExchanges((prev) => {
        const next = new Map(prev);
        const existing = next.get(selectedIndex) ?? [];
        next.set(selectedIndex, [...existing, { question, answer }]);
        return next;
      });
      setIsTriaging(false);
    },
    [selectedIndex, findingStates, followUpExchanges, config],
  );
```

- [ ] **Step 6: Add permission resolve handler**

```typescript
  const handlePermissionResolve = useCallback((decision: PermissionDecision) => {
    if (pendingPermissionRef.current) {
      pendingPermissionRef.current(decision);
      pendingPermissionRef.current = null;
    }
  }, []);
```

- [ ] **Step 7: Update useInput for new keybindings**

Replace the existing `useInput` block:

```typescript
  useInput((input, key) => {
    // Follow-up input mode captures all input
    if (showFollowUp) return;

    if (input === "q") {
      exit();
      return;
    }

    // Permission response
    if (pendingPermissionRef.current) {
      if (input === "a") {
        handlePermissionResolve("once");
        return;
      }
      if (input === "d") {
        handlePermissionResolve("always");
        return;
      }
      if (input === "x") {
        handlePermissionResolve("deny");
        return;
      }
      return; // Block other input while permission pending
    }

    if (key.tab) {
      setViewMode(viewMode === "active" ? "filtered" : "active");
      setSelectedIndex(0);
      return;
    }
    if (key.upArrow && selectedIndex > 0) setSelectedIndex(selectedIndex - 1);
    if (key.downArrow && selectedIndex < listLength - 1)
      setSelectedIndex(selectedIndex + 1);

    // Space: toggle selection
    if (input === " " && viewMode === "active" && !isTriaging) {
      setSelectedIndices((prev) => {
        const next = new Set(prev);
        if (next.has(selectedIndex)) {
          next.delete(selectedIndex);
        } else {
          next.add(selectedIndex);
        }
        return next;
      });
      return;
    }

    // a: select all
    if (input === "a" && viewMode === "active" && !isTriaging) {
      setSelectedIndices(new Set(findingStates.map((_, i) => i).filter((i) => !findingStates[i]!.verdict)));
      return;
    }

    // Enter: start triage
    if (key.return && !isTriaging && viewMode === "active") {
      const indices = selectedIndices.size > 0
        ? [...selectedIndices].filter((i) => !findingStates[i]!.verdict).sort((a, b) => a - b)
        : [selectedIndex];
      startBatchQueue(indices);
      return;
    }

    // Esc: stop batch queue after current finding
    if (key.escape && queueState?.isRunning) {
      stopQueueRef.current = true;
      return;
    }

    // r: re-audit
    if (input === "r" && viewMode === "active" && !isTriaging) {
      reauditCurrent();
      return;
    }

    // f: follow-up
    if (input === "f" && viewMode === "active" && !isTriaging && selected?.verdict) {
      setShowFollowUp(true);
      return;
    }

    // Ctrl+P: switch provider
    if (input === "p" && key.ctrl && !isTriaging) {
      onSwitchProvider?.();
      return;
    }
  });
```

- [ ] **Step 8: Update MainScreen props to accept onSwitchProvider**

Update the `MainScreen` function signature:

```typescript
function MainScreen({
  findings,
  filteredFindings,
  totalCount,
  config,
  memory,
  onSwitchProvider,
}: {
  findings: Finding[];
  filteredFindings: { finding: Finding; reason: string }[];
  totalCount: number;
  config: AppConfig;
  memory: MemoryStore;
  onSwitchProvider?: () => void;
}) {
```

- [ ] **Step 9: Update JSX to pass new props**

In the `FindingsTable` usage, add `selectedIndices`:

```typescript
          <FindingsTable
            findings={findingStates.map((s) => s.entry)}
            selectedIndex={selectedIndex}
            triaged={triaged}
            selectedIndices={selectedIndices}
          />
```

In the `AgentPanel` usage, add the new props:

```typescript
          <AgentPanel
            events={selected.events}
            isActive={isTriaging && selectedIndex === findingStates.indexOf(selected)}
            width={panelWidth - 4}
            showFollowUpInput={showFollowUp}
            onFollowUp={handleFollowUp}
            onPermissionResolve={handlePermissionResolve}
          />
```

In the `Sidebar` usage, add queue and usage:

```typescript
          <Sidebar
            total={totalCount}
            active={findings.length}
            filtered={filteredFindings.length}
            triaged={triaged}
            tp={findingStates.filter((s) => s.verdict?.verdict === "true_positive").length}
            fp={findingStates.filter((s) => s.verdict?.verdict === "false_positive").length}
            nr={findingStates.filter((s) => s.verdict?.verdict === "needs_review").length}
            provider={config.provider}
            model={config.model}
            queue={queueState ? queueState.items.map((idx, qi) => ({
              label: findingStates[idx]!.finding.check_id.split(".").pop() ?? "",
              status: qi < queueState.currentIndex ? "done" as const
                : qi === queueState.currentIndex ? "active" as const
                : "pending" as const,
              verdict: findingStates[idx]!.verdict?.verdict,
            })) : undefined}
            sessionUsage={sessionUsage}
            currentUsage={currentUsage}
          />
```

- [ ] **Step 10: Update App component for provider switching**

In the `App` component, add provider switching state and handler:

```typescript
  const [switchingProvider, setSwitchingProvider] = useState(false);

  const handleSwitchProvider = useCallback(() => {
    setSwitchingProvider(true);
    setScreen("setup");
  }, []);
```

Update the `handleSetupComplete` to include `reasoningEffort`:

```typescript
  const handleSetupComplete = useCallback(
    (result: SetupResult) => {
      const fullConfig: AppConfig = {
        findingsPath: result.findingsPath,
        provider: result.provider,
        model: result.model,
        headless: false,
        allowBash: initialConfig.allowBash ?? false,
        maxSteps: initialConfig.maxSteps ?? 15,
        memoryDb: initialConfig.memoryDb ?? ".sast-triage/memory.db",
        apiKey: result.apiKey,
        baseUrl: result.baseUrl,
        reasoningEffort: result.reasoningEffort as AppConfig["reasoningEffort"],
        allowedPaths: projectConfig.allowedPaths,
      };
```

If we're switching providers (not first-time setup), skip findings reload:

```typescript
      if (switchingProvider) {
        setConfig(fullConfig);
        setScreen("main");
        setSwitchingProvider(false);
        return;
      }
```

Then keep the existing findings loading logic after this early return.

Update the setup screen rendering to pass `startStep` for provider switching:

```typescript
  if (screen === "setup") {
    return (
      <SetupScreen
        cwd={process.cwd()}
        projectConfig={projectConfig}
        onComplete={handleSetupComplete}
        startStep={switchingProvider ? "provider" : undefined}
      />
    );
  }
```

Pass `onSwitchProvider` to `MainScreen`:

```typescript
  return (
    <MainScreen
      findings={findings}
      filteredFindings={filteredFindings}
      totalCount={totalCount}
      config={config}
      memory={memory}
      onSwitchProvider={handleSwitchProvider}
    />
  );
```

- [ ] **Step 11: Verify everything compiles**

Run: `cd sast-triage-ts && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 12: Run full test suite**

Run: `cd sast-triage-ts && npx vitest run`
Expected: All tests pass

- [ ] **Step 13: Commit**

```bash
cd sast-triage-ts && git add src/ui/app.tsx && git commit -m "feat: add batch queue, re-audit, follow-up, provider switch, and permission UI to main app"
```

---

### Task 13: Final Integration — Wire CLI effort flag and run all tests

**Files:**
- Modify: `sast-triage-ts/src/index.ts`

- [ ] **Step 1: Pass reasoningEffort and allowedPaths through headless mode**

In `sast-triage-ts/src/index.ts`, in the `runHeadless` function's `runAgentLoop` call (around line 113), ensure the new fields are passed:

```typescript
    const verdict = await runAgentLoop({
      finding,
      projectRoot: process.cwd(),
      provider: config.provider,
      model: config.model,
      maxSteps: config.maxSteps,
      allowBash: config.allowBash,
      onEvent,
      memoryHints,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      reasoningEffort: config.reasoningEffort,
      allowedPaths: config.allowedPaths,
    });
```

In the TUI mode section, pass `reasoningEffort` from projectConfig to the effective config:

```typescript
    effectiveConfig.reasoningEffort ??= projectConfig.reasoningEffort;
    effectiveConfig.allowedPaths ??= projectConfig.allowedPaths;
```

Wait — this is in `App` component, not `index.ts`. Check: in `index.ts` the headless path reads from config which already has the fields. In the TUI path, the `App` component's `effectiveConfig` merging should also include them.

In `sast-triage-ts/src/ui/app.tsx` in the `App` component's effectiveConfig block, after existing entries add:

```typescript
    effectiveConfig.reasoningEffort ??= projectConfig.reasoningEffort;
    effectiveConfig.allowedPaths ??= projectConfig.allowedPaths.length > 0 ? projectConfig.allowedPaths : undefined;
```

- [ ] **Step 2: Run full test suite + type check**

Run: `cd sast-triage-ts && npx tsc --noEmit && npx vitest run`
Expected: All pass — no regressions

- [ ] **Step 3: Commit**

```bash
cd sast-triage-ts && git add src/index.ts src/ui/app.tsx && git commit -m "feat: wire reasoning effort and allowed paths through CLI and TUI entry points"
```

---

### Task 14: Run Full Test Suite and Verify

- [ ] **Step 1: Type check**

Run: `cd sast-triage-ts && npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 2: Run all tests**

Run: `cd sast-triage-ts && npx vitest run`
Expected: All tests pass, including new ones in `reasoning.test.ts`, `follow-up.test.ts`, updated `read.test.ts` and `project-config.test.ts`

- [ ] **Step 3: Final commit if any remaining changes**

```bash
cd sast-triage-ts && git status
```

If clean, no action. If there are uncommitted changes, commit them.
