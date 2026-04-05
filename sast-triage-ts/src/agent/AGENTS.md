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
   - Step N-1: restricts `activeTools` to verdict only + `toolChoice: { type: "tool", toolName: "verdict" }`
   - Skipped entirely if verdict already delivered
3. Events emitted: `tool_start`, `tool_result`, `thinking`, `verdict`, `error`, `permission_request`, `usage`, `followup_start`
4. `extractErrorMessage()` walks cause chains for actionable messages (429 rate limit with retry-after, 401/402 auth, 5xx server errors)
5. **`generateObject` fallback**: when stream ends without a verdict (weak models ignore `toolChoice` and generate text), a follow-up `generateObject` call with the conversation history extracts the verdict via JSON mode

## Why the generateObject fallback exists

`toolChoice` enforcement is a model-level capability, not SDK-level. Strong models (Claude, GPT-4, Gemini) comply with forced tool calls. Weak models (gpt-oss-120b, nemotron free tier) ignore it and generate plain text instead. The AI SDK cannot force compliance.

`generateObject` uses the model's native structured-output API (JSON mode), which is enforced at the sampling level rather than as a prompt convention. It works across far more models than tool calling does.

The fallback passes: same system prompt + original finding message + all prior assistant messages from the streamText response + an explicit "deliver your verdict as JSON" user message. The model already has full investigation context and just needs to emit JSON.

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
