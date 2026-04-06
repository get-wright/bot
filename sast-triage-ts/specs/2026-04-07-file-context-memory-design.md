# File-Level Context Memory for Cross-Finding Triage

## Problem

When multiple SAST findings exist in the same file, the agent re-does nearly identical work for each one. Measured on `extension/sidepanel.js` with 3 `insecure-document-method` findings:

- Finding #1 (line 417): 14 tool calls, discovers `escapeHtml()`, traces data through `background.js`, reads parsing chain
- Finding #2 (line 443): 13 tool calls, re-discovers `escapeHtml()`, re-reads `background.js`, re-traces same parsing chain
- Finding #3 (line 559): same pattern again

This wastes tokens, time, and — critically — the agent reasons from scratch each time instead of building on prior analysis. A wrong conclusion in finding #1 (the `escapeHtml` XSS false positive) cannot be corrected by cross-referencing what was learned.

## Goals

1. **Speed**: Eliminate redundant file reads and grep searches for sibling findings
2. **Accuracy**: Give the agent prior analysis context so it makes better-informed verdicts
3. **No anchoring bias**: Prior verdicts should inform, not dictate — the agent must be free to disagree

## Prior Art

| System | Approach | Scope | Limitations |
|--------|----------|-------|-------------|
| Semgrep Memories | Natural language memories from triage feedback | Rule + project | No file-level context, human-in-the-loop |
| OpenAI Codex Security | Pre-built repo-wide threat model | Repository | Expensive, overkill for file-level |
| AgenticSCR | Semantic memory (SAST rules + CWE tree) | Global knowledge | Not per-file, not session-aware |
| Slice | Pre-extracted interprocedural context via CodeQL + Tree-sitter | Call graph | Requires compilation toolchain |

None of these do **file-level, session-scoped context sharing** between findings. Our approach fills this gap.

## Design

### Architecture

```
Finding #1 in file X
    → Agent Loop (full exploration)
    → Verdict + Tool Calls + Accumulated Text
    → FileContextBuilder.extract(finding, result) → FileContext
    → Store in session map: filePath → FileContext

Finding #2 in file X
    → Agent Loop receives FileContext as system prompt section
    → Agent starts with knowledge of sanitizers, data sources, patterns
    → Fewer redundant reads, better-informed verdict
    → FileContextBuilder.merge(existing, new) → updated FileContext
```

### Component: FileContext

A structured summary of what was learned about a file during triage.

```typescript
interface FileContext {
  path: string;
  /** Sanitization/validation functions discovered (name, location, what they do) */
  sanitizers: string[];
  /** Data sources identified (user input, DB, API, hardcoded) */
  dataSources: string[];
  /** Framework protections observed (auto-escaping, CSRF tokens, ORM) */
  frameworkProtections: string[];
  /** Key code patterns relevant to security (e.g., "innerHTML used in 3 places") */
  patterns: string[];
  /** Prior verdicts in this file (line, verdict, one-line reason) */
  priorVerdicts: Array<{
    line: number;
    ruleShort: string;
    verdict: string;
    reason: string;
  }>;
}
```

### Component: FileContextBuilder

Extracts a `FileContext` from a completed triage result. Two strategies:

**Strategy A — LLM extraction (recommended)**: After the verdict, make one additional `generateObject` call asking the model to summarize what it learned about the file. The model already has all the context from its investigation — this is a cheap extraction step.

```typescript
async function extractFileContext(
  finding: Finding,
  result: AgentLoopResult,
  languageModel: LanguageModel,
  existingContext?: FileContext,
): Promise<FileContext>
```

The prompt:

> Based on your investigation of this file, extract the following for future reference:
> - Sanitization/validation functions you found (name + what they protect against)
> - Data sources you identified (where does user input enter?)
> - Framework protections you observed
> - Key security-relevant code patterns
>
> Be factual. Only include what you directly observed in the code.

**Strategy B — Heuristic extraction (fallback)**: Parse the tool call history to extract file paths read, grep patterns used, and combine with the verdict's key_evidence. No LLM call needed, but lower quality.

Use Strategy A when tokens are available, Strategy B as fallback for rate-limited/cheap models.

### Component: Session Context Store

In-memory map, lives for the duration of a TUI session or headless run. Not persisted to SQLite — file contents change between sessions, so cached context would be stale.

```typescript
class SessionContextStore {
  private contexts: Map<string, FileContext> = new Map();

  get(filePath: string): FileContext | undefined;
  set(filePath: string, context: FileContext): void;
  merge(filePath: string, newContext: FileContext): void;
}
```

`merge` combines two FileContexts for the same file:
- Concatenate and deduplicate `sanitizers`, `dataSources`, `frameworkProtections`, `patterns`
- Append to `priorVerdicts`

### Integration: Agent Loop

The `AgentLoopConfig` gets a new optional field:

```typescript
interface AgentLoopConfig {
  // ... existing fields ...
  fileContext?: FileContext;
}
```

In `runAgentLoop`, if `fileContext` is present, append it to the system prompt:

```
## File Context (from prior analysis of this file)

The following was observed during previous investigation of {path}:

### Sanitization Functions
- escapeHtml() at line 601: escapes <, >, & — adequate for text node context

### Data Sources
- Remote XML feed from kagi.com/smallweb via fetch() in background.js:141

### Framework Protections
- None observed

### Prior Verdicts in This File
- Line 417 (insecure-document-method): false_positive — escapeHtml adequately sanitizes for text node innerHTML context

Use this context to inform your investigation. You may disagree with prior verdicts if the current finding has different characteristics.
```

The last sentence is critical — it prevents anchoring bias.

### Integration: Orchestrator

The `TriageOrchestrator` owns the `SessionContextStore`. After each `triage()` call:

1. Extract `FileContext` from the result
2. Merge into the store
3. Pass to the next `triage()` call if the finding is in the same file

```typescript
class TriageOrchestrator {
  private sessionContext = new SessionContextStore();

  async triage(finding, fingerprint, config, onEvent) {
    const fileContext = this.sessionContext.get(finding.path);
    const result = await runAgentLoop({ ...config, fileContext });

    // Extract and store context for future findings in same file
    const newContext = await extractFileContext(finding, result, ...);
    this.sessionContext.merge(finding.path, newContext);

    return result;
  }
}
```

### Integration: Batch Queue (TUI)

The TUI's batch queue (`startBatchQueue`) already processes findings sequentially. No change needed — the orchestrator handles context accumulation automatically.

For optimal benefit, findings should be **grouped by file** in the batch queue. This could be a sort applied when the user selects multiple findings:

```typescript
// Sort batch indices so same-file findings are adjacent
indices.sort((a, b) => {
  const pathCmp = findingStates[a].finding.path.localeCompare(findingStates[b].finding.path);
  return pathCmp !== 0 ? pathCmp : findingStates[a].finding.start.line - findingStates[b].finding.start.line;
});
```

### Integration: Headless Mode

Same approach — the orchestrator accumulates context across sequential findings. Headless already processes findings in order; sorting by file path before processing maximizes context reuse.

## Context Size Management

The file context section in the system prompt is capped at **1000 tokens** (~750 words). If the accumulated context exceeds this:

1. Keep all `priorVerdicts` (most valuable for accuracy)
2. Truncate `patterns` (least critical)
3. Deduplicate `sanitizers` and `dataSources`

## What This Does NOT Do

- **No cross-file context**: Only shares context within the same file. Cross-file patterns (e.g., a shared middleware) are handled by the existing `getHints()` rule-level memory.
- **No persistence**: Context lives in session memory only. Files change between sessions, so persisted file context would be stale.
- **No tool call caching**: The agent still makes its own tool calls. The context briefing reduces the *need* for redundant calls but doesn't intercept them. Tool caching could be added later as an independent optimization.

## Files to Change

| File | Change |
|------|--------|
| `src/agent/file-context.ts` | New — `FileContext` type, `FileContextBuilder`, `SessionContextStore` |
| `src/agent/loop.ts` | Add `fileContext` to config, inject into system prompt |
| `src/orchestrator.ts` | Own `SessionContextStore`, extract + merge after each triage |
| `src/ui/app.tsx` | Sort batch queue by file path |
| `src/agent/system-prompt.ts` | Add `formatFileContext()` helper |

## Testing

1. **Unit**: `FileContextBuilder.extract()` with mock LLM response
2. **Unit**: `SessionContextStore.merge()` deduplication
3. **Unit**: `formatFileContext()` prompt formatting + token cap
4. **Integration**: Two findings in the same file — verify context is passed to finding #2
5. **Integration**: Batch queue sorting by file path

## Expected Impact

- **Token savings**: ~40-60% fewer tool calls for findings #2+ in the same file (based on measured redundancy)
- **Accuracy**: Prior analysis context reduces reasoning errors (like the `escapeHtml` text-node-vs-attribute context mistake)
- **Speed**: Fewer tool calls = fewer LLM round trips = faster triage
