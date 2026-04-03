# Feature Parity: TS Rewrite Enhancements

**Date:** 2026-04-04
**Branch:** feat/TS-rewrite
**Scope:** 9 features bringing the TS rewrite closer to Python main + new capabilities

---

## 1. Event System Extensions

### New Event Types

Added to the `AgentEvent` discriminated union in `src/models/events.ts`:

```typescript
| {
    type: "permission_request";
    path: string;
    directory: string;
    resolve: (decision: "once" | "always" | "deny") => void;
  }
| {
    type: "usage";
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
  }
| {
    type: "followup_start";
    question: string;
  }
```

### AgentLoopConfig Additions

```typescript
export interface AgentLoopConfig {
  // ... existing fields ...
  reasoningEffort?: "low" | "medium" | "high";
  allowedPaths?: string[];
}
```

---

## 2. Workspace-Scoped File Access with Interactive Permissions

Inspired by Opencode's deferred-promise permission model.

### Flow

1. `read` tool encounters a path outside `projectRoot`
2. Checks `allowedPaths` (TOML config) + session-approved directories
3. If no match: emits `permission_request` event with a `resolve` callback
4. Tool execution **blocks** on the resolve promise
5. TUI shows inline prompt: `[Allow once] [Allow dir always] [Deny]`
6. User decision:
   - **"once"**: resolve, tool continues, no persistence
   - **"always"**: resolve, parent directory added to in-memory session set (cleared on restart)
   - **"deny"**: resolve, tool receives error: `"Access denied: {path} — outside project root. User denied access."`
7. Headless mode: checks `allowedPaths` from TOML, denies if not listed

### TOML Config

```toml
[workspace]
allowed_paths = ["/path/to/extra/dir", "/another/dir"]
```

### Implementation

- `read.ts`: New params `isPathAllowed: (path: string) => boolean` and `requestPermission: (path: string) => Promise<"once" | "always" | "deny">`
- `loop.ts`: Constructs permission callback, manages session-approved set
- `app.tsx`: Renders permission prompt when event received, calls `resolve()`
- `grep`/`glob` tools: No change — they scope to `projectRoot` via ripgrep's search dir

---

## 3. Unified Reasoning Effort

Single `reasoningEffort: "low" | "medium" | "high"` config mapped to provider-specific APIs via AI SDK v5's `providerOptions`.

### Mapping Table

| Effort | OpenAI | Anthropic | Google | OpenRouter |
|--------|--------|-----------|--------|------------|
| `low` | `reasoningEffort: "low"` | `thinking: { type: "enabled", budgetTokens: 4096 }` | `thinkingConfig: { thinkingBudget: 4096 }` | `reasoningEffort: "low"` |
| `medium` | `reasoningEffort: "medium"` | `thinking: { type: "enabled", budgetTokens: 10000 }` | `thinkingConfig: { thinkingBudget: 10000 }` | `reasoningEffort: "medium"` |
| `high` | `reasoningEffort: "high"` | `thinking: { type: "enabled", budgetTokens: 32000 }` | `thinkingConfig: { thinkingBudget: 32000 }` | `reasoningEffort: "high"` |

### New File: `src/provider/reasoning.ts`

```typescript
export function resolveProviderOptions(
  provider: string,
  effort: "low" | "medium" | "high"
): Record<string, unknown>
```

Returns provider-namespaced object for `streamText({ providerOptions })`.

### Integration Points

- **TOML**: `reasoning_effort` under `[provider]`
- **CLI**: `--effort <low|medium|high>` flag
- **Setup screen**: New optional step after model selection
- **`loop.ts`**: Passes `providerOptions` to `streamText()` when effort is set

---

## 4. Token Usage Logging

### Emission

In `loop.ts`, after stream completion:

```typescript
const totalUsage = await result.totalUsage;
config.onEvent({
  type: "usage",
  inputTokens: totalUsage.inputTokens ?? 0,
  outputTokens: totalUsage.outputTokens ?? 0,
  totalTokens: totalUsage.totalTokens ?? 0,
  reasoningTokens: totalUsage.reasoningTokens,
  cachedInputTokens: totalUsage.cachedInputTokens,
});
```

Uses `result.totalUsage` (cumulative across all multi-step tool calls), not `result.usage` (final step only).

### Display

- **Agent panel**: Brief dimmed usage line after verdict (e.g., `Tokens: 2.4k in / 1.1k out`)
- **Sidebar**: Per-finding usage for current finding, cumulative session total at bottom
- **Headless**: NDJSON event with fingerprint

### Session State

`app.tsx` accumulates `sessionUsage: { inputTokens: number; outputTokens: number; totalTokens: number }`. Each `usage` event adds to the running total.

---

## 5. Batch Audit Queue

### Selection Model

- **`Space`** — toggle selection on highlighted finding (`●` selected, ` ` unselected)
- **`a`** — select all actionable findings
- **`Enter`** — start batch audit on selected findings (or highlighted if none selected)

### Queue State

```typescript
interface QueueState {
  items: number[];        // indices into findingStates
  currentIndex: number;   // position in queue
  isRunning: boolean;
}
```

### Flow

1. User selects findings, presses Enter
2. Queue initialized with selected indices
3. Sequentially: triage `items[currentIndex]` → on verdict → increment → triage next
4. Completes when `currentIndex >= items.length`
5. **`Esc`** stops after current finding finishes (no mid-triage abort)

### Sidebar During Batch

```
Queue: 3/7
  ✓ rule-xss        FP
  ✓ rule-sqli       TP
  ▸ rule-ssrf       investigating...
    rule-path-trav
    rule-cmd-inj
```

Verdict labels color-coded: red (TP), green (FP), orange (NR). No percentages.

### Agent Panel

Shows events for current finding. Resets on queue advance. Previous findings' events preserved in `findingStates[idx].events` and viewable by navigating back.

---

## 6. Re-audit (`r`)

- **Guard**: Only available when current finding has a verdict
- **Behavior**: Clears `events` array and `verdict`, resets status to `in_progress`, runs `runAgentLoop()` fresh
- **During batch**: Re-audits current finding in-place, then continues queue
- **Agent panel**: Resets to show fresh investigation

---

## 7. Follow-up Question (`f`)

- **Guard**: Only available when current finding has a verdict

### Flow

1. Inline text input at bottom of agent panel
2. User types question, presses Enter
3. `followup_start` event emitted (rendered as `> User: {question}`)
4. New `streamText()` call via `src/agent/follow-up.ts`:
   - System prompt: conversational role, no structured output
   - Messages: finding context + previous verdict/reasoning (as assistant) + user question
   - No tools — pure chat
5. Response streams as `thinking` events appended after the separator
6. Multiple follow-ups accumulate in the same events array

### New File: `src/agent/follow-up.ts`

```typescript
export async function runFollowUp(config: {
  finding: Finding;
  previousVerdict: TriageVerdict;
  question: string;
  provider: string;
  model: string;
  onEvent: (event: AgentEvent) => void;
  apiKey?: string;
  baseUrl?: string;
  reasoningEffort?: "low" | "medium" | "high";
}): Promise<void>
```

---

## 8. Switch Provider (`Ctrl+p`)

- **Guard**: Ignored if batch queue is running
- **Behavior**: Returns to setup screen starting at provider step (skips trust)
- **Setup screen**: Supports partial re-entry via new `startStep` prop
- **On completion**: Config saved to TOML, returns to main screen
- **Existing verdicts preserved** — only future triage uses new provider

---

## 9. File Changes

### Modified Files

| File | Changes |
|------|---------|
| `src/models/events.ts` | Add `permission_request`, `usage`, `followup_start` event types |
| `src/agent/loop.ts` | Add `reasoningEffort`, `allowedPaths` to config; emit `usage`; pass permission callback; build `providerOptions` |
| `src/agent/tools/read.ts` | Replace hard-reject with permission request flow for out-of-root paths |
| `src/agent/tools/index.ts` | Pass permission callback through to read tool |
| `src/provider/registry.ts` | Export provider name constants for reasoning module |
| `src/config/project-config.ts` | Add `reasoningEffort` and `allowedPaths` to TOML schema |
| `src/config.ts` | Add `reasoningEffort`, `allowedPaths` to `AppConfig` |
| `src/index.ts` | Add `--effort` CLI flag |
| `src/ui/app.tsx` | Batch queue state, session usage, re-audit/follow-up/provider-switch handlers, permission prompt, keybindings (`Space`, `a`, `r`, `f`, `Ctrl+p`, `Esc`) |
| `src/ui/components/setup-screen.tsx` | Add reasoning effort step; `startStep` prop for partial re-entry |
| `src/ui/components/agent-panel.tsx` | Render `usage`, `followup_start`, permission events; follow-up text input |
| `src/ui/components/sidebar.tsx` | Queue progress, per-finding + session token usage |
| `src/ui/components/findings-table.tsx` | Multi-select (`Space` toggle, `a` select all), selection indicators |
| `src/headless/reporter.ts` | Handle new event types in NDJSON output |

### New Files

| File | Purpose |
|------|---------|
| `src/agent/follow-up.ts` | `runFollowUp()` — conversational follow-up via streamText (no tools) |
| `src/provider/reasoning.ts` | `resolveProviderOptions()` — unified effort → provider-specific mapping |

### New/Modified Tests

| File | Scope |
|------|-------|
| `tests/provider/reasoning.test.ts` | New — effort mapping for all 4 providers |
| `tests/agent/tools/read.test.ts` | Add permission flow cases (once, always, deny) |
| `tests/agent/loop.test.ts` | Usage event emission, reasoningEffort passthrough |
| `tests/agent/follow-up.test.ts` | New — follow-up message construction and streaming |
