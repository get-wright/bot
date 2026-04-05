# Agent Subsystem

Core LLM-driven investigation loop. The agent explores the codebase via tools and delivers a verdict.

## Key Files

- `loop.ts` — `runAgentLoop()` returns `AgentLoopResult = { verdict, toolCalls, inputTokens, outputTokens }`. Orchestrates `streamText` with tools, `prepareStep` hook, permission callbacks, `accumulatedText` buffering, `generateObject` fallback, token usage, error extraction.
- `follow-up.ts` — `runFollowUp()`: conversational follow-up on a delivered verdict (no tools, streaming text only)
- `doom-loop.ts` — `DoomLoopDetector`: detects repeated tool calls with identical args and injects a warning message
- `system-prompt.ts` — system prompt template + `formatFindingMessage()` for finding context
- `tools/` — read, grep, glob, bash, verdict. Read tool has permission callbacks for out-of-root file access.

## Agent Loop Flow

1. `streamText()` with tools, system prompt, finding message
2. `prepareStep` hook runs before each step:
   - Step N-2: injects "wrap up" warning into system prompt
   - Step N-1: restricts `activeTools` to verdict only + `toolChoice: { type: "tool", toolName: "verdict" }`
   - Skipped entirely if verdict already delivered
3. Events emitted: `tool_start`, `tool_result`, `thinking`, `verdict`, `error`, `permission_request`, `usage`, `followup_start`
4. Text deltas buffered into `accumulatedText` for backfill synthesis
5. Non-verdict tool calls captured into `capturedToolCalls` for persistence
6. `extractErrorMessage()` walks cause chains for actionable messages (429 rate limit with retry-after, 401/402 auth, 5xx server errors)
7. **`generateObject` fallback** when stream ends without a verdict
8. **Verdict emission is delayed** until end-of-stream so empty fields can be backfilled

## Multi-provider compliance

`toolChoice` enforcement is a model-level capability, not SDK-level. Strong models (Claude, GPT-4, Gemini) comply. Weak models (gpt-oss-120b, nemotron free, glm-4.7) exhibit two failure modes:

**Failure mode 1 — no tool call:** model generates text and ends stream without calling the verdict tool.

**Failure mode 2 — empty tool call:** model calls verdict tool with `{verdict:"X", reasoning:"", key_evidence:[]}` after writing the analysis as text.

## Recovery strategy

Both failure modes use `accumulatedText` (the model's own analysis from text-delta chunks) as the source of truth for reasoning:

- **Mode 1** → `generateObject` with a **lenient schema** (all fields optional, `.describe()` for guidance). Partial responses pass validation. Then backfill empty `reasoning` from `accumulatedText`, empty `key_evidence` stays empty.
- **Mode 2** → at end-of-stream, check the tool-call verdict for empty fields; backfill from `accumulatedText` before emitting the verdict event.

**Why lenient schema:** strict constraints (`min(20)`, `min(1)`) cause `generateObject` to throw on weak models, losing even the verdict. Accept whatever comes back, then backfill from the already-available text stream.

## Permission Model

Out-of-root file access uses deferred-promise pattern (inspired by Opencode):
- `isPathAllowed(absPath)` checks session-approved set + `allowedPaths` whitelist
- `requestPermission(absPath)` emits `permission_request` event, returns a Promise resolved by the TUI
- Decisions: `"once"` (this path only), `"always"` (add to session set), `"deny"`

## Tools

- `read` — file content with line numbers (`${n}\t${line}`), 1-based offset, 200-line default limit, 50 KB byte cap. Appends metadata footer (`[End of file — N lines total]` or `[Showing lines X-Y of N — use offset=Y+1 to continue]`). Lines >2000 chars truncated with `… [line truncated, N chars total]`.
- `grep` — ripgrep-style pattern search with optional path/include filters
- `glob` — file discovery by pattern
- `bash` — optional shell execution (disabled by default, `--allow-bash` to enable)
- `verdict` — terminal tool; emits `verdict` event and sets `finalVerdict`

## Follow-Up

`runFollowUp()` builds message history: system prompt + finding context + verdict + prior exchanges + new question. Streams conversational response with no tool access. Uses same provider/model/reasoning config.
