# Setup Screen: Config Persistence, API Key Input, Back Navigation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Python TUI's `.sast-triage.toml` config persistence, API key input, and Escape-to-go-back navigation to the TS setup screen.

**Architecture:** New `ProjectConfig` class reads/writes `.sast-triage.toml` (TOML format, mirrors Python's `tui/config.py`). Setup screen gains an API key step and Escape navigation. If saved config exists on launch, setup is skipped. `resolveProvider` accepts an optional `apiKey` override so TUI-entered keys work without setting env vars.

**Tech Stack:** `smol-toml` (tiny TOML parser/serializer), Ink, React

---

### Task 1: Install smol-toml

**Files:**
- Modify: `sast-triage-ts/package.json`

- [ ] **Step 1: Install dependency**

```bash
cd sast-triage-ts && npm install smol-toml
```

- [ ] **Step 2: Verify import works**

```bash
cd sast-triage-ts && npx tsx -e "import { parse, stringify } from 'smol-toml'; console.log(stringify({ a: 1 }))"
```

Expected: `a = 1`

- [ ] **Step 3: Commit**

```bash
git add sast-triage-ts/package.json sast-triage-ts/package-lock.json
git commit -m "chore: add smol-toml dependency"
```

---

### Task 2: Create ProjectConfig class

**Files:**
- Create: `sast-triage-ts/src/config/project-config.ts`
- Test: `sast-triage-ts/tests/config/project-config.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/config/project-config.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectConfig } from "../../src/config/project-config.js";

describe("ProjectConfig", () => {
  let workspace: string;

  beforeEach(({ task }) => {
    // vitest tmp directory
    workspace = join(import.meta.dirname, ".tmp", task.id);
    mkdirSync(workspace, { recursive: true });
  });

  it("returns defaults when no toml exists", () => {
    const cfg = new ProjectConfig(workspace);
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-4o");
    expect(cfg.apiKey).toBeUndefined();
  });

  it("loads values from .sast-triage.toml", () => {
    writeFileSync(
      join(workspace, ".sast-triage.toml"),
      [
        "[provider]",
        'name = "anthropic"',
        'model = "claude-sonnet-4-20250514"',
        "",
        "[provider.api_keys]",
        'anthropic = "sk-ant-test"',
      ].join("\n"),
    );
    const cfg = new ProjectConfig(workspace);
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-20250514");
    expect(cfg.apiKey).toBe("sk-ant-test");
  });

  it("save() writes toml and round-trips", () => {
    const cfg = new ProjectConfig(workspace);
    cfg.provider = "google";
    cfg.model = "gemini-2.5-pro";
    cfg.apiKey = "AIza-test";
    cfg.save();

    const raw = readFileSync(join(workspace, ".sast-triage.toml"), "utf-8");
    expect(raw).toContain('name = "google"');
    expect(raw).toContain('model = "gemini-2.5-pro"');
    expect(raw).toContain('google = "AIza-test"');

    // Round-trip
    const cfg2 = new ProjectConfig(workspace);
    expect(cfg2.provider).toBe("google");
    expect(cfg2.model).toBe("gemini-2.5-pro");
    expect(cfg2.apiKey).toBe("AIza-test");
  });

  it("detectedProviders checks env vars", () => {
    const cfg = new ProjectConfig(workspace);
    const detected = cfg.detectedProviders();
    // At minimum returns all 4 providers with hasKey booleans
    expect(detected).toHaveLength(4);
    expect(detected[0]).toHaveProperty("name");
    expect(detected[0]).toHaveProperty("hasKey");
  });

  it("hasConfig() returns false with no toml, true after save", () => {
    const cfg = new ProjectConfig(workspace);
    expect(cfg.hasConfig()).toBe(false);
    cfg.save();
    expect(cfg.hasConfig()).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sast-triage-ts && npx vitest run tests/config/project-config.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement ProjectConfig**

`src/config/project-config.ts`:
```typescript
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { SUPPORTED_PROVIDERS, type ProviderName } from "../provider/registry.js";

const TOML_FILE = ".sast-triage.toml";

const ENV_KEYS: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export class ProjectConfig {
  private workspace: string;

  provider: ProviderName = "openai";
  model = "gpt-4o";
  apiKey: string | undefined;
  memoryDbPath: string;

  constructor(workspace: string) {
    this.workspace = workspace;
    this.memoryDbPath = join(workspace, ".sast-triage", "memory.db");
    this.load();
  }

  private get tomlPath(): string {
    return join(this.workspace, TOML_FILE);
  }

  hasConfig(): boolean {
    return existsSync(this.tomlPath);
  }

  private load(): void {
    if (!this.hasConfig()) return;
    const raw = readFileSync(this.tomlPath, "utf-8");
    const data = parse(raw) as Record<string, unknown>;

    const provider = data.provider as Record<string, unknown> | undefined;
    if (provider) {
      if (typeof provider.name === "string" && SUPPORTED_PROVIDERS.includes(provider.name as ProviderName)) {
        this.provider = provider.name as ProviderName;
      }
      if (typeof provider.model === "string") {
        this.model = provider.model;
      }

      const apiKeys = provider.api_keys as Record<string, string> | undefined;
      if (apiKeys) {
        // Try current provider first, then any key
        const key = apiKeys[this.provider] ?? Object.values(apiKeys)[0];
        if (key) this.apiKey = key;
      }
    }

    const memory = data.memory as Record<string, unknown> | undefined;
    if (memory && typeof memory.db_path === "string") {
      this.memoryDbPath = join(this.workspace, memory.db_path);
    }
  }

  save(): void {
    const data: Record<string, unknown> = {
      provider: {
        name: this.provider,
        model: this.model,
        ...(this.apiKey ? { api_keys: { [this.provider]: this.apiKey } } : {}),
      },
      memory: {
        db_path: ".sast-triage/memory.db",
      },
    };
    writeFileSync(this.tomlPath, stringify(data) + "\n");
  }

  detectedProviders(): { name: ProviderName; hasKey: boolean }[] {
    return SUPPORTED_PROVIDERS.map((name) => ({
      name,
      hasKey: !!process.env[ENV_KEYS[name]],
    }));
  }

  /** Returns API key: explicit override > toml > env var */
  resolvedApiKey(): string | undefined {
    return this.apiKey ?? process.env[ENV_KEYS[this.provider]];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd sast-triage-ts && npx vitest run tests/config/project-config.test.ts
```

Expected: 5 PASS

- [ ] **Step 5: Commit**

```bash
git add sast-triage-ts/src/config/project-config.ts sast-triage-ts/tests/config/project-config.test.ts
git commit -m "feat: add ProjectConfig with .sast-triage.toml persistence"
```

---

### Task 3: Add apiKey param to resolveProvider

**Files:**
- Modify: `sast-triage-ts/src/provider/registry.ts:24-30`
- Modify: `sast-triage-ts/tests/provider/registry.test.ts`

- [ ] **Step 1: Update resolveProvider signature**

In `src/provider/registry.ts`, change:
```typescript
export function resolveProvider(provider: string, model: string): LanguageModel {
```
to:
```typescript
export function resolveProvider(provider: string, model: string, apiKey?: string): LanguageModel {
```

And change line 30:
```typescript
  const apiKey = process.env[ENV_KEYS[name]];
```
to:
```typescript
  const resolvedKey = apiKey ?? process.env[ENV_KEYS[name]];
```

Then replace all `{ apiKey }` in the switch cases with `{ apiKey: resolvedKey }`.

- [ ] **Step 2: Type check**

```bash
cd sast-triage-ts && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Run existing tests**

```bash
cd sast-triage-ts && npx vitest run tests/provider/registry.test.ts
```

Expected: 3 PASS (signature is backwards-compatible)

- [ ] **Step 4: Commit**

```bash
git add sast-triage-ts/src/provider/registry.ts
git commit -m "feat: add optional apiKey param to resolveProvider"
```

---

### Task 4: Rewrite setup screen with back nav + API key step

**Files:**
- Modify: `sast-triage-ts/src/ui/components/setup-screen.tsx` (full rewrite)

- [ ] **Step 1: Rewrite setup-screen.tsx**

The new setup screen has 5 steps: `trust → provider → apikey → model → file`.

Each step shows `Esc — back` hint (except trust, which shows `n — exit`). Escape on `provider` returns to `trust`. The API key step is a password-masked `TextInput` with a skip option (Enter with empty = use env var). The provider step pre-selects from saved config if it exists.

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { SUPPORTED_PROVIDERS } from "../../provider/registry.js";
import type { ProviderName } from "../../provider/registry.js";
import { ProjectConfig } from "../../config/project-config.js";

const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  google: "gemini-2.5-pro",
  openrouter: "anthropic/claude-sonnet-4",
};

export interface SetupResult {
  provider: string;
  model: string;
  apiKey: string | undefined;
  findingsPath: string;
}

type SetupStep = "trust" | "provider" | "apikey" | "model" | "file";
const STEP_ORDER: SetupStep[] = ["trust", "provider", "apikey", "model", "file"];

function prevStep(current: SetupStep): SetupStep | null {
  const idx = STEP_ORDER.indexOf(current);
  return idx > 0 ? STEP_ORDER[idx - 1]! : null;
}

export function SetupScreen({
  cwd,
  projectConfig,
  onComplete,
}: {
  cwd: string;
  projectConfig: ProjectConfig;
  onComplete: (result: SetupResult) => void;
}) {
  const saved = projectConfig.hasConfig();
  const [step, setStep] = useState<SetupStep>("trust");
  const [providerIndex, setProviderIndex] = useState(() => {
    const idx = SUPPORTED_PROVIDERS.indexOf(projectConfig.provider);
    return idx >= 0 ? idx : 0;
  });
  const [selectedProvider, setSelectedProvider] = useState<ProviderName>(projectConfig.provider);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [modelInput, setModelInput] = useState(projectConfig.model);
  const [fileInput, setFileInput] = useState("findings.json");

  const providers = projectConfig.detectedProviders();

  const goBack = () => {
    const prev = prevStep(step);
    if (prev) setStep(prev);
  };

  useInput((input, key) => {
    if (step === "trust") {
      if (input === "y") setStep("provider");
      if (input === "n") process.exit(0);
      return;
    }

    // Escape goes back on all steps after trust
    if (key.escape) {
      goBack();
      return;
    }

    if (step === "provider") {
      if (key.upArrow && providerIndex > 0) setProviderIndex(providerIndex - 1);
      if (key.downArrow && providerIndex < providers.length - 1) setProviderIndex(providerIndex + 1);
      if (key.return) {
        const chosen = providers[providerIndex]!;
        setSelectedProvider(chosen.name);
        setModelInput(DEFAULT_MODELS[chosen.name]);
        setApiKeyInput("");
        setStep("apikey");
      }
    }
  });

  // --- Trust ---
  if (step === "trust") {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">sast-triage</Text>
        <Text> </Text>
        <Text>Do you trust the files in this folder?</Text>
        <Text> </Text>
        <Text dimColor>{cwd}</Text>
        <Text> </Text>
        <Text>
          <Text bold color="green">y</Text> — yes, trust {"  "}
          <Text bold color="red">n</Text> — no, exit
        </Text>
      </Box>
    );
  }

  // --- Provider ---
  if (step === "provider") {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Select Provider</Text>
        {saved && <Text dimColor>Saved config: {projectConfig.provider} / {projectConfig.model}</Text>}
        <Text> </Text>
        {providers.map((p, i) => {
          const sel = i === providerIndex;
          const indicator = sel ? ">" : " ";
          const keyStatus = p.hasKey ? (
            <Text color="green"> ●</Text>
          ) : (
            <Text color="red"> ○ no key</Text>
          );
          return (
            <Text key={p.name}>
              <Text color={sel ? "cyan" : undefined} bold={sel}>
                {" "}{indicator} {p.name}
              </Text>
              {keyStatus}
            </Text>
          );
        })}
        <Text> </Text>
        <Text dimColor>↑/↓ select · Enter confirm · Esc back</Text>
      </Box>
    );
  }

  // --- API Key ---
  if (step === "apikey") {
    const envHasKey = providers.find((p) => p.name === selectedProvider)?.hasKey;
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>API Key</Text>
        <Text dimColor>Provider: {selectedProvider}</Text>
        <Text> </Text>
        {envHasKey && <Text color="green">● Environment variable detected</Text>}
        <Text> </Text>
        <Box>
          <Text>API Key: </Text>
          <TextInput
            value={apiKeyInput}
            onChange={setApiKeyInput}
            mask="*"
            onSubmit={() => setStep("model")}
          />
        </Box>
        <Text> </Text>
        <Text dimColor>
          {envHasKey
            ? "Enter to skip (use env var) · Or paste key to override · Esc back"
            : "Paste your API key · Enter to confirm · Esc back"}
        </Text>
      </Box>
    );
  }

  // --- Model ---
  if (step === "model") {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Model</Text>
        <Text dimColor>Provider: {selectedProvider}</Text>
        <Text> </Text>
        <Box>
          <Text>Model: </Text>
          <TextInput
            value={modelInput}
            onChange={setModelInput}
            onSubmit={() => setStep("file")}
          />
        </Box>
        <Text> </Text>
        <Text dimColor>Enter to confirm · Esc back</Text>
      </Box>
    );
  }

  // --- File ---
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>Findings File</Text>
      <Text dimColor>
        {selectedProvider} / {modelInput}
      </Text>
      <Text> </Text>
      <Box>
        <Text>Path: </Text>
        <TextInput
          value={fileInput}
          onChange={setFileInput}
          onSubmit={(value) => {
            // Save config for next launch
            projectConfig.provider = selectedProvider;
            projectConfig.model = modelInput;
            projectConfig.apiKey = apiKeyInput || undefined;
            projectConfig.save();

            onComplete({
              provider: selectedProvider,
              model: modelInput,
              apiKey: apiKeyInput || projectConfig.resolvedApiKey(),
              findingsPath: value || "findings.json",
            });
          }}
        />
      </Box>
      <Text> </Text>
      <Text dimColor>Enter to start · Esc back</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Type check**

```bash
cd sast-triage-ts && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add sast-triage-ts/src/ui/components/setup-screen.tsx
git commit -m "feat: add API key input, Esc back navigation, saved config display"
```

---

### Task 5: Wire ProjectConfig into app.tsx and index.ts

**Files:**
- Modify: `sast-triage-ts/src/ui/app.tsx:16-17,162-224`
- Modify: `sast-triage-ts/src/index.ts:28-73`
- Modify: `sast-triage-ts/src/agent/loop.ts:11,22-25`

- [ ] **Step 1: Update SetupResult in app.tsx**

In `app.tsx`, update the `handleSetupComplete` callback to accept the new `SetupResult` (which now includes `apiKey`). Also pass `projectConfig` to `SetupScreen` and use it to decide whether to skip setup.

Key changes to `App` component:
- Accept `projectConfig: ProjectConfig` prop
- If `projectConfig.hasConfig()` and CLI args were not given, auto-load saved provider/model and skip to file step (or straight to main if findings path also provided via CLI)
- Pass `result.apiKey` through to `AppConfig`

Add `apiKey?: string` to `AppConfig` interface in `src/config.ts`:
```typescript
export interface AppConfig {
  findingsPath: string;
  provider: string;
  model: string;
  headless: boolean;
  allowBash: boolean;
  maxSteps: number;
  memoryDb: string;
  apiKey?: string;
}
```

- [ ] **Step 2: Update agent loop to pass apiKey**

In `src/agent/loop.ts`, add `apiKey?: string` to `AgentLoopConfig` and pass it to `resolveProvider`:

```typescript
// line ~25
const languageModel = resolveProvider(provider, modelId, config.apiKey);
```

- [ ] **Step 3: Update index.ts to create ProjectConfig**

In `src/index.ts`, create `ProjectConfig` before launching TUI and pass it through. For headless mode, use `projectConfig.resolvedApiKey()` if no explicit key is in env.

- [ ] **Step 4: Type check and run all tests**

```bash
cd sast-triage-ts && npx tsc --noEmit && npx vitest run
```

Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add sast-triage-ts/src/config.ts sast-triage-ts/src/ui/app.tsx sast-triage-ts/src/index.ts sast-triage-ts/src/agent/loop.ts
git commit -m "feat: wire ProjectConfig into TUI and agent loop"
```

---

### Task 6: Rebuild binary and smoke test

**Files:**
- No new files

- [ ] **Step 1: Build**

```bash
cd sast-triage-ts && npx tsc && bun build src/index.ts --compile --outfile sast-triage
```

- [ ] **Step 2: Smoke test from clean directory**

```bash
cd /tmp && mkdir -p sast-test && cd sast-test && /Users/n3m0/Code/bot/sast-triage-ts/sast-triage --version
```

Expected: `0.1.0`, no crash

- [ ] **Step 3: Verify .sast-triage.toml is not present, then run binary**

```bash
ls .sast-triage.toml 2>&1  # should not exist
```

Launch binary — should show trust screen, not crash.

- [ ] **Step 4: Commit any remaining changes**

```bash
git add -A sast-triage-ts/ && git commit -m "chore: rebuild binary with config persistence"
```
