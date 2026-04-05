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

export async function runAgentLoop(config: AgentLoopConfig): Promise<TriageVerdict> {
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
              finalVerdict = TriageVerdictSchema.parse(args);
              onEvent({ type: "verdict", verdict: finalVerdict });
            } catch {
              onEvent({ type: "error", message: "Invalid verdict format from LLM" });
            }
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

  if (!finalVerdict) {
    // Weak models often ignore toolChoice and generate text instead.
    // Fall back to generateObject (JSON mode) which has better compliance.
    // Use a stricter schema here (no defaults) to force the model to emit
    // reasoning and evidence — otherwise weak models emit just {verdict: "..."}.
    log.warn("agent", "No verdict from tool call — attempting generateObject fallback");
    const FallbackSchema = z.object({
      verdict: VerdictValue,
      reasoning: z.string().min(20).describe("Detailed explanation of the verdict referencing specific code lines and data flow"),
      key_evidence: z.array(z.string()).min(1).describe("Specific evidence items (line numbers, code patterns, framework protections) that support the verdict"),
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
              "Based on your investigation above, deliver your final verdict. You MUST populate " +
              "ALL fields with substantive content: verdict, reasoning (explain your analysis in " +
              "detail with specific line numbers and code references), key_evidence (list 2-4 " +
              "specific evidence items from the code you investigated), and suggested_fix if " +
              "applicable. Do not return a partial or empty verdict.",
          },
        ],
      });
      finalVerdict = object;
      log.info("agent", "Verdict recovered via generateObject fallback", {
        verdict: finalVerdict.verdict,
        reasoning: finalVerdict.reasoning.slice(0, 100),
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
  return finalVerdict;
}
