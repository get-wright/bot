import { streamText } from "ai";
import type { Finding } from "../models/finding.js";
import type { TriageVerdict } from "../models/verdict.js";
import type { AgentEvent } from "../models/events.js";
import { formatFindingMessage } from "./system-prompt.js";
import { resolveProvider } from "../../provider/registry.js";
import { resolveProviderOptions, type ReasoningEffort } from "../../provider/reasoning.js";

const FOLLOWUP_SYSTEM = `You are an expert application security engineer in a follow-up discussion about a SAST finding you previously triaged. Answer the user's question based on the finding context and your previous analysis. Be specific, cite line numbers and code when relevant. Do not output JSON — this is a conversation.`;

export interface FollowUpExchange {
  question: string;
  answer: string;
}

export function buildFollowUpMessages(
  finding: Finding,
  previousVerdict: TriageVerdict,
  question: string,
  priorExchanges: FollowUpExchange[] = [],
): { role: "user" | "assistant"; content: string }[] {
  const messages: { role: "user" | "assistant"; content: string }[] = [];

  // Original finding context
  messages.push({ role: "user", content: formatFindingMessage(finding) });

  // Previous verdict as assistant response
  const verdictSummary = [
    `Verdict: ${previousVerdict.verdict}`,
    `Reasoning: ${previousVerdict.reasoning}`,
    previousVerdict.key_evidence.length > 0
      ? `Evidence:\n${previousVerdict.key_evidence.map((e) => `- ${e}`).join("\n")}`
      : "",
    previousVerdict.suggested_fix ? `Suggested fix: ${previousVerdict.suggested_fix}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  messages.push({ role: "assistant", content: verdictSummary });

  // Prior follow-up exchanges
  for (const exchange of priorExchanges) {
    messages.push({ role: "user", content: exchange.question });
    messages.push({ role: "assistant", content: exchange.answer });
  }

  // Current question
  messages.push({ role: "user", content: question });

  return messages;
}

export interface FollowUpConfig {
  finding: Finding;
  previousVerdict: TriageVerdict;
  question: string;
  priorExchanges?: FollowUpExchange[];
  provider: string;
  model: string;
  onEvent: (event: AgentEvent) => void;
  apiKey?: string;
  baseUrl?: string;
  reasoningEffort?: ReasoningEffort;
}

export async function runFollowUp(config: FollowUpConfig): Promise<string> {
  const {
    finding,
    previousVerdict,
    question,
    priorExchanges = [],
    provider,
    model: modelId,
    onEvent,
  } = config;

  onEvent({ type: "followup_start", question });

  const languageModel = resolveProvider(provider, modelId, config.apiKey, config.baseUrl);
  const messages = buildFollowUpMessages(finding, previousVerdict, question, priorExchanges);

  const providerOptions = config.reasoningEffort
    ? (resolveProviderOptions(provider, config.reasoningEffort) as Parameters<typeof streamText>[0]["providerOptions"])
    : undefined;

  let fullText = "";

  const result = streamText({
    model: languageModel,
    system: FOLLOWUP_SYSTEM,
    messages,
    providerOptions,
    onChunk({ chunk }) {
      if (chunk.type === "text-delta") {
        onEvent({ type: "thinking", delta: chunk.text });
        fullText += chunk.text;
      }
    },
  });

  try {
    await result.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent({ type: "error", message: `Follow-up error: ${message}` });
  }

  return fullText;
}
