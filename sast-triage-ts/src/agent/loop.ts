import { streamText, stepCountIs } from "ai";
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
  apiKey?: string;
  baseUrl?: string;
}

export async function runAgentLoop(config: AgentLoopConfig): Promise<TriageVerdict> {
  const { finding, projectRoot, provider, model: modelId, maxSteps, allowBash, onEvent, memoryHints } = config;

  const languageModel = resolveProvider(provider, modelId, config.apiKey, config.baseUrl);
  const tools = createTools({ projectRoot, allowBash });
  const doomLoop = new DoomLoopDetector();
  let finalVerdict: TriageVerdict | null = null;

  const systemPromptParts = [SYSTEM_PROMPT];
  if (memoryHints.length > 0) {
    systemPromptParts.push(`## Historical Context\n${memoryHints.map((h) => `- ${h}`).join("\n")}`);
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
  await result.text;

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
