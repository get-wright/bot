# Agent Subsystem

Core LLM-driven investigation loop. The agent explores the codebase via tools and delivers a verdict.

## Key Files

- `loop.ts` — `runAgentLoop()`: orchestrates `streamText` with tools, `prepareStep` hook, permission callbacks, token usage, error extraction
- `follow-up.ts` — `runFollowUp()`: conversational follow-up on a delivered verdict (no tools, streaming text only)
- `doom-loop.ts` — `DoomLoopDetector`: detects repeated tool calls with identical args and injects a warning message
- `system-prompt.ts` — system prompt template + `formatFindingMessage()` for finding context
- `tools/` — read, grep, glob, bash, verdict. Read tool has permission callbacks for out-of-root file access.

## Agent Loop Flow

1. `streamText()` with tools, system prompt, finding message
2. `prepareStep` hook runs before each step:
   - Step N-2: injects "wrap up" warning into system prompt
   - Step N-1: restricts `activeTools` to verdict only
   - Skipped entirely if verdict already delivered
3. Events emitted: `text_delta`, `tool_call`, `tool_result`, `thinking`, `error`, `permission_request`, `usage`
4. `extractErrorMessage()` walks cause chains for actionable messages (429 rate limit with retry-after, 401/402 auth, 5xx server errors)

## Permission Model

Out-of-root file access uses deferred-promise pattern (inspired by Opencode):
- `isPathAllowed(absPath)` checks session-approved set + `allowedPaths` whitelist
- `requestPermission(absPath)` emits `permission_request` event, returns a Promise resolved by the TUI
- Decisions: `"once"` (this path only), `"always"` (add to session set), `"deny"`

## Follow-Up

`runFollowUp()` builds message history: system prompt + finding context + verdict + prior exchanges + new question. Streams conversational response with no tool access. Uses same provider/model/reasoning config.
