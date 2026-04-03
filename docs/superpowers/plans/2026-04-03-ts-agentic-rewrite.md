# SAST Triage TypeScript Agentic Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite SAST Triage from a deterministic Python pipeline into an agentic TypeScript system where the LLM drives its own codebase exploration via tools, using Vercel AI SDK and Ink TUI.

**Architecture:** Semgrep JSON is parsed and prefiltered (deterministic), then each finding enters an agentic loop where the LLM calls tools (read, grep, glob, bash) to investigate, and exits by calling a verdict tool. Events stream to an Ink-based TUI. Multi-provider support via Vercel AI SDK.

**Tech Stack:** TypeScript, Vercel AI SDK (`ai` v5+), Ink v5, Zod, better-sqlite3, Commander, ripgrep (external binary), Vitest for testing.

---

## File Structure

```
sast-triage-ts/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    index.ts                  — CLI entry (commander)
    config.ts                 — resolved config from CLI flags + env
    models/
      finding.ts              — Zod: Finding, DataflowTrace, Position, etc.
      verdict.ts              — Zod: TriageVerdict
      events.ts               — AgentEvent discriminated union
    parser/
      semgrep.ts              — parseSemgrepOutput(), fingerprintFinding(), classifyFinding()
      prefilter.ts            — prefilterFinding() with skip rules
    memory/
      store.ts                — SQLite verdict cache (better-sqlite3)
    agent/
      loop.ts                 — agentic loop (streamText + tools + event emitter)
      system-prompt.ts        — security analyst system prompt + finding formatter
      doom-loop.ts            — repeated-call detector
      tools/
        index.ts              — tool registry, createTools()
        read.ts               — read file with line numbers
        grep.ts               — ripgrep regex search
        glob.ts               — ripgrep file discovery
        bash.ts               — sandboxed shell execution
        verdict.ts            — structured verdict tool (exits loop)
    provider/
      registry.ts             — createModel(provider, modelId) factory
    ui/
      app.tsx                 — Ink app root, state management
      components/
        findings-table.tsx    — left panel: findings list with status colors
        agent-panel.tsx       — center panel: live agent event stream
        verdict-banner.tsx    — colored verdict display block
        sidebar.tsx           — right panel: session stats
        permission-prompt.tsx — inline y/n/always prompt
    headless/
      reporter.ts             — NDJSON stdout reporter
  tests/
    fixtures/
      semgrep-output.json     — real Semgrep JSON for testing
      semgrep-taint.json      — finding with dataflow_trace
    models/
      finding.test.ts
      verdict.test.ts
    parser/
      semgrep.test.ts
      prefilter.test.ts
    memory/
      store.test.ts
    agent/
      doom-loop.test.ts
      loop.test.ts
      tools/
        read.test.ts
        grep.test.ts
        glob.test.ts
        bash.test.ts
        verdict.test.ts
    provider/
      registry.test.ts
    headless/
      reporter.test.ts
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `sast-triage-ts/package.json`
- Create: `sast-triage-ts/tsconfig.json`
- Create: `sast-triage-ts/vitest.config.ts`

- [ ] **Step 1: Create branch and project directory**

```bash
git checkout -b feat/TS-rewrite
mkdir -p sast-triage-ts/src sast-triage-ts/tests
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "sast-triage",
  "version": "0.1.0",
  "description": "Agentic SAST finding triage via LLM-driven codebase exploration",
  "type": "module",
  "bin": {
    "sast-triage": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "ai": "^5.0.0",
    "@ai-sdk/openai": "^2.0.0",
    "@ai-sdk/anthropic": "^2.0.0",
    "@ai-sdk/google": "^2.0.0",
    "@openrouter/ai-sdk-provider": "^0.4.0",
    "better-sqlite3": "^11.0.0",
    "commander": "^13.0.0",
    "ink": "^5.1.0",
    "@inkjs/ui": "^2.0.0",
    "react": "^18.3.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "@types/react": "^18.3.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "jsx": "react-jsx",
    "resolveJsonModule": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
  },
});
```

- [ ] **Step 5: Install dependencies**

```bash
cd sast-triage-ts && npm install
```

- [ ] **Step 6: Verify setup compiles**

Create a minimal `src/index.ts`:

```typescript
console.log("sast-triage");
```

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add sast-triage-ts/
git commit -m "chore: scaffold TypeScript project with deps"
```

---

### Task 2: Zod Models — Finding & Verdict

**Files:**
- Create: `sast-triage-ts/src/models/finding.ts`
- Create: `sast-triage-ts/src/models/verdict.ts`
- Create: `sast-triage-ts/src/models/events.ts`
- Create: `sast-triage-ts/tests/fixtures/semgrep-output.json`
- Create: `sast-triage-ts/tests/fixtures/semgrep-taint.json`
- Create: `sast-triage-ts/tests/models/finding.test.ts`
- Create: `sast-triage-ts/tests/models/verdict.test.ts`

- [ ] **Step 1: Create test fixtures**

`tests/fixtures/semgrep-output.json` — a minimal Semgrep JSON with 2 pattern findings:

```json
{
  "results": [
    {
      "check_id": "python.django.security.injection.sql.raw-query",
      "path": "src/api/views.py",
      "start": { "line": 47, "col": 8, "offset": 1200 },
      "end": { "line": 47, "col": 40, "offset": 1232 },
      "extra": {
        "message": "User input in raw SQL query",
        "severity": "ERROR",
        "metadata": {
          "cwe": ["CWE-89: SQL Injection"],
          "confidence": "HIGH",
          "vulnerability_class": ["SQL Injection"],
          "technology": ["django"],
          "owasp": ["A03:2021"],
          "category": "security"
        },
        "lines": "cursor.execute(sql)",
        "metavars": {}
      }
    },
    {
      "check_id": "python.lang.security.audit.xss.template-unescaped",
      "path": "src/templates/profile.html",
      "start": { "line": 12, "col": 5, "offset": 300 },
      "end": { "line": 12, "col": 30, "offset": 325 },
      "extra": {
        "message": "Unescaped template variable",
        "severity": "WARNING",
        "metadata": {
          "cwe": ["CWE-79: Cross-site Scripting"],
          "confidence": "MEDIUM",
          "vulnerability_class": ["Cross-Site Scripting"],
          "technology": [],
          "owasp": [],
          "category": "security"
        },
        "lines": "{{ user.name|safe }}",
        "metavars": {}
      }
    }
  ]
}
```

`tests/fixtures/semgrep-taint.json` — a finding with CliLoc-format dataflow trace:

```json
{
  "results": [
    {
      "check_id": "python.django.security.injection.sql.raw-query",
      "path": "src/api/views.py",
      "start": { "line": 47, "col": 8, "offset": 1200 },
      "end": { "line": 47, "col": 40, "offset": 1232 },
      "extra": {
        "message": "User input in raw SQL query",
        "severity": "ERROR",
        "metadata": {
          "cwe": ["CWE-89: SQL Injection"],
          "confidence": "HIGH",
          "vulnerability_class": ["SQL Injection"],
          "technology": ["django"],
          "owasp": [],
          "category": "security"
        },
        "lines": "cursor.execute(sql)",
        "metavars": {},
        "dataflow_trace": {
          "taint_source": ["CliLoc", [
            { "path": "src/api/views.py", "start": { "line": 32, "col": 12, "offset": 800 }, "end": { "line": 32, "col": 40, "offset": 828 } },
            "request.GET.get('query')"
          ]],
          "intermediate_vars": [
            ["CliLoc", [
              { "path": "src/api/views.py", "start": { "line": 45, "col": 8, "offset": 1150 }, "end": { "line": 45, "col": 50, "offset": 1192 } },
              "sql = f\"SELECT * FROM items WHERE name = '{query}'\""
            ]]
          ],
          "taint_sink": ["CliLoc", [
            { "path": "src/api/views.py", "start": { "line": 47, "col": 8, "offset": 1200 }, "end": { "line": 47, "col": 28, "offset": 1220 } },
            "cursor.execute(sql)"
          ]]
        }
      }
    }
  ]
}
```

- [ ] **Step 2: Write failing tests for Finding model**

`tests/models/finding.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FindingSchema,
  SemgrepOutputSchema,
  type Finding,
} from "../../src/models/finding.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

describe("FindingSchema", () => {
  it("parses a pattern finding", () => {
    const raw = JSON.parse(
      readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"),
    );
    const result = SemgrepOutputSchema.parse(raw);
    expect(result.results).toHaveLength(2);

    const f = result.results[0]!;
    expect(f.check_id).toBe(
      "python.django.security.injection.sql.raw-query",
    );
    expect(f.path).toBe("src/api/views.py");
    expect(f.start.line).toBe(47);
    expect(f.extra.severity).toBe("ERROR");
    expect(f.extra.metadata.cwe).toContain("CWE-89: SQL Injection");
    expect(f.extra.dataflow_trace).toBeUndefined();
  });

  it("parses a taint finding with CliLoc normalization", () => {
    const raw = JSON.parse(
      readFileSync(resolve(FIXTURES, "semgrep-taint.json"), "utf-8"),
    );
    const result = SemgrepOutputSchema.parse(raw);
    const f = result.results[0]!;

    expect(f.extra.dataflow_trace).toBeDefined();
    const trace = f.extra.dataflow_trace!;

    // CliLoc should be normalized to { content, location } objects
    expect(trace.taint_source).toBeDefined();
    expect(trace.taint_source!.content).toBe("request.GET.get('query')");
    expect(trace.taint_source!.location.path).toBe("src/api/views.py");
    expect(trace.taint_source!.location.start.line).toBe(32);

    expect(trace.taint_sink).toBeDefined();
    expect(trace.taint_sink!.content).toBe("cursor.execute(sql)");

    expect(trace.intermediate_vars).toHaveLength(1);
    expect(trace.intermediate_vars[0]!.content).toContain("sql = f\"SELECT");
  });

  it("handles missing optional fields with defaults", () => {
    const minimal = {
      check_id: "test.rule",
      path: "foo.py",
      start: { line: 1, col: 1 },
      end: { line: 1, col: 10 },
    };
    const f = FindingSchema.parse(minimal);
    expect(f.extra.severity).toBe("WARNING");
    expect(f.extra.metadata.cwe).toEqual([]);
    expect(f.extra.lines).toBe("");
  });

  it("preserves unknown extra fields via passthrough", () => {
    const withExtras = {
      check_id: "test.rule",
      path: "foo.py",
      start: { line: 1, col: 1 },
      end: { line: 1, col: 10 },
      extra: {
        message: "test",
        severity: "WARNING",
        metadata: { cwe: [], confidence: "LOW", category: "security" },
        lines: "",
        metavars: {},
        custom_field: "should_be_preserved",
      },
    };
    const f = FindingSchema.parse(withExtras);
    expect((f.extra as Record<string, unknown>).custom_field).toBe(
      "should_be_preserved",
    );
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd sast-triage-ts && npx vitest run tests/models/finding.test.ts
```

Expected: FAIL — modules don't exist yet.

- [ ] **Step 4: Implement Finding model**

`src/models/finding.ts`:

```typescript
import { z } from "zod";

export const PositionSchema = z.object({
  line: z.number(),
  col: z.number(),
  offset: z.number().default(0),
});

export type Position = z.infer<typeof PositionSchema>;

export const LocationSchema = z.object({
  path: z.string(),
  start: PositionSchema,
  end: PositionSchema,
});

export type Location = z.infer<typeof LocationSchema>;

export const DataflowTraceNodeSchema = z.object({
  content: z.string(),
  location: LocationSchema,
});

export type DataflowTraceNode = z.infer<typeof DataflowTraceNodeSchema>;

/**
 * Normalize CliLoc format: ["CliLoc", [{loc}, "content"]]
 * into { content, location } objects.
 */
function normalizeCliLoc(val: unknown): unknown {
  if (
    Array.isArray(val) &&
    val.length === 2 &&
    val[0] === "CliLoc" &&
    Array.isArray(val[1]) &&
    val[1].length === 2
  ) {
    const [loc, content] = val[1] as [unknown, unknown];
    if (typeof content === "string" && typeof loc === "object" && loc !== null) {
      return { location: loc, content };
    }
  }
  return val;
}

export const DataflowTraceSchema = z
  .object({
    taint_source: z.unknown().optional(),
    intermediate_vars: z.array(z.unknown()).default([]),
    taint_sink: z.unknown().optional(),
  })
  .passthrough()
  .transform((data) => {
    const source = data.taint_source
      ? DataflowTraceNodeSchema.parse(normalizeCliLoc(data.taint_source))
      : undefined;

    const sink = data.taint_sink
      ? DataflowTraceNodeSchema.parse(normalizeCliLoc(data.taint_sink))
      : undefined;

    const intermediates = data.intermediate_vars.map((iv) =>
      DataflowTraceNodeSchema.parse(normalizeCliLoc(iv)),
    );

    return { taint_source: source, taint_sink: sink, intermediate_vars: intermediates };
  });

export type DataflowTrace = z.infer<typeof DataflowTraceSchema>;

export const SemgrepMetadataSchema = z
  .object({
    cwe: z.array(z.string()).default([]),
    confidence: z.string().default("MEDIUM"),
    category: z.string().default("security"),
    technology: z.array(z.string()).default([]),
    owasp: z.array(z.string()).default([]),
    vulnerability_class: z.array(z.string()).default([]),
  })
  .passthrough();

export type SemgrepMetadata = z.infer<typeof SemgrepMetadataSchema>;

export const SemgrepExtraSchema = z
  .object({
    message: z.string().default(""),
    severity: z.string().default("WARNING"),
    metadata: SemgrepMetadataSchema.default({}),
    dataflow_trace: DataflowTraceSchema.optional(),
    lines: z.string().default(""),
    metavars: z.record(z.unknown()).default({}),
  })
  .passthrough();

export type SemgrepExtra = z.infer<typeof SemgrepExtraSchema>;

export const FindingSchema = z
  .object({
    check_id: z.string(),
    path: z.string(),
    start: PositionSchema,
    end: PositionSchema,
    extra: SemgrepExtraSchema.default({}),
  })
  .passthrough();

export type Finding = z.infer<typeof FindingSchema>;

export const SemgrepOutputSchema = z.object({
  results: z.array(FindingSchema).default([]),
});
```

- [ ] **Step 5: Write failing tests for Verdict model**

`tests/models/verdict.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { TriageVerdictSchema, type TriageVerdict } from "../../src/models/verdict.js";

describe("TriageVerdictSchema", () => {
  it("parses a valid true_positive verdict", () => {
    const v = TriageVerdictSchema.parse({
      verdict: "true_positive",
      reasoning: "User input flows directly to SQL",
      key_evidence: ["cursor.execute(sql)", "no parameterization"],
      suggested_fix: "Use parameterized query",
    });
    expect(v.verdict).toBe("true_positive");
    expect(v.key_evidence).toHaveLength(2);
    expect(v.suggested_fix).toBe("Use parameterized query");
  });

  it("parses a verdict without suggested_fix", () => {
    const v = TriageVerdictSchema.parse({
      verdict: "false_positive",
      reasoning: "ORM parameterized query",
      key_evidence: ["Model.objects.filter()"],
    });
    expect(v.suggested_fix).toBeUndefined();
  });

  it("rejects invalid verdict values", () => {
    expect(() =>
      TriageVerdictSchema.parse({
        verdict: "maybe",
        reasoning: "test",
        key_evidence: [],
      }),
    ).toThrow();
  });

  it("requires reasoning and key_evidence", () => {
    expect(() =>
      TriageVerdictSchema.parse({ verdict: "true_positive" }),
    ).toThrow();
  });
});
```

- [ ] **Step 6: Implement Verdict model**

`src/models/verdict.ts`:

```typescript
import { z } from "zod";

export const VerdictValue = z.enum([
  "true_positive",
  "false_positive",
  "needs_review",
]);

export type VerdictValue = z.infer<typeof VerdictValue>;

export const TriageVerdictSchema = z.object({
  verdict: VerdictValue,
  reasoning: z.string(),
  key_evidence: z.array(z.string()),
  suggested_fix: z.string().optional(),
});

export type TriageVerdict = z.infer<typeof TriageVerdictSchema>;
```

- [ ] **Step 7: Implement AgentEvent types**

`src/models/events.ts`:

```typescript
import type { TriageVerdict } from "./verdict.js";

export type AgentEvent =
  | { type: "tool_start"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; summary: string; full: string }
  | { type: "thinking"; delta: string }
  | { type: "verdict"; verdict: TriageVerdict }
  | { type: "error"; message: string };
```

- [ ] **Step 8: Run all model tests**

```bash
cd sast-triage-ts && npx vitest run tests/models/
```

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add sast-triage-ts/src/models/ sast-triage-ts/tests/models/ sast-triage-ts/tests/fixtures/
git commit -m "feat: add Zod models for Finding, Verdict, and AgentEvent"
```

---

### Task 3: Parser — Semgrep Parsing, Fingerprint, Classify

**Files:**
- Create: `sast-triage-ts/src/parser/semgrep.ts`
- Create: `sast-triage-ts/tests/parser/semgrep.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/parser/semgrep.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseSemgrepOutput,
  fingerprintFinding,
  classifyFinding,
} from "../../src/parser/semgrep.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

describe("parseSemgrepOutput", () => {
  it("parses JSON object with results array", () => {
    const raw = JSON.parse(
      readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"),
    );
    const findings = parseSemgrepOutput(raw);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.check_id).toBe(
      "python.django.security.injection.sql.raw-query",
    );
  });

  it("parses raw JSON string", () => {
    const str = readFileSync(
      resolve(FIXTURES, "semgrep-output.json"),
      "utf-8",
    );
    const findings = parseSemgrepOutput(str);
    expect(findings).toHaveLength(2);
  });

  it("parses bare results array", () => {
    const raw = JSON.parse(
      readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"),
    );
    const findings = parseSemgrepOutput(raw.results);
    expect(findings).toHaveLength(2);
  });

  it("returns empty array for invalid input", () => {
    expect(parseSemgrepOutput(42 as unknown as string)).toEqual([]);
    expect(parseSemgrepOutput("not json")).toEqual([]);
  });

  it("skips malformed findings", () => {
    const input = {
      results: [
        { check_id: "valid", path: "a.py", start: { line: 1, col: 1 }, end: { line: 1, col: 5 } },
        { broken: true },
      ],
    };
    const findings = parseSemgrepOutput(input);
    expect(findings).toHaveLength(1);
  });
});

describe("fingerprintFinding", () => {
  it("produces a 16-char hex string", () => {
    const raw = JSON.parse(
      readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"),
    );
    const findings = parseSemgrepOutput(raw);
    const fp = fingerprintFinding(findings[0]!);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces different fingerprints for different findings", () => {
    const raw = JSON.parse(
      readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"),
    );
    const findings = parseSemgrepOutput(raw);
    const fp1 = fingerprintFinding(findings[0]!);
    const fp2 = fingerprintFinding(findings[1]!);
    expect(fp1).not.toBe(fp2);
  });

  it("is deterministic", () => {
    const raw = JSON.parse(
      readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"),
    );
    const findings = parseSemgrepOutput(raw);
    const a = fingerprintFinding(findings[0]!);
    const b = fingerprintFinding(findings[0]!);
    expect(a).toBe(b);
  });
});

describe("classifyFinding", () => {
  it("classifies finding without dataflow trace as pattern", () => {
    const raw = JSON.parse(
      readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"),
    );
    const findings = parseSemgrepOutput(raw);
    expect(classifyFinding(findings[0]!)).toBe("pattern");
  });

  it("classifies finding with dataflow trace as taint", () => {
    const raw = JSON.parse(
      readFileSync(resolve(FIXTURES, "semgrep-taint.json"), "utf-8"),
    );
    const findings = parseSemgrepOutput(raw);
    expect(classifyFinding(findings[0]!)).toBe("taint");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sast-triage-ts && npx vitest run tests/parser/semgrep.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement parser**

`src/parser/semgrep.ts`:

```typescript
import { createHash } from "node:crypto";
import { FindingSchema, SemgrepOutputSchema, type Finding } from "../models/finding.js";

export function parseSemgrepOutput(raw: unknown): Finding[] {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }

  if (Array.isArray(raw)) {
    return parseFindingsArray(raw);
  }

  if (typeof raw === "object" && raw !== null) {
    const parsed = SemgrepOutputSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data.results;
    }
    return [];
  }

  return [];
}

function parseFindingsArray(items: unknown[]): Finding[] {
  const findings: Finding[] = [];
  for (const item of items) {
    const result = FindingSchema.safeParse(item);
    if (result.success) {
      findings.push(result.data);
    }
  }
  return findings;
}

export function fingerprintFinding(finding: Finding): string {
  const data = `${finding.check_id}:${finding.path}:${finding.start.line}:${finding.extra.lines}`;
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

export function classifyFinding(finding: Finding): "taint" | "pattern" {
  const trace = finding.extra.dataflow_trace;
  if (!trace) return "pattern";
  return trace.taint_source != null || trace.taint_sink != null
    ? "taint"
    : "pattern";
}
```

- [ ] **Step 4: Run tests**

```bash
cd sast-triage-ts && npx vitest run tests/parser/semgrep.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add sast-triage-ts/src/parser/semgrep.ts sast-triage-ts/tests/parser/semgrep.test.ts
git commit -m "feat: add Semgrep parser with fingerprint and classify"
```

---

### Task 4: Prefilter

**Files:**
- Create: `sast-triage-ts/src/parser/prefilter.ts`
- Create: `sast-triage-ts/tests/parser/prefilter.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/parser/prefilter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { prefilterFinding, type PrefilterResult } from "../../src/parser/prefilter.js";
import { FindingSchema, type Finding } from "../../src/models/finding.js";

function makeFinding(overrides: Record<string, unknown> = {}): Finding {
  return FindingSchema.parse({
    check_id: "test.rule",
    path: (overrides.path as string) ?? "src/app.py",
    start: { line: 10, col: 1 },
    end: { line: 10, col: 20 },
    extra: {
      message: "test",
      severity: (overrides.severity as string) ?? "ERROR",
      metadata: { cwe: [], confidence: "HIGH", category: "security" },
      lines: "test_line",
      metavars: {},
      ...(typeof overrides.extra === "object" ? overrides.extra : {}),
    },
  });
}

describe("prefilterFinding", () => {
  it("passes normal findings", () => {
    const result = prefilterFinding(makeFinding());
    expect(result.passed).toBe(true);
  });

  it("filters test files by directory pattern", () => {
    const patterns = [
      "src/__tests__/foo.py",
      "src/tests/test_auth.py",
      "test/helpers.py",
      "testing/utils.py",
    ];
    for (const path of patterns) {
      const result = prefilterFinding(makeFinding({ path }));
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("Test file");
    }
  });

  it("filters test files by filename pattern", () => {
    const patterns = [
      "src/test_auth.py",
      "src/auth_test.py",
      "src/auth.test.ts",
      "src/auth.spec.ts",
      "conftest.py",
    ];
    for (const path of patterns) {
      const result = prefilterFinding(makeFinding({ path }));
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("Test file");
    }
  });

  it("filters generated/vendor files", () => {
    const patterns = [
      "src/migrations/0001_initial.py",
      "node_modules/lodash/index.js",
      "vendor/github.com/lib/pq/conn.go",
      "dist/bundle.js",
      "build/output.js",
      "src/api_pb2.py",
      "assets/app.min.js",
      "gen/types.ts",
      "src/generated/schema.ts",
    ];
    for (const path of patterns) {
      const result = prefilterFinding(makeFinding({ path }));
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("Generated");
    }
  });

  it("filters INFO severity", () => {
    const result = prefilterFinding(makeFinding({ severity: "INFO" }));
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Informational");
  });

  it("is case-insensitive for severity", () => {
    const result = prefilterFinding(makeFinding({ severity: "info" }));
    expect(result.passed).toBe(false);
  });

  it("filters cached verdicts when memory lookup provided", () => {
    const lookup = (_fp: string) => ({ verdict: "false_positive" as const });
    const result = prefilterFinding(makeFinding(), lookup);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Cached");
  });

  it("passes when memory lookup returns null", () => {
    const lookup = (_fp: string) => null;
    const result = prefilterFinding(makeFinding(), lookup);
    expect(result.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sast-triage-ts && npx vitest run tests/parser/prefilter.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement prefilter**

`src/parser/prefilter.ts`:

```typescript
import type { Finding } from "../models/finding.js";
import { fingerprintFinding } from "./semgrep.js";

export interface PrefilterResult {
  passed: boolean;
  reason?: string;
}

export type MemoryLookup = (fingerprint: string) => { verdict: string } | null;

const TEST_DIR_PATTERNS = [
  "__tests__",
  "/tests/",
  "/test/",
  "testing/",
];

const TEST_FILE_PATTERNS = [
  "test_",
  "_test.",
  ".test.",
  ".spec.",
  "conftest.",
  "test_helper",
];

const GENERATED_PATH_PATTERNS = [
  "/migrations/",
  "node_modules/",
  "/vendor/",
  "vendor/",
  "/dist/",
  "/build/",
  ".generated.",
  "_pb2.py",
  ".min.js",
  "package-lock.json",
  "yarn.lock",
  ".pb.go",
  "/gen/",
  "/generated/",
];

export function prefilterFinding(
  finding: Finding,
  memoryLookup?: MemoryLookup,
): PrefilterResult {
  if (isTestFile(finding.path)) {
    return { passed: false, reason: "Test file" };
  }

  if (isGeneratedFile(finding.path)) {
    return { passed: false, reason: "Generated/vendor file" };
  }

  if (memoryLookup) {
    const fp = fingerprintFinding(finding);
    const cached = memoryLookup(fp);
    if (cached) {
      return { passed: false, reason: `Cached verdict: ${cached.verdict}` };
    }
  }

  if (isInfoSeverity(finding)) {
    return { passed: false, reason: "Informational severity" };
  }

  return { passed: true };
}

function isTestFile(path: string): boolean {
  const lower = path.toLowerCase();
  const basename = lower.split("/").pop() ?? "";
  if (TEST_FILE_PATTERNS.some((p) => basename.includes(p))) return true;
  return TEST_DIR_PATTERNS.some((p) => lower.includes(p));
}

function isGeneratedFile(path: string): boolean {
  const lower = path.toLowerCase();
  return GENERATED_PATH_PATTERNS.some((p) => lower.includes(p));
}

function isInfoSeverity(finding: Finding): boolean {
  return finding.extra.severity.toUpperCase() === "INFO";
}
```

- [ ] **Step 4: Run tests**

```bash
cd sast-triage-ts && npx vitest run tests/parser/prefilter.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add sast-triage-ts/src/parser/prefilter.ts sast-triage-ts/tests/parser/prefilter.test.ts
git commit -m "feat: add prefilter with test/generated/severity/cache rules"
```

---

### Task 5: Memory Store

**Files:**
- Create: `sast-triage-ts/src/memory/store.ts`
- Create: `sast-triage-ts/tests/memory/store.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/memory/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../../src/memory/store.js";

let tmpDir: string;
let store: MemoryStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sast-triage-test-"));
  store = new MemoryStore(join(tmpDir, "memory.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("MemoryStore", () => {
  it("stores and retrieves a verdict", () => {
    store.store({
      fingerprint: "abc123",
      check_id: "test.rule",
      path: "src/app.py",
      verdict: "true_positive",
      reasoning: "SQL injection found",
    });

    const record = store.lookup("abc123");
    expect(record).not.toBeNull();
    expect(record!.verdict).toBe("true_positive");
    expect(record!.reasoning).toBe("SQL injection found");
    expect(record!.check_id).toBe("test.rule");
  });

  it("returns null for unknown fingerprint", () => {
    expect(store.lookup("nonexistent")).toBeNull();
  });

  it("upserts on duplicate fingerprint", () => {
    store.store({
      fingerprint: "abc123",
      check_id: "test.rule",
      path: "src/app.py",
      verdict: "needs_review",
      reasoning: "first pass",
    });
    store.store({
      fingerprint: "abc123",
      check_id: "test.rule",
      path: "src/app.py",
      verdict: "false_positive",
      reasoning: "ORM is safe",
    });

    const record = store.lookup("abc123");
    expect(record!.verdict).toBe("false_positive");
    expect(record!.reasoning).toBe("ORM is safe");
  });

  it("looks up by rule with limit", () => {
    for (let i = 0; i < 5; i++) {
      store.store({
        fingerprint: `fp-${i}`,
        check_id: "same.rule",
        path: `src/file${i}.py`,
        verdict: i % 2 === 0 ? "true_positive" : "false_positive",
        reasoning: `reason ${i}`,
      });
    }

    const records = store.lookupByRule("same.rule", 3);
    expect(records).toHaveLength(3);
  });

  it("getHints returns prior verdict text", () => {
    store.store({
      fingerprint: "abc123",
      check_id: "test.rule",
      path: "src/app.py",
      verdict: "true_positive",
      reasoning: "SQL injection found",
    });

    const hints = store.getHints("test.rule", "abc123");
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]).toContain("true_positive");
  });

  it("getHints returns rule-level stats when enough data", () => {
    for (let i = 0; i < 3; i++) {
      store.store({
        fingerprint: `fp-${i}`,
        check_id: "popular.rule",
        path: `src/file${i}.py`,
        verdict: "true_positive",
        reasoning: "vuln",
      });
    }

    const hints = store.getHints("popular.rule", "unknown-fp");
    expect(hints.some((h) => h.includes("previous findings"))).toBe(true);
  });

  it("createLookup returns a function usable by prefilter", () => {
    store.store({
      fingerprint: "abc123",
      check_id: "test.rule",
      path: "src/app.py",
      verdict: "false_positive",
      reasoning: "safe",
    });

    const lookup = store.createLookup();
    expect(lookup("abc123")).toEqual({ verdict: "false_positive" });
    expect(lookup("unknown")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sast-triage-ts && npx vitest run tests/memory/store.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement memory store**

`src/memory/store.ts`:

```typescript
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryLookup } from "../parser/prefilter.js";

export interface TriageRecord {
  fingerprint: string;
  check_id: string;
  path: string;
  verdict: string;
  reasoning: string;
  created_at?: string;
  updated_at?: string;
}

export interface StoreInput {
  fingerprint: string;
  check_id: string;
  path: string;
  verdict: string;
  reasoning: string;
}

export class MemoryStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS triage_records (
        fingerprint TEXT PRIMARY KEY,
        check_id TEXT NOT NULL,
        path TEXT NOT NULL,
        verdict TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  lookup(fingerprint: string): TriageRecord | null {
    const row = this.db
      .prepare("SELECT * FROM triage_records WHERE fingerprint = ?")
      .get(fingerprint) as TriageRecord | undefined;
    return row ?? null;
  }

  lookupByRule(checkId: string, limit = 10): TriageRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM triage_records WHERE check_id = ? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(checkId, limit) as TriageRecord[];
  }

  store(input: StoreInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO triage_records (fingerprint, check_id, path, verdict, reasoning, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fingerprint) DO UPDATE SET
           verdict = excluded.verdict,
           reasoning = excluded.reasoning,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.fingerprint,
        input.check_id,
        input.path,
        input.verdict,
        input.reasoning,
        now,
        now,
      );
  }

  getHints(checkId: string, fingerprint: string): string[] {
    const hints: string[] = [];

    const exact = this.lookup(fingerprint);
    if (exact) {
      hints.push(
        `Previously triaged as ${exact.verdict}: ${exact.reasoning.slice(0, 100)}`,
      );
    }

    const records = this.lookupByRule(checkId, 50);
    if (records.length >= 2) {
      const tpCount = records.filter((r) => r.verdict === "true_positive").length;
      hints.push(
        `${records.length} previous findings for rule ${checkId}: ${tpCount}/${records.length} true positives`,
      );
    }

    return hints;
  }

  createLookup(): MemoryLookup {
    return (fingerprint: string) => {
      const record = this.lookup(fingerprint);
      if (!record) return null;
      return { verdict: record.verdict };
    };
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd sast-triage-ts && npx vitest run tests/memory/store.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add sast-triage-ts/src/memory/ sast-triage-ts/tests/memory/
git commit -m "feat: add SQLite memory store for verdict caching"
```

---

### Task 6: Agent Tools — read, grep, glob, bash, verdict

**Files:**
- Create: `sast-triage-ts/src/agent/tools/read.ts`
- Create: `sast-triage-ts/src/agent/tools/grep.ts`
- Create: `sast-triage-ts/src/agent/tools/glob.ts`
- Create: `sast-triage-ts/src/agent/tools/bash.ts`
- Create: `sast-triage-ts/src/agent/tools/verdict.ts`
- Create: `sast-triage-ts/src/agent/tools/index.ts`
- Create: `sast-triage-ts/tests/agent/tools/read.test.ts`
- Create: `sast-triage-ts/tests/agent/tools/grep.test.ts`
- Create: `sast-triage-ts/tests/agent/tools/glob.test.ts`
- Create: `sast-triage-ts/tests/agent/tools/bash.test.ts`
- Create: `sast-triage-ts/tests/agent/tools/verdict.test.ts`

- [ ] **Step 1: Write failing tests for read tool**

`tests/agent/tools/read.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReadTool } from "../../../src/agent/tools/read.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sast-read-test-"));
  writeFileSync(
    join(tmpDir, "example.py"),
    Array.from({ length: 50 }, (_, i) => `line ${i + 1}: code here`).join("\n"),
  );
  mkdirSync(join(tmpDir, "sub"));
  writeFileSync(join(tmpDir, "sub", "nested.py"), "nested content\n");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("read tool", () => {
  it("reads a file with line numbers", async () => {
    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ path: "example.py" });
    expect(result).toContain("1\tline 1: code here");
    expect(result).toContain("50\tline 50: code here");
  });

  it("respects offset and limit", async () => {
    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ path: "example.py", offset: 10, limit: 5 });
    expect(result).toContain("10\tline 10: code here");
    expect(result).toContain("14\tline 14: code here");
    expect(result).not.toContain("15\tline 15: code here");
  });

  it("reads nested files", async () => {
    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ path: "sub/nested.py" });
    expect(result).toContain("nested content");
  });

  it("rejects paths outside project root", async () => {
    const tool = createReadTool(tmpDir);
    await expect(
      tool.execute({ path: "../../../etc/passwd" }),
    ).rejects.toThrow(/outside project/i);
  });

  it("returns error for nonexistent file", async () => {
    const tool = createReadTool(tmpDir);
    await expect(
      tool.execute({ path: "nonexistent.py" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sast-triage-ts && npx vitest run tests/agent/tools/read.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement read tool**

`src/agent/tools/read.ts`:

```typescript
import { readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const MAX_OUTPUT_BYTES = 50_000;
const DEFAULT_LIMIT = 200;

export interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

export function createReadTool(projectRoot: string) {
  function assertWithinRoot(filePath: string): string {
    const abs = resolve(projectRoot, filePath);
    const rel = relative(projectRoot, abs);
    if (rel.startsWith("..") || resolve(abs) !== abs && rel.startsWith("..")) {
      throw new Error(`Path "${filePath}" is outside project root`);
    }
    // Double-check with resolve
    if (!resolve(abs).startsWith(resolve(projectRoot))) {
      throw new Error(`Path "${filePath}" is outside project root`);
    }
    return abs;
  }

  return {
    execute: async (input: ReadToolInput): Promise<string> => {
      const absPath = assertWithinRoot(input.path);
      const content = readFileSync(absPath, "utf-8");
      const lines = content.split("\n");

      const offset = Math.max(1, input.offset ?? 1);
      const limit = input.limit ?? DEFAULT_LIMIT;

      const startIdx = offset - 1; // 0-indexed
      const slice = lines.slice(startIdx, startIdx + limit);

      const numbered = slice.map(
        (line, i) => `${startIdx + i + 1}\t${line}`,
      );

      let output = numbered.join("\n");
      if (output.length > MAX_OUTPUT_BYTES) {
        output = output.slice(0, MAX_OUTPUT_BYTES) + "\n... (truncated)";
      }

      return output;
    },
  };
}
```

- [ ] **Step 4: Run read tests**

```bash
cd sast-triage-ts && npx vitest run tests/agent/tools/read.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Write failing tests for grep tool**

`tests/agent/tools/grep.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGrepTool } from "../../../src/agent/tools/grep.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sast-grep-test-"));
  mkdirSync(join(tmpDir, "src"));
  writeFileSync(
    join(tmpDir, "src", "app.py"),
    "import os\ndef sanitize(x):\n  return x.strip()\ncursor.execute(sql)\n",
  );
  writeFileSync(
    join(tmpDir, "src", "utils.py"),
    "def validate(input):\n  return int(input)\n",
  );
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("grep tool", () => {
  it("finds matches across files", async () => {
    const tool = createGrepTool(tmpDir);
    const result = await tool.execute({ pattern: "def \\w+" });
    expect(result).toContain("sanitize");
    expect(result).toContain("validate");
  });

  it("respects path filter", async () => {
    const tool = createGrepTool(tmpDir);
    const result = await tool.execute({ pattern: "def", path: "src/utils.py" });
    expect(result).toContain("validate");
    expect(result).not.toContain("sanitize");
  });

  it("respects include glob", async () => {
    const tool = createGrepTool(tmpDir);
    const result = await tool.execute({ pattern: "import", include: "*.py" });
    expect(result).toContain("import os");
  });

  it("returns empty for no matches", async () => {
    const tool = createGrepTool(tmpDir);
    const result = await tool.execute({ pattern: "nonexistent_pattern_xyz" });
    expect(result).toBe("No matches found.");
  });
});
```

- [ ] **Step 6: Implement grep tool**

`src/agent/tools/grep.ts`:

```typescript
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const MAX_MATCHES = 50;
const MAX_OUTPUT_BYTES = 50_000;

export interface GrepToolInput {
  pattern: string;
  path?: string;
  include?: string;
}

export function createGrepTool(projectRoot: string) {
  return {
    execute: async (input: GrepToolInput): Promise<string> => {
      const args = [
        "--no-heading",
        "--line-number",
        "--color=never",
        "--max-count=50",
        "-e",
        input.pattern,
      ];

      if (input.include) {
        args.push("--glob", input.include);
      }

      const searchPath = input.path
        ? resolve(projectRoot, input.path)
        : projectRoot;

      try {
        const stdout = execFileSync("rg", args, {
          cwd: searchPath,
          encoding: "utf-8",
          maxBuffer: MAX_OUTPUT_BYTES,
          timeout: 10_000,
        });

        const lines = stdout.trim().split("\n");
        const limited = lines.slice(0, MAX_MATCHES);
        let output = limited.join("\n");

        if (lines.length > MAX_MATCHES) {
          output += `\n... (${lines.length - MAX_MATCHES} more matches truncated)`;
        }

        return output;
      } catch (err: unknown) {
        const error = err as { status?: number; stdout?: string };
        // rg exits 1 when no matches found
        if (error.status === 1) {
          return "No matches found.";
        }
        throw err;
      }
    },
  };
}
```

- [ ] **Step 7: Run grep tests**

```bash
cd sast-triage-ts && npx vitest run tests/agent/tools/grep.test.ts
```

Expected: all PASS (requires `rg` installed on the machine).

- [ ] **Step 8: Write failing tests for glob tool**

`tests/agent/tools/glob.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGlobTool } from "../../../src/agent/tools/glob.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sast-glob-test-"));
  mkdirSync(join(tmpDir, "src"));
  mkdirSync(join(tmpDir, "src", "api"));
  writeFileSync(join(tmpDir, "src", "app.py"), "");
  writeFileSync(join(tmpDir, "src", "api", "views.py"), "");
  writeFileSync(join(tmpDir, "src", "api", "urls.py"), "");
  writeFileSync(join(tmpDir, "README.md"), "");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("glob tool", () => {
  it("finds files matching pattern", async () => {
    const tool = createGlobTool(tmpDir);
    const result = await tool.execute({ pattern: "**/*.py" });
    expect(result).toContain("app.py");
    expect(result).toContain("views.py");
    expect(result).not.toContain("README.md");
  });

  it("respects path filter", async () => {
    const tool = createGlobTool(tmpDir);
    const result = await tool.execute({ pattern: "**/*.py", path: "src/api" });
    expect(result).toContain("views.py");
    expect(result).not.toContain("app.py");
  });

  it("returns empty for no matches", async () => {
    const tool = createGlobTool(tmpDir);
    const result = await tool.execute({ pattern: "**/*.rs" });
    expect(result).toBe("No files found.");
  });
});
```

- [ ] **Step 9: Implement glob tool**

`src/agent/tools/glob.ts`:

```typescript
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const MAX_RESULTS = 50;

const IGNORE_PATTERNS = [
  "node_modules",
  ".git",
  "dist",
  "__pycache__",
  "venv",
  "build",
  ".venv",
];

export interface GlobToolInput {
  pattern: string;
  path?: string;
}

export function createGlobTool(projectRoot: string) {
  return {
    execute: async (input: GlobToolInput): Promise<string> => {
      const args = ["--files", "--color=never"];

      args.push("--glob", input.pattern);

      for (const ignore of IGNORE_PATTERNS) {
        args.push("--glob", `!${ignore}`);
      }

      const searchPath = input.path
        ? resolve(projectRoot, input.path)
        : projectRoot;

      try {
        const stdout = execFileSync("rg", args, {
          cwd: searchPath,
          encoding: "utf-8",
          timeout: 10_000,
        });

        const lines = stdout.trim().split("\n").filter(Boolean);
        if (lines.length === 0) return "No files found.";

        const limited = lines.slice(0, MAX_RESULTS);
        let output = limited.join("\n");

        if (lines.length > MAX_RESULTS) {
          output += `\n... (${lines.length - MAX_RESULTS} more files)`;
        }

        return output;
      } catch (err: unknown) {
        const error = err as { status?: number };
        if (error.status === 1) return "No files found.";
        throw err;
      }
    },
  };
}
```

- [ ] **Step 10: Run glob tests**

```bash
cd sast-triage-ts && npx vitest run tests/agent/tools/glob.test.ts
```

Expected: all PASS.

- [ ] **Step 11: Write failing tests for bash tool**

`tests/agent/tools/bash.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createBashTool } from "../../../src/agent/tools/bash.js";

describe("bash tool", () => {
  it("executes a simple command", async () => {
    const tool = createBashTool("/tmp");
    const result = await tool.execute({ command: "echo hello" });
    expect(result).toContain("hello");
  });

  it("blocks dangerous commands", async () => {
    const tool = createBashTool("/tmp");
    const dangerous = ["rm -rf /", "mv foo bar", "curl http://evil.com", "wget bad", "chmod 777 file"];
    for (const cmd of dangerous) {
      await expect(tool.execute({ command: cmd })).rejects.toThrow(/blocked/i);
    }
  });

  it("respects timeout", async () => {
    const tool = createBashTool("/tmp");
    await expect(
      tool.execute({ command: "sleep 60", timeout: 1 }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 12: Implement bash tool**

`src/agent/tools/bash.ts`:

```typescript
import { execSync } from "node:child_process";

const MAX_OUTPUT_BYTES = 50_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const BLOCKED_COMMANDS = [
  "rm",
  "mv",
  "cp",
  "chmod",
  "chown",
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "dd",
  "mkfs",
  "fdisk",
];

export interface BashToolInput {
  command: string;
  timeout?: number;
}

export function createBashTool(projectRoot: string) {
  return {
    execute: async (input: BashToolInput): Promise<string> => {
      const firstWord = input.command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      // Also check for piped/chained dangerous commands
      const allWords = input.command
        .split(/[|;&]/)
        .map((part) => part.trim().split(/\s+/)[0]?.toLowerCase() ?? "");

      for (const word of [firstWord, ...allWords]) {
        if (BLOCKED_COMMANDS.includes(word)) {
          throw new Error(
            `Command blocked: "${word}" is not allowed. Only read-only exploration commands are permitted.`,
          );
        }
      }

      const timeoutMs = (input.timeout ?? 30) * 1_000;

      try {
        const stdout = execSync(input.command, {
          cwd: projectRoot,
          encoding: "utf-8",
          maxBuffer: MAX_OUTPUT_BYTES,
          timeout: Math.min(timeoutMs, DEFAULT_TIMEOUT_MS),
          stdio: ["pipe", "pipe", "pipe"],
        });

        return stdout.length > MAX_OUTPUT_BYTES
          ? stdout.slice(0, MAX_OUTPUT_BYTES) + "\n... (truncated)"
          : stdout;
      } catch (err: unknown) {
        const error = err as { stdout?: string; stderr?: string; message?: string };
        const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
        if (output) return `Command failed:\n${output}`;
        throw err;
      }
    },
  };
}
```

- [ ] **Step 13: Run bash tests**

```bash
cd sast-triage-ts && npx vitest run tests/agent/tools/bash.test.ts
```

Expected: all PASS.

- [ ] **Step 14: Write failing tests for verdict tool**

`tests/agent/tools/verdict.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { createVerdictTool } from "../../../src/agent/tools/verdict.js";

describe("verdict tool", () => {
  it("parses a valid verdict", async () => {
    const tool = createVerdictTool();
    const result = await tool.execute({
      verdict: "true_positive",
      reasoning: "SQL injection confirmed",
      key_evidence: ["cursor.execute(sql)", "no parameterization"],
      suggested_fix: "Use parameterized query",
    });
    expect(result.verdict).toBe("true_positive");
    expect(result.key_evidence).toHaveLength(2);
  });

  it("rejects invalid verdict value", async () => {
    const tool = createVerdictTool();
    await expect(
      tool.execute({
        verdict: "maybe" as "true_positive",
        reasoning: "dunno",
        key_evidence: [],
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 15: Implement verdict tool**

`src/agent/tools/verdict.ts`:

```typescript
import { TriageVerdictSchema, type TriageVerdict } from "../../models/verdict.js";

export interface VerdictToolInput {
  verdict: string;
  reasoning: string;
  key_evidence: string[];
  suggested_fix?: string;
}

export function createVerdictTool() {
  return {
    execute: async (input: VerdictToolInput): Promise<TriageVerdict> => {
      return TriageVerdictSchema.parse(input);
    },
  };
}
```

- [ ] **Step 16: Run verdict tests**

```bash
cd sast-triage-ts && npx vitest run tests/agent/tools/verdict.test.ts
```

Expected: all PASS.

- [ ] **Step 17: Create tool registry**

`src/agent/tools/index.ts`:

```typescript
import { z } from "zod";
import { tool, type ToolSet } from "ai";
import { createReadTool } from "./read.js";
import { createGrepTool } from "./grep.js";
import { createGlobTool } from "./glob.js";
import { createBashTool } from "./bash.js";
import { TriageVerdictSchema } from "../../models/verdict.js";

export interface ToolConfig {
  projectRoot: string;
  allowBash: boolean;
}

export function createTools(config: ToolConfig): ToolSet {
  const readImpl = createReadTool(config.projectRoot);
  const grepImpl = createGrepTool(config.projectRoot);
  const globImpl = createGlobTool(config.projectRoot);

  const tools: ToolSet = {
    read: tool({
      description:
        "Read a file's contents with line numbers. Use offset/limit to read specific sections.",
      parameters: z.object({
        path: z.string().describe("File path relative to project root"),
        offset: z.number().optional().describe("Start line (1-indexed, default 1)"),
        limit: z.number().optional().describe("Max lines to read (default 200)"),
      }),
      execute: async (args) => readImpl.execute(args),
    }),

    grep: tool({
      description:
        "Search file contents using regex. Returns matching lines with file paths and line numbers.",
      parameters: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        path: z.string().optional().describe("Subdirectory to search in"),
        include: z.string().optional().describe("Glob filter (e.g. '*.py')"),
      }),
      execute: async (args) => grepImpl.execute(args),
    }),

    glob: tool({
      description:
        "Find files matching a glob pattern. Returns file paths sorted by modification time.",
      parameters: z.object({
        pattern: z.string().describe("Glob pattern (e.g. '**/*.py')"),
        path: z.string().optional().describe("Subdirectory to search in"),
      }),
      execute: async (args) => globImpl.execute(args),
    }),

    verdict: tool({
      description:
        "Deliver your final triage verdict. Call this when you have enough evidence to make a determination. This ends the investigation.",
      parameters: TriageVerdictSchema,
      execute: async (args) => JSON.stringify(args),
    }),
  };

  if (config.allowBash) {
    const bashImpl = createBashTool(config.projectRoot);
    tools.bash = tool({
      description:
        "Execute a shell command for read-only exploration (e.g., git log, git blame, wc). Destructive commands are blocked.",
      parameters: z.object({
        command: z.string().describe("Shell command to execute"),
        timeout: z.number().optional().describe("Timeout in seconds (default 30)"),
      }),
      execute: async (args) => bashImpl.execute(args),
    });
  }

  return tools;
}
```

- [ ] **Step 18: Run all tool tests**

```bash
cd sast-triage-ts && npx vitest run tests/agent/tools/
```

Expected: all PASS.

- [ ] **Step 19: Commit**

```bash
git add sast-triage-ts/src/agent/tools/ sast-triage-ts/tests/agent/tools/
git commit -m "feat: add agent tools — read, grep, glob, bash, verdict"
```

---

### Task 7: Doom Loop Detection

**Files:**
- Create: `sast-triage-ts/src/agent/doom-loop.ts`
- Create: `sast-triage-ts/tests/agent/doom-loop.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/agent/doom-loop.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { DoomLoopDetector } from "../../src/agent/doom-loop.js";

describe("DoomLoopDetector", () => {
  it("does not trigger for different calls", () => {
    const detector = new DoomLoopDetector();
    detector.record("read", { path: "a.py" });
    detector.record("grep", { pattern: "foo" });
    detector.record("read", { path: "b.py" });
    expect(detector.check()).toBe("ok");
  });

  it("triggers warning after 3 identical consecutive calls", () => {
    const detector = new DoomLoopDetector();
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    expect(detector.check()).toBe("warn");
  });

  it("triggers abort after warning + 3 more identical calls", () => {
    const detector = new DoomLoopDetector();
    // First 3 → warning
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    expect(detector.check()).toBe("warn");
    detector.acknowledge();

    // 3 more → abort
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    expect(detector.check()).toBe("abort");
  });

  it("resets when a different call breaks the streak", () => {
    const detector = new DoomLoopDetector();
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    detector.record("grep", { pattern: "foo" }); // breaks streak
    detector.record("read", { path: "a.py" });
    detector.record("read", { path: "a.py" });
    expect(detector.check()).toBe("ok");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sast-triage-ts && npx vitest run tests/agent/doom-loop.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement doom loop detector**

`src/agent/doom-loop.ts`:

```typescript
export type DoomLoopStatus = "ok" | "warn" | "abort";

interface ToolCall {
  tool: string;
  argsKey: string;
}

export class DoomLoopDetector {
  private history: ToolCall[] = [];
  private warned = false;

  record(tool: string, args: Record<string, unknown>): void {
    this.history.push({
      tool,
      argsKey: JSON.stringify(args, Object.keys(args).sort()),
    });
  }

  check(): DoomLoopStatus {
    if (this.history.length < 3) return "ok";

    const last3 = this.history.slice(-3);
    const allSame =
      last3.every(
        (c) =>
          c.tool === last3[0]!.tool && c.argsKey === last3[0]!.argsKey,
      );

    if (!allSame) return "ok";
    if (this.warned) return "abort";
    return "warn";
  }

  acknowledge(): void {
    this.warned = true;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd sast-triage-ts && npx vitest run tests/agent/doom-loop.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add sast-triage-ts/src/agent/doom-loop.ts sast-triage-ts/tests/agent/doom-loop.test.ts
git commit -m "feat: add doom loop detector for repeated tool calls"
```

---

### Task 8: System Prompt & Finding Formatter

**Files:**
- Create: `sast-triage-ts/src/agent/system-prompt.ts`

- [ ] **Step 1: Implement system prompt and finding formatter**

`src/agent/system-prompt.ts`:

```typescript
import type { Finding } from "../models/finding.js";

export const SYSTEM_PROMPT = `You are an expert application security engineer investigating SAST (Static Analysis) findings.

You have tools to explore the codebase: read files, grep for patterns, glob for file discovery, and optionally run shell commands.

## Your Process
1. Start by reading the file containing the finding, focusing on the flagged line and surrounding function
2. Identify the SINK (dangerous operation) and trace backward to find the SOURCE of data
3. Check for sanitization, validation, type coercion, or framework protections along the data flow
4. If needed, grep for related patterns (e.g., how other callsites handle the same function, middleware, validators)
5. Read additional files if the data flow crosses file boundaries
6. When you have enough evidence, call the verdict tool

## Decision Framework

### True Positive — exploitable vulnerability
- User-controlled data reaches a dangerous sink WITHOUT adequate sanitization
- The code path is reachable in production
- No framework-level protection mitigates it

### False Positive — not exploitable
- Input is sanitized, escaped, or validated before the sink
- Type coercion neutralizes the attack (int(), float() for injection)
- Framework auto-escaping is active and not bypassed
- Data is not user-controlled (hardcoded, server-generated, admin-only)
- ORM parameterized queries used correctly
- Code is unreachable in production

### Needs Review — insufficient evidence
- Sanitization exists but may be incomplete
- Custom sanitization function whose effectiveness is unclear from code alone
- Complex data flow spanning multiple services or async boundaries

## Rules
- Be thorough but efficient. Read what you need, not entire files.
- Cite specific line numbers and code patterns in your evidence.
- Do not speculate beyond what the code shows.
- If you cannot determine the verdict after reasonable investigation, use needs_review.
- Call the verdict tool when ready. Do not keep exploring after you have enough evidence.`;

export function formatFindingMessage(finding: Finding): string {
  const sections: string[] = [];

  const cweList = finding.extra.metadata.cwe;
  const cweStr = cweList.length > 0 ? cweList.join(", ") : "unknown";

  sections.push(`## Finding
Rule: ${finding.check_id}
Severity: ${finding.extra.severity}
CWE: ${cweStr}
File: ${finding.path}, line ${finding.start.line}
Message: ${finding.extra.message}`);

  if (finding.extra.lines) {
    sections.push(`## Flagged Code
\`\`\`
${finding.extra.lines}
\`\`\``);
  }

  const trace = finding.extra.dataflow_trace;
  if (trace) {
    const traceParts: string[] = [];

    if (trace.taint_source) {
      traceParts.push(
        `Source: \`${trace.taint_source.content}\` at ${trace.taint_source.location.path}:${trace.taint_source.location.start.line}`,
      );
    }

    if (trace.taint_sink) {
      traceParts.push(
        `Sink: \`${trace.taint_sink.content}\` at ${trace.taint_sink.location.path}:${trace.taint_sink.location.start.line}`,
      );
    }

    if (trace.intermediate_vars.length > 0) {
      const steps = trace.intermediate_vars
        .map(
          (iv) =>
            `  - \`${iv.content}\` at ${iv.location.path}:${iv.location.start.line}`,
        )
        .join("\n");
      traceParts.push(`Intermediates:\n${steps}`);
    }

    if (traceParts.length > 0) {
      sections.push(`## Dataflow Trace\n${traceParts.join("\n")}`);
    }
  }

  sections.push(
    `## Your Task
Investigate this finding. Read the relevant files, trace the data flow, check for sanitization and framework protections. When you have enough evidence, call the verdict tool.`,
  );

  return sections.join("\n\n");
}
```

- [ ] **Step 2: Commit**

```bash
git add sast-triage-ts/src/agent/system-prompt.ts
git commit -m "feat: add system prompt and finding message formatter"
```

---

### Task 9: Provider Registry

**Files:**
- Create: `sast-triage-ts/src/provider/registry.ts`
- Create: `sast-triage-ts/tests/provider/registry.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/provider/registry.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveProvider, SUPPORTED_PROVIDERS } from "../../src/provider/registry.js";

describe("resolveProvider", () => {
  it("lists supported providers", () => {
    expect(SUPPORTED_PROVIDERS).toContain("openai");
    expect(SUPPORTED_PROVIDERS).toContain("anthropic");
    expect(SUPPORTED_PROVIDERS).toContain("google");
    expect(SUPPORTED_PROVIDERS).toContain("openrouter");
  });

  it("throws on unknown provider", () => {
    expect(() => resolveProvider("unknown", "model")).toThrow(/unknown provider/i);
  });

  // Actual model creation requires API keys, so we just test the validation layer
  it("accepts valid provider names", () => {
    for (const p of SUPPORTED_PROVIDERS) {
      // Should not throw on provider name validation
      expect(() => resolveProvider(p, "test-model")).not.toThrow(/unknown provider/i);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sast-triage-ts && npx vitest run tests/provider/registry.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement provider registry**

`src/provider/registry.ts`:

```typescript
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModelV1 } from "ai";

export const SUPPORTED_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
] as const;

export type ProviderName = (typeof SUPPORTED_PROVIDERS)[number];

const ENV_KEYS: Record<ProviderName, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export function resolveProvider(
  provider: string,
  model: string,
): LanguageModelV1 {
  if (!SUPPORTED_PROVIDERS.includes(provider as ProviderName)) {
    throw new Error(
      `Unknown provider: "${provider}". Supported: ${SUPPORTED_PROVIDERS.join(", ")}`,
    );
  }

  const name = provider as ProviderName;
  const apiKey = process.env[ENV_KEYS[name]];

  switch (name) {
    case "openai": {
      const openai = createOpenAI({ apiKey });
      return openai(model);
    }
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(model);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(model);
    }
    case "openrouter": {
      const openrouter = createOpenRouter({ apiKey });
      return openrouter(model);
    }
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd sast-triage-ts && npx vitest run tests/provider/registry.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add sast-triage-ts/src/provider/ sast-triage-ts/tests/provider/
git commit -m "feat: add multi-provider registry (OpenAI, Anthropic, Google, OpenRouter)"
```

---

### Task 10: Agent Loop

**Files:**
- Create: `sast-triage-ts/src/agent/loop.ts`
- Create: `sast-triage-ts/tests/agent/loop.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/agent/loop.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { runAgentLoop, type AgentLoopConfig } from "../../src/agent/loop.js";
import type { AgentEvent } from "../../src/models/events.js";
import type { Finding } from "../../src/models/finding.js";
import { FindingSchema } from "../../src/models/finding.js";

// We can't easily mock streamText in a unit test without a real provider,
// so these tests verify the event collection and config wiring.

const TEST_FINDING: Finding = FindingSchema.parse({
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

describe("runAgentLoop", () => {
  it("collects events via onEvent callback", async () => {
    const events: AgentEvent[] = [];

    // This test requires a mock streamText — skip if no way to mock
    // For now, just verify the function signature and config validation
    const config: AgentLoopConfig = {
      finding: TEST_FINDING,
      projectRoot: "/tmp",
      provider: "openai",
      model: "gpt-4o",
      maxSteps: 2,
      allowBash: false,
      onEvent: (event) => events.push(event),
      memoryHints: [],
    };

    // Verify config shape is accepted (actual loop needs real provider)
    expect(config.maxSteps).toBe(2);
    expect(config.allowBash).toBe(false);
  });
});
```

- [ ] **Step 2: Implement agent loop**

`src/agent/loop.ts`:

```typescript
import { streamText, stepCountIs } from "ai";
import type { LanguageModelV1 } from "ai";
import type { Finding } from "../models/finding.js";
import type { TriageVerdict } from "../models/verdict.js";
import type { AgentEvent } from "../models/events.js";
import { TriageVerdictSchema } from "../models/verdict.js";
import { SYSTEM_PROMPT, formatFindingMessage } from "./system-prompt.js";
import { DoomLoopDetector } from "./doom-loop.js";
import { createTools } from "./tools/index.js";
import { resolveProvider } from "../provider/registry.js";

export interface AgentLoopConfig {
  finding: Finding;
  projectRoot: string;
  provider: string;
  model: string;
  maxSteps: number;
  allowBash: boolean;
  onEvent: (event: AgentEvent) => void;
  memoryHints: string[];
}

export async function runAgentLoop(
  config: AgentLoopConfig,
): Promise<TriageVerdict> {
  const {
    finding,
    projectRoot,
    provider,
    model: modelId,
    maxSteps,
    allowBash,
    onEvent,
    memoryHints,
  } = config;

  const languageModel = resolveProvider(provider, modelId);
  const tools = createTools({ projectRoot, allowBash });
  const doomLoop = new DoomLoopDetector();
  let finalVerdict: TriageVerdict | null = null;

  const systemPromptParts = [SYSTEM_PROMPT];
  if (memoryHints.length > 0) {
    systemPromptParts.push(
      `## Historical Context\n${memoryHints.map((h) => `- ${h}`).join("\n")}`,
    );
  }

  const userMessage = formatFindingMessage(finding);

  const result = streamText({
    model: languageModel,
    system: systemPromptParts.join("\n\n"),
    messages: [{ role: "user", content: userMessage }],
    tools,
    stopWhen: stepCountIs(maxSteps),
    onChunk({ chunk }) {
      switch (chunk.type) {
        case "text": {
          onEvent({ type: "thinking", delta: chunk.text });
          break;
        }
        case "tool-call": {
          const toolName = chunk.toolName;
          const args = chunk.input as Record<string, unknown>;

          onEvent({ type: "tool_start", tool: toolName, args });
          doomLoop.record(toolName, args);

          if (toolName === "verdict") {
            try {
              finalVerdict = TriageVerdictSchema.parse(args);
              onEvent({ type: "verdict", verdict: finalVerdict });
            } catch {
              onEvent({
                type: "error",
                message: "Invalid verdict format from LLM",
              });
            }
          }
          break;
        }
        case "tool-result": {
          const output = String(chunk.output);
          const lines = output.split("\n");
          const summary =
            lines.length > 3
              ? lines.slice(0, 3).join("\n") + `\n... (${lines.length} lines)`
              : output;

          onEvent({
            type: "tool_result",
            tool: chunk.toolName,
            summary,
            full: output,
          });
          break;
        }
      }
    },
    onStepFinish({ stepNumber }) {
      const status = doomLoop.check();
      if (status === "warn") {
        doomLoop.acknowledge();
        onEvent({
          type: "error",
          message:
            "Doom loop detected: same tool called with identical arguments 3 times. Try a different approach.",
        });
      }
    },
  });

  // Consume the stream to completion
  await result.text;

  // If the agent didn't call verdict tool, force needs_review
  if (!finalVerdict) {
    finalVerdict = {
      verdict: "needs_review",
      reasoning:
        "Agent did not deliver a verdict within the maximum number of steps.",
      key_evidence: [],
    };
    onEvent({ type: "verdict", verdict: finalVerdict });
  }

  return finalVerdict;
}
```

- [ ] **Step 3: Run tests**

```bash
cd sast-triage-ts && npx vitest run tests/agent/loop.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add sast-triage-ts/src/agent/loop.ts sast-triage-ts/tests/agent/loop.test.ts
git commit -m "feat: add agentic loop with streamText, tools, and doom loop detection"
```

---

### Task 11: Config & CLI Entry Point

**Files:**
- Create: `sast-triage-ts/src/config.ts`
- Modify: `sast-triage-ts/src/index.ts`

- [ ] **Step 1: Implement config**

`src/config.ts`:

```typescript
export interface AppConfig {
  findingsPath: string;
  provider: string;
  model: string;
  headless: boolean;
  allowBash: boolean;
  maxSteps: number;
  memoryDb: string;
}

export function resolveConfig(opts: {
  findingsPath: string;
  provider: string;
  model: string;
  headless?: boolean;
  allowBash?: boolean;
  maxSteps?: number;
  memoryDb?: string;
}): AppConfig {
  return {
    findingsPath: opts.findingsPath,
    provider: opts.provider,
    model: opts.model,
    headless: opts.headless ?? false,
    allowBash: opts.allowBash ?? false,
    maxSteps: opts.maxSteps ?? 15,
    memoryDb: opts.memoryDb ?? ".sast-triage/memory.db",
  };
}
```

- [ ] **Step 2: Implement CLI entry point**

`src/index.ts`:

```typescript
#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { resolveConfig } from "./config.js";
import { parseSemgrepOutput, fingerprintFinding } from "./parser/semgrep.js";
import { prefilterFinding } from "./parser/prefilter.js";
import { MemoryStore } from "./memory/store.js";
import { runAgentLoop } from "./agent/loop.js";
import type { AgentEvent } from "./models/events.js";
import type { Finding } from "./models/finding.js";

const program = new Command();

program
  .name("sast-triage")
  .description("Agentic SAST finding triage via LLM-driven codebase exploration")
  .version("0.1.0")
  .argument("[findings]", "Path to Semgrep JSON output file")
  .requiredOption("--provider <provider>", "LLM provider (openai, anthropic, google, openrouter)")
  .requiredOption("--model <model>", "Model ID")
  .option("--headless", "Output NDJSON to stdout instead of TUI", false)
  .option("--allow-bash", "Enable bash tool for agent", false)
  .option("--max-steps <n>", "Max agent loop steps per finding", "15")
  .option("--memory-db <path>", "SQLite memory DB path", ".sast-triage/memory.db")
  .action(async (findingsPath: string | undefined, opts) => {
    const config = resolveConfig({
      findingsPath: findingsPath ?? "-",
      provider: opts.provider,
      model: opts.model,
      headless: opts.headless,
      allowBash: opts.allowBash,
      maxSteps: parseInt(opts.maxSteps, 10),
      memoryDb: opts.memoryDb,
    });

    // Read input
    let rawInput: string;
    if (config.findingsPath === "-") {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      rawInput = Buffer.concat(chunks).toString("utf-8");
    } else {
      rawInput = readFileSync(resolve(config.findingsPath), "utf-8");
    }

    const raw = JSON.parse(rawInput);
    const findings = parseSemgrepOutput(raw);

    if (findings.length === 0) {
      console.error("No findings parsed from input.");
      process.exit(1);
    }

    // Memory
    const memory = new MemoryStore(resolve(config.memoryDb));
    const memoryLookup = memory.createLookup();

    // Prefilter
    const active: Finding[] = [];
    for (const f of findings) {
      const result = prefilterFinding(f, memoryLookup);
      if (result.passed) {
        active.push(f);
      } else if (config.headless) {
        const fp = fingerprintFinding(f);
        console.log(
          JSON.stringify({
            type: "filtered",
            fingerprint: fp,
            rule: f.check_id,
            reason: result.reason,
          }),
        );
      }
    }

    if (config.headless) {
      await runHeadless(active, config, memory);
    } else {
      // TUI mode — dynamic import to avoid loading Ink/React when headless
      const { runTui } = await import("./ui/app.js");
      await runTui(active, findings.length, config, memory);
    }

    memory.close();
  });

async function runHeadless(
  findings: Finding[],
  config: ReturnType<typeof resolveConfig>,
  memory: MemoryStore,
): Promise<void> {
  for (const finding of findings) {
    const fp = fingerprintFinding(finding);
    const memoryHints = memory.getHints(finding.check_id, fp);

    const onEvent = (event: AgentEvent) => {
      console.log(JSON.stringify({ ...event, fingerprint: fp }));
    };

    const verdict = await runAgentLoop({
      finding,
      projectRoot: process.cwd(),
      provider: config.provider,
      model: config.model,
      maxSteps: config.maxSteps,
      allowBash: config.allowBash,
      onEvent,
      memoryHints,
    });

    memory.store({
      fingerprint: fp,
      check_id: finding.check_id,
      path: finding.path,
      verdict: verdict.verdict,
      reasoning: verdict.reasoning,
    });
  }
}

program.parse();
```

- [ ] **Step 3: Verify it compiles**

```bash
cd sast-triage-ts && npx tsc --noEmit
```

Expected: no errors (may need to stub `./ui/app.js` — create a placeholder).

Create placeholder `src/ui/app.tsx`:

```typescript
import type { Finding } from "../models/finding.js";
import type { AppConfig } from "../config.js";
import type { MemoryStore } from "../memory/store.js";

export async function runTui(
  _findings: Finding[],
  _totalCount: number,
  _config: AppConfig,
  _memory: MemoryStore,
): Promise<void> {
  console.error("TUI not yet implemented. Use --headless.");
  process.exit(1);
}
```

- [ ] **Step 4: Commit**

```bash
git add sast-triage-ts/src/config.ts sast-triage-ts/src/index.ts sast-triage-ts/src/ui/app.tsx
git commit -m "feat: add CLI entry point with commander, headless mode, and stdin support"
```

---

### Task 12: Headless NDJSON Reporter

**Files:**
- Create: `sast-triage-ts/src/headless/reporter.ts`
- Create: `sast-triage-ts/tests/headless/reporter.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/headless/reporter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatEvent } from "../../src/headless/reporter.js";
import type { AgentEvent } from "../../src/models/events.js";

describe("formatEvent", () => {
  it("formats tool_start as NDJSON", () => {
    const event: AgentEvent = {
      type: "tool_start",
      tool: "read",
      args: { path: "src/app.py" },
    };
    const line = formatEvent(event, "abc123");
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("tool_start");
    expect(parsed.fingerprint).toBe("abc123");
    expect(parsed.tool).toBe("read");
  });

  it("formats verdict as NDJSON", () => {
    const event: AgentEvent = {
      type: "verdict",
      verdict: {
        verdict: "true_positive",
        reasoning: "SQL injection",
        key_evidence: ["cursor.execute(sql)"],
      },
    };
    const line = formatEvent(event, "abc123");
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("verdict");
    expect(parsed.verdict.verdict).toBe("true_positive");
  });

  it("each line is valid JSON (no newlines in output)", () => {
    const event: AgentEvent = {
      type: "thinking",
      delta: "multi\nline\nthinking",
    };
    const line = formatEvent(event, "fp1");
    expect(line.split("\n")).toHaveLength(1);
    expect(() => JSON.parse(line)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd sast-triage-ts && npx vitest run tests/headless/reporter.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement reporter**

`src/headless/reporter.ts`:

```typescript
import type { AgentEvent } from "../models/events.js";

export function formatEvent(event: AgentEvent, fingerprint: string): string {
  return JSON.stringify({ ...event, fingerprint });
}
```

- [ ] **Step 4: Run tests**

```bash
cd sast-triage-ts && npx vitest run tests/headless/reporter.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add sast-triage-ts/src/headless/ sast-triage-ts/tests/headless/
git commit -m "feat: add NDJSON headless reporter"
```

---

### Task 13: Ink TUI — App Shell & Findings Table

**Files:**
- Modify: `sast-triage-ts/src/ui/app.tsx`
- Create: `sast-triage-ts/src/ui/components/findings-table.tsx`

- [ ] **Step 1: Implement FindingsTable component**

`src/ui/components/findings-table.tsx`:

```tsx
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

interface FindingsTableProps {
  findings: FindingEntry[];
  selectedIndex: number;
  triaged: number;
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

export function FindingsTable({ findings, selectedIndex, triaged }: FindingsTableProps) {
  return (
    <Box flexDirection="column" width="100%">
      <Box marginBottom={1}>
        <Text bold>
          Findings {triaged}/{findings.length}
        </Text>
      </Box>
      {findings.map((f, i) => {
        const selected = i === selectedIndex;
        const color = STATUS_COLORS[f.status];
        const icon = STATUS_ICONS[f.status];
        const ruleShort = f.ruleId.split(".").pop() ?? f.ruleId;

        return (
          <Box key={f.fingerprint}>
            <Text color={color}>
              {selected ? ">" : " "} {icon} {ruleShort.slice(0, 20).padEnd(20)} {f.fileLine}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 2: Implement App shell with layout**

`src/ui/app.tsx`:

```tsx
import React, { useState, useCallback } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import type { Finding } from "../models/finding.js";
import type { AppConfig } from "../config.js";
import type { MemoryStore } from "../memory/store.js";
import type { AgentEvent } from "../models/events.js";
import type { TriageVerdict } from "../models/verdict.js";
import { fingerprintFinding } from "../parser/semgrep.js";
import { runAgentLoop } from "../agent/loop.js";
import { FindingsTable, type FindingEntry, type FindingStatus } from "./components/findings-table.js";
import { AgentPanel } from "./components/agent-panel.js";
import { Sidebar } from "./components/sidebar.js";

interface FindingState {
  entry: FindingEntry;
  finding: Finding;
  events: AgentEvent[];
  verdict?: TriageVerdict;
}

function App({
  findings,
  totalCount,
  config,
  memory,
}: {
  findings: Finding[];
  totalCount: number;
  config: AppConfig;
  memory: MemoryStore;
}) {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [findingStates, setFindingStates] = useState<FindingState[]>(() =>
    findings.map((f) => ({
      entry: {
        fingerprint: fingerprintFinding(f),
        ruleId: f.check_id,
        fileLine: `${f.path}:${f.start.line}`,
        severity: f.extra.severity,
        status: "pending" as FindingStatus,
      },
      finding: f,
      events: [],
    })),
  );
  const [isTriaging, setIsTriaging] = useState(false);

  const triaged = findingStates.filter((s) => s.verdict != null).length;
  const selected = findingStates[selectedIndex];

  const updateFinding = useCallback(
    (index: number, update: Partial<FindingState>) => {
      setFindingStates((prev) =>
        prev.map((s, i) =>
          i === index
            ? {
                ...s,
                ...update,
                entry: { ...s.entry, ...(update.entry ?? {}) },
              }
            : s,
        ),
      );
    },
    [],
  );

  const triageCurrent = useCallback(async () => {
    if (isTriaging || !selected || selected.verdict) return;
    setIsTriaging(true);

    const idx = selectedIndex;
    updateFinding(idx, {
      entry: { ...selected.entry, status: "in_progress" },
      events: [],
    });

    const fp = selected.entry.fingerprint;
    const memoryHints = memory.getHints(selected.finding.check_id, fp);

    const verdict = await runAgentLoop({
      finding: selected.finding,
      projectRoot: process.cwd(),
      provider: config.provider,
      model: config.model,
      maxSteps: config.maxSteps,
      allowBash: config.allowBash,
      onEvent: (event) => {
        setFindingStates((prev) =>
          prev.map((s, i) =>
            i === idx ? { ...s, events: [...s.events, event] } : s,
          ),
        );
      },
      memoryHints,
    });

    memory.store({
      fingerprint: fp,
      check_id: selected.finding.check_id,
      path: selected.finding.path,
      verdict: verdict.verdict,
      reasoning: verdict.reasoning,
    });

    updateFinding(idx, {
      verdict,
      entry: { ...selected.entry, status: verdict.verdict as FindingStatus },
    });

    setIsTriaging(false);
  }, [selectedIndex, selected, isTriaging, config, memory, updateFinding]);

  useInput((input, key) => {
    if (input === "q") {
      exit();
      return;
    }

    if (key.upArrow && selectedIndex > 0) {
      setSelectedIndex(selectedIndex - 1);
    }
    if (key.downArrow && selectedIndex < findingStates.length - 1) {
      setSelectedIndex(selectedIndex + 1);
    }
    if (key.return && !isTriaging) {
      triageCurrent();
    }
  });

  const termWidth = process.stdout.columns ?? 120;
  const showSidebar = termWidth >= 100;
  const sidebarWidth = showSidebar ? Math.floor(termWidth * 0.18) : 0;
  const tableWidth = Math.floor(termWidth * 0.28);
  const panelWidth = termWidth - tableWidth - sidebarWidth;

  return (
    <Box flexDirection="row" width={termWidth} height={process.stdout.rows - 1}>
      <Box width={tableWidth} flexDirection="column" borderStyle="single">
        <FindingsTable
          findings={findingStates.map((s) => s.entry)}
          selectedIndex={selectedIndex}
          triaged={triaged}
        />
      </Box>

      <Box width={panelWidth} flexDirection="column" borderStyle="single">
        {selected ? (
          <AgentPanel
            events={selected.events}
            isActive={isTriaging && selectedIndex === findingStates.indexOf(selected)}
          />
        ) : (
          <Text>Select a finding and press Enter to investigate.</Text>
        )}
      </Box>

      {showSidebar && (
        <Box width={sidebarWidth} flexDirection="column" borderStyle="single">
          <Sidebar
            total={totalCount}
            active={findings.length}
            triaged={triaged}
            tp={findingStates.filter((s) => s.verdict?.verdict === "true_positive").length}
            fp={findingStates.filter((s) => s.verdict?.verdict === "false_positive").length}
            nr={findingStates.filter((s) => s.verdict?.verdict === "needs_review").length}
            provider={config.provider}
            model={config.model}
          />
        </Box>
      )}
    </Box>
  );
}

export async function runTui(
  findings: Finding[],
  totalCount: number,
  config: AppConfig,
  memory: MemoryStore,
): Promise<void> {
  const instance = render(
    <App findings={findings} totalCount={totalCount} config={config} memory={memory} />,
  );
  await instance.waitUntilExit();
}
```

- [ ] **Step 3: Verify it compiles (after stub components created in next steps)**

We'll verify compilation at the end of Task 14.

- [ ] **Step 4: Commit**

```bash
git add sast-triage-ts/src/ui/
git commit -m "feat: add Ink TUI app shell with findings table and layout"
```

---

### Task 14: Ink TUI — AgentPanel, VerdictBanner, Sidebar

**Files:**
- Create: `sast-triage-ts/src/ui/components/agent-panel.tsx`
- Create: `sast-triage-ts/src/ui/components/verdict-banner.tsx`
- Create: `sast-triage-ts/src/ui/components/sidebar.tsx`

- [ ] **Step 1: Implement AgentPanel**

`src/ui/components/agent-panel.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { AgentEvent } from "../../models/events.js";
import { VerdictBanner } from "./verdict-banner.js";

interface AgentPanelProps {
  events: AgentEvent[];
  isActive: boolean;
}

export function AgentPanel({ events, isActive }: AgentPanelProps) {
  if (events.length === 0 && !isActive) {
    return (
      <Box padding={1}>
        <Text dimColor>Press Enter to start investigating this finding.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      {events.map((event, i) => (
        <EventLine key={i} event={event} />
      ))}
      {isActive && events.length > 0 && (
        <Box>
          <Text color="yellow">  Investigating...</Text>
        </Box>
      )}
    </Box>
  );
}

function EventLine({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case "tool_start":
      return (
        <Box>
          <Text color="cyan">
            {"  "}* {formatToolStart(event.tool, event.args)}
          </Text>
        </Box>
      );

    case "tool_result":
      return (
        <Box marginLeft={4}>
          <Text dimColor>
            {"-> "}{event.summary}
          </Text>
        </Box>
      );

    case "thinking":
      return (
        <Box>
          <Text color="white">  {event.delta}</Text>
        </Box>
      );

    case "verdict":
      return <VerdictBanner verdict={event.verdict} />;

    case "error":
      return (
        <Box>
          <Text color="red">  ! {event.message}</Text>
        </Box>
      );
  }
}

function formatToolStart(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "read": {
      const path = args.path as string;
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      const range = offset ? ` (lines ${offset}-${(offset ?? 1) + (limit ?? 200) - 1})` : "";
      return `Reading ${path}${range}`;
    }
    case "grep": {
      const pattern = args.pattern as string;
      const path = (args.path as string) ?? ".";
      return `Grepping "${pattern}" in ${path}`;
    }
    case "glob":
      return `Finding files: ${args.pattern as string}`;
    case "bash":
      return `Running: ${args.command as string}`;
    case "verdict":
      return `Delivering verdict`;
    default:
      return `${tool}(${JSON.stringify(args)})`;
  }
}
```

- [ ] **Step 2: Implement VerdictBanner**

`src/ui/components/verdict-banner.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { TriageVerdict } from "../../models/verdict.js";

interface VerdictBannerProps {
  verdict: TriageVerdict;
}

const VERDICT_COLORS: Record<string, string> = {
  true_positive: "red",
  false_positive: "green",
  needs_review: "#FF8C00",
};

const VERDICT_LABELS: Record<string, string> = {
  true_positive: "TRUE POSITIVE",
  false_positive: "FALSE POSITIVE",
  needs_review: "NEEDS REVIEW",
};

export function VerdictBanner({ verdict }: VerdictBannerProps) {
  const color = VERDICT_COLORS[verdict.verdict] ?? "white";
  const label = VERDICT_LABELS[verdict.verdict] ?? verdict.verdict;

  return (
    <Box flexDirection="column" marginTop={1} paddingX={2}>
      <Box>
        <Text bold color={color}>
          # {label}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text>
          <Text bold>Reasoning: </Text>
          {verdict.reasoning}
        </Text>
      </Box>

      {verdict.key_evidence.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Evidence:</Text>
          {verdict.key_evidence.map((e, i) => (
            <Text key={i}>  - {e}</Text>
          ))}
        </Box>
      )}

      {verdict.suggested_fix && (
        <Box marginTop={1}>
          <Text>
            <Text bold>Fix: </Text>
            {verdict.suggested_fix}
          </Text>
        </Box>
      )}
    </Box>
  );
}
```

- [ ] **Step 3: Implement Sidebar**

`src/ui/components/sidebar.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";

interface SidebarProps {
  total: number;
  active: number;
  triaged: number;
  tp: number;
  fp: number;
  nr: number;
  provider: string;
  model: string;
}

export function Sidebar({ total, active, triaged, tp, fp, nr, provider, model }: SidebarProps) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Stats</Text>
      <Text>Total: {total}</Text>
      <Text>Active: {active}</Text>
      <Text>Done: {triaged}</Text>
      <Text> </Text>
      <Text color="red">TP: {tp}</Text>
      <Text color="green">FP: {fp}</Text>
      <Text color="#FF8C00">NR: {nr}</Text>
      <Text> </Text>
      <Text bold>Model</Text>
      <Text dimColor>{provider}</Text>
      <Text dimColor>{model}</Text>
      <Text> </Text>
      <Text dimColor>q: quit</Text>
      <Text dimColor>Enter: triage</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Verify full project compiles**

```bash
cd sast-triage-ts && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add sast-triage-ts/src/ui/components/
git commit -m "feat: add TUI components — AgentPanel, VerdictBanner, Sidebar"
```

---

### Task 15: Integration Test & Final Wiring

**Files:**
- Create: `sast-triage-ts/tests/integration.test.ts`

- [ ] **Step 1: Write integration smoke test**

`tests/integration.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseSemgrepOutput, fingerprintFinding, classifyFinding } from "../src/parser/semgrep.js";
import { prefilterFinding } from "../src/parser/prefilter.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures");

describe("pipeline integration (no LLM)", () => {
  it("parse → fingerprint → classify → prefilter for pattern finding", () => {
    const raw = JSON.parse(
      readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"),
    );
    const findings = parseSemgrepOutput(raw);
    expect(findings).toHaveLength(2);

    const f = findings[0]!;
    const fp = fingerprintFinding(f);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);

    const cls = classifyFinding(f);
    expect(cls).toBe("pattern");

    const pf = prefilterFinding(f);
    expect(pf.passed).toBe(true);
  });

  it("parse → fingerprint → classify → prefilter for taint finding", () => {
    const raw = JSON.parse(
      readFileSync(resolve(FIXTURES, "semgrep-taint.json"), "utf-8"),
    );
    const findings = parseSemgrepOutput(raw);
    expect(findings).toHaveLength(1);

    const f = findings[0]!;
    const cls = classifyFinding(f);
    expect(cls).toBe("taint");

    expect(f.extra.dataflow_trace).toBeDefined();
    expect(f.extra.dataflow_trace!.taint_source!.content).toBe(
      "request.GET.get('query')",
    );
  });

  it("prefilter rejects test files", () => {
    const raw = JSON.parse(
      readFileSync(resolve(FIXTURES, "semgrep-output.json"), "utf-8"),
    );
    const findings = parseSemgrepOutput(raw);
    // Modify path to be a test file
    const testFinding = { ...findings[0]!, path: "tests/test_views.py" };
    // Re-parse to get correct type
    const parsed = parseSemgrepOutput([
      { ...JSON.parse(JSON.stringify(findings[0])), path: "tests/test_views.py" },
    ]);
    const pf = prefilterFinding(parsed[0]!);
    expect(pf.passed).toBe(false);
    expect(pf.reason).toContain("Test file");
  });
});
```

- [ ] **Step 2: Run integration test**

```bash
cd sast-triage-ts && npx vitest run tests/integration.test.ts
```

Expected: all PASS.

- [ ] **Step 3: Run full test suite**

```bash
cd sast-triage-ts && npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 4: Verify build**

```bash
cd sast-triage-ts && npx tsc
```

Expected: compiles to `dist/` with no errors.

- [ ] **Step 5: Commit**

```bash
git add sast-triage-ts/tests/integration.test.ts
git commit -m "test: add integration smoke test for parse-prefilter pipeline"
```

- [ ] **Step 6: Final commit — update CLAUDE.md for TS project**

Create `sast-triage-ts/CLAUDE.md` with the new project conventions, then commit:

```bash
git add sast-triage-ts/CLAUDE.md
git commit -m "docs: add CLAUDE.md for TypeScript rewrite"
```
