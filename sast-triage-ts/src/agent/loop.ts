import { streamText, stepCountIs } from "ai";
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

export async function runAgentLoop(config: AgentLoopConfig): Promise<TriageVerdict> {
  const { finding, projectRoot, provider, model: modelId, maxSteps, allowBash, onEvent, memoryHints } = config;

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
              onEvent({ type: "error", message: "Invalid verdict format from LLM" });
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
    const message = err instanceof Error ? err.message : String(err);
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
    finalVerdict = {
      verdict: "needs_review",
      reasoning: "Agent did not deliver a verdict within the maximum number of steps.",
      key_evidence: [],
    };
    onEvent({ type: "verdict", verdict: finalVerdict });
  }

  return finalVerdict;
}
