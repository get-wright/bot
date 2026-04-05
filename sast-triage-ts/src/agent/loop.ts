import { streamText, stepCountIs, generateObject } from "ai";
import { z } from "zod";
import { VerdictValue } from "../models/verdict.js";
import type { Finding } from "../models/finding.js";
import type { TriageVerdict } from "../models/verdict.js";
import type { AgentEvent } from "../models/events.js";
import type { PermissionDecision } from "../models/events.js";
import { TriageVerdictSchema } from "../models/verdict.js";
import { SYSTEM_PROMPT, formatFindingMessage } from "./system-prompt.js";
import { DoomLoopDetector } from "./doom-loop.js";
import { createTools } from "./tools/index.js";
import { resolveProvider } from "../provider/registry.js";
import { resolveProviderOptions, type ReasoningEffort } from "../provider/reasoning.js";
import { dirname } from "node:path";
import { log } from "../logger.js";

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

export interface AgentLoopResult {
  verdict: TriageVerdict;
  toolCalls: { tool: string; args: Record<string, unknown> }[];
  inputTokens: number;
  outputTokens: number;
}

/** Extract the most useful error message, digging into cause chains.
 *  Detects rate limits (429), auth errors (401/403), and provider-specific errors. */
function extractErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  let current: unknown = err;
  const seen = new Set<unknown>();
  let statusCode: number | undefined;
  let providerMessage = "";
  let retryAfter = "";

  // Walk the cause chain to find the real error
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const anyErr = current as unknown as Record<string, unknown>;

    // Capture status code
    if (typeof anyErr.statusCode === "number") statusCode = anyErr.statusCode;

    // Extract retry-after from headers
    if (anyErr.responseHeaders && typeof anyErr.responseHeaders === "object") {
      const headers = anyErr.responseHeaders as Record<string, string>;
      if (headers["retry-after"]) retryAfter = headers["retry-after"];
    }

    // Parse response body for provider error message
    if (typeof anyErr.responseBody === "string") {
      try {
        const body = JSON.parse(anyErr.responseBody);
        if (body.error?.message) providerMessage = body.error.message;
        // OpenRouter includes retry_after in metadata
        if (body.error?.metadata?.retry_after) retryAfter = `${body.error.metadata.retry_after}s`;
      } catch { /* not JSON */ }
    }

    current = (current as Error).cause;
  }

  // Format user-facing message based on status code
  if (statusCode === 429) {
    const wait = retryAfter ? ` Retry after ${retryAfter}.` : " Try again shortly.";
    return `Rate limited by provider.${wait}${providerMessage ? ` (${providerMessage})` : ""}`;
  }
  if (statusCode === 401 || statusCode === 403) {
    return `Authentication failed (${statusCode}). Check your API key.${providerMessage ? ` (${providerMessage})` : ""}`;
  }
  if (statusCode === 402) {
    return `Insufficient credits (402).${providerMessage ? ` ${providerMessage}` : ""}`;
  }
  if (statusCode && statusCode >= 500) {
    return `Provider error (${statusCode}).${providerMessage ? ` ${providerMessage}` : " The service may be temporarily unavailable."}`;
  }

  // Fallback: use provider message or original error
  if (providerMessage) return providerMessage;

  // Strip useless AI SDK wrapper messages
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("No output generated") || msg.includes("Check the stream")) {
    return "No response from provider. The model may be unavailable or overloaded.";
  }
  return msg;
}

export async function runAgentLoop(config: AgentLoopConfig): Promise<AgentLoopResult> {
  const { finding, projectRoot, provider, model: modelId, maxSteps, allowBash, onEvent, memoryHints } = config;

  log.info("agent", `Starting triage: ${finding.check_id} at ${finding.path}:${finding.start.line}`);
  log.debug("agent", "Config", { provider, model: modelId, maxSteps, allowBash, reasoningEffort: config.reasoningEffort });

  const languageModel = resolveProvider(provider, modelId, config.apiKey, config.baseUrl);

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
  const doomLoop = new DoomLoopDetector();
  let finalVerdict: TriageVerdict | null = null;
  // Capture the model's text output during investigation — used as reasoning
  // fallback if the model returns a partial verdict from generateObject.
  let accumulatedText = "";
  // Capture tool calls and token usage for persistence, so cached findings
  // can show what was read and how many tokens were used.
  const capturedToolCalls: { tool: string; args: Record<string, unknown> }[] = [];
  let capturedInputTokens = 0;
  let capturedOutputTokens = 0;

  const systemPromptParts = [SYSTEM_PROMPT];
  if (memoryHints.length > 0) {
    systemPromptParts.push(`## Historical Context\n${memoryHints.map((h) => `- ${h}`).join("\n")}`);
  }

  const userMessage = formatFindingMessage(finding);

  const providerOptions = config.reasoningEffort
    ? (resolveProviderOptions(config.provider, config.reasoningEffort) as Parameters<typeof streamText>[0]["providerOptions"])
    : undefined;

  const systemPrompt = systemPromptParts.join("\n\n");

  const result = streamText({
    model: languageModel,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    tools,
    providerOptions,
    stopWhen: stepCountIs(maxSteps),
    async prepareStep({ stepNumber }) {
      log.debug("agent", `Step ${stepNumber + 1}/${maxSteps}${finalVerdict ? " (verdict already delivered)" : ""}`);
      // Skip overrides if verdict already delivered — no need to waste steps
      if (finalVerdict) return;
      // Penultimate step: warn the model to wrap up
      if (stepNumber === maxSteps - 2) {
        return {
          system: systemPrompt +
            "\n\nIMPORTANT: You have 1 step remaining after this one. Wrap up your investigation and call the verdict tool with your best assessment based on the evidence gathered so far.",
        };
      }
      // Final step: force verdict tool only — model cannot do anything else
      if (stepNumber === maxSteps - 1) {
        return {
          toolChoice: { type: "tool" as const, toolName: "verdict" },
          activeTools: ["verdict"] as any,
          system: systemPrompt +
            "\n\nThis is your FINAL step. You MUST call the verdict tool now. Deliver your verdict based on all evidence gathered.",
        };
      }
    },
    onChunk({ chunk }) {
      switch (chunk.type) {
        case "text-delta": {
          log.debug("stream", "text-delta", chunk.text.slice(0, 100));
          accumulatedText += chunk.text;
          onEvent({ type: "thinking", delta: chunk.text });
          break;
        }
        case "tool-call": {
          const toolName = chunk.toolName;
          const args = chunk.input as Record<string, unknown>;
          log.info("tool", `${toolName}`, args);
          onEvent({ type: "tool_start", tool: toolName, args });
          doomLoop.record(toolName, args);

          if (toolName === "verdict") {
            try {
              // Parse but don't emit yet — backfill synthesis happens at
              // end-of-stream so we can use accumulatedText if reasoning is empty.
              finalVerdict = TriageVerdictSchema.parse(args);
            } catch {
              onEvent({ type: "error", message: "Invalid verdict format from LLM" });
            }
          } else {
            // Capture non-verdict tool calls for persistence.
            capturedToolCalls.push({ tool: toolName, args });
          }
          break;
        }
        case "tool-result": {
          const output = String(chunk.output);
          const lines = output.split("\n");
          log.debug("tool", `${chunk.toolName} result: ${lines.length} lines, ${output.length} bytes`);
          const summary =
            lines.length > 3
              ? lines.slice(0, 3).join("\n") + `\n... (${lines.length} lines)`
              : output;
          onEvent({ type: "tool_result", tool: chunk.toolName, summary, full: output });
          break;
        }
      }
    },
    onStepFinish() {
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
  try {
    await result.text;
  } catch (err) {
    const message = extractErrorMessage(err);
    log.error("agent", `API error: ${message}`);
    onEvent({ type: "error", message: `API error: ${message}` });
  }

  // If verdict came from tool call, backfill missing reasoning/evidence from
  // the model's accumulated text. Weak models (GLM-4.7) often call the verdict
  // tool with empty reasoning/evidence after writing the analysis as text.
  if (finalVerdict !== null) {
    const v: TriageVerdict = finalVerdict;
    const needsBackfill = !v.reasoning.trim() || v.key_evidence.length === 0;
    if (needsBackfill) {
      const synthesized = accumulatedText.trim().slice(0, 2000);
      const backfilledReasoning = v.reasoning.trim()
        || synthesized
        || "Model did not provide detailed reasoning.";
      finalVerdict = {
        verdict: v.verdict,
        reasoning: backfilledReasoning,
        key_evidence: v.key_evidence,
        suggested_fix: v.suggested_fix,
      };
      log.info("agent", "Backfilled verdict from accumulated text", {
        reasoningSource: v.reasoning.trim() ? "toolCall" : (synthesized ? "accumulatedText" : "placeholder"),
        reasoningLength: backfilledReasoning.length,
        evidenceCount: finalVerdict.key_evidence.length,
      });
    }
    onEvent({ type: "verdict", verdict: finalVerdict });
  }

  // Emit token usage
  try {
    const totalUsage = await result.totalUsage;
    capturedInputTokens = totalUsage.inputTokens ?? 0;
    capturedOutputTokens = totalUsage.outputTokens ?? 0;
    onEvent({
      type: "usage",
      inputTokens: capturedInputTokens,
      outputTokens: capturedOutputTokens,
      totalTokens: totalUsage.totalTokens ?? 0,
      reasoningTokens: (totalUsage as Record<string, unknown>).reasoningTokens as number | undefined,
      cachedInputTokens: (totalUsage as Record<string, unknown>).cachedInputTokens as number | undefined,
    });
  } catch {
    // Usage not available — ignore
  }

  if (!finalVerdict) {
    // Weak models often ignore toolChoice and generate text instead.
    // Fall back to generateObject (JSON mode) which has better compliance.
    //
    // Design: use a LENIENT schema here. Strict constraints (min chars,
    // min array length) cause generateObject to throw on weak models that
    // emit just {verdict: "..."}, losing even the verdict they did give us.
    // Instead, accept whatever the model returns and backfill missing
    // reasoning from the model's own accumulated text from the main stream.
    log.warn("agent", "No verdict from tool call — attempting generateObject fallback");
    const FallbackSchema = z.object({
      verdict: VerdictValue.describe("Final verdict: true_positive, false_positive, or needs_review"),
      reasoning: z.string().optional().describe("Detailed explanation referencing specific code lines and data flow"),
      key_evidence: z.array(z.string()).optional().describe("Specific evidence items (line numbers, code patterns, framework protections)"),
      suggested_fix: z.string().optional().describe("Concrete fix suggestion if applicable"),
    });
    try {
      const responseMessages = (await result.response).messages;
      const { object } = await generateObject({
        model: languageModel,
        schema: FallbackSchema,
        providerOptions,
        system: systemPrompt,
        messages: [
          { role: "user", content: userMessage },
          ...responseMessages,
          {
            role: "user",
            content:
              "Based on your investigation above, deliver your final verdict as JSON with " +
              "verdict, reasoning (detailed analysis with line numbers), key_evidence " +
              "(specific evidence items), and suggested_fix if applicable.",
          },
        ],
      });
      // Backfill missing fields using the model's own accumulated text from
      // the main stream. This text is the model's own analysis that preceded
      // the stream ending — it's the reasoning the model already articulated.
      const reasoning = (object.reasoning?.trim())
        || accumulatedText.trim().slice(0, 2000)
        || "Model did not provide detailed reasoning.";
      const evidence = (object.key_evidence && object.key_evidence.length > 0)
        ? object.key_evidence
        : [];
      finalVerdict = {
        verdict: object.verdict,
        reasoning,
        key_evidence: evidence,
        suggested_fix: object.suggested_fix,
      };
      log.info("agent", "Verdict recovered via generateObject fallback", {
        verdict: finalVerdict.verdict,
        reasoningSource: object.reasoning?.trim() ? "generateObject" : "accumulatedText",
        reasoningLength: finalVerdict.reasoning.length,
        evidenceCount: finalVerdict.key_evidence.length,
      });
      onEvent({ type: "verdict", verdict: finalVerdict });
    } catch (err) {
      log.warn("agent", `generateObject fallback failed: ${err instanceof Error ? err.message : String(err)}`);
      finalVerdict = {
        verdict: "needs_review",
        reasoning: "Agent did not deliver a verdict within the maximum number of steps.",
        key_evidence: [],
      };
      onEvent({ type: "verdict", verdict: finalVerdict });
    }
  }

  log.info("agent", `Verdict: ${finalVerdict.verdict}`, { reasoning: finalVerdict.reasoning.slice(0, 200) });
  return {
    verdict: finalVerdict,
    toolCalls: capturedToolCalls,
    inputTokens: capturedInputTokens,
    outputTokens: capturedOutputTokens,
  };
}
