import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { AgentEvent } from "../../models/events.js";
import { VerdictBanner } from "./verdict-banner.js";

function clip(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, maxWidth - 1) + "…";
}

/**
 * Collapse consecutive thinking events into single text blocks.
 */
function collapseEvents(events: AgentEvent[]): (AgentEvent | { type: "thinking_block"; text: string })[] {
  const result: (AgentEvent | { type: "thinking_block"; text: string })[] = [];
  let pendingThinking = "";

  for (const event of events) {
    if (event.type === "thinking") {
      pendingThinking += event.delta;
    } else {
      if (pendingThinking) {
        result.push({ type: "thinking_block", text: pendingThinking });
        pendingThinking = "";
      }
      result.push(event);
    }
  }
  if (pendingThinking) {
    result.push({ type: "thinking_block", text: pendingThinking });
  }
  return result;
}

export function AgentPanel({
  events,
  isActive,
  width,
  showFollowUpInput,
  onFollowUp,
  onPermissionResolve,
}: {
  events: AgentEvent[];
  isActive: boolean;
  width: number;
  showFollowUpInput?: boolean;
  onFollowUp?: (question: string) => void;
  onPermissionResolve?: (decision: "once" | "always" | "deny") => void;
}) {
  const [followUpText, setFollowUpText] = useState("");
  if (events.length === 0 && !isActive) {
    return (
      <Box padding={1}>
        <Text dimColor>Press Enter to start investigating this finding.</Text>
      </Box>
    );
  }

  const collapsed = collapseEvents(events);
  const w = width - 2; // account for padding

  return (
    <Box flexDirection="column" padding={1} overflow="hidden">
      {collapsed.map((item, i) => {
        if (item.type === "thinking_block") {
          return <Text key={i} wrap="wrap">{item.text}</Text>;
        }
        return <EventLine key={i} event={item as AgentEvent} maxWidth={w} />;
      })}
      {isActive && events.length > 0 && (
        <Text color="yellow">  Investigating...</Text>
      )}
      {/* Permission prompt */}
      {(() => {
        const permEvent = [...events].reverse().find((e: AgentEvent) => e.type === "permission_request");
        if (permEvent && permEvent.type === "permission_request" && onPermissionResolve) {
          return (
            <Box flexDirection="column" marginTop={1} paddingX={2}>
              <Text color="yellow" bold>Permission required</Text>
              <Text>Read file outside project root:</Text>
              <Text dimColor>{permEvent.path}</Text>
              <Text> </Text>
              <Text>
                <Text color="green" bold>[a]</Text> Allow once{"  "}
                <Text color="cyan" bold>[d]</Text> Allow dir always{"  "}
                <Text color="red" bold>[x]</Text> Deny
              </Text>
            </Box>
          );
        }
        return null;
      })()}
      {showFollowUpInput && onFollowUp && (
        <Box marginTop={1} paddingX={2}>
          <Text bold color="cyan">&gt; </Text>
          <TextInput
            value={followUpText}
            onChange={setFollowUpText}
            onSubmit={(value) => {
              if (value.trim()) {
                onFollowUp(value.trim());
                setFollowUpText("");
              }
            }}
            placeholder="Ask a follow-up question..."
          />
        </Box>
      )}
    </Box>
  );
}

function EventLine({ event, maxWidth }: { event: AgentEvent; maxWidth: number }) {
  switch (event.type) {
    case "tool_start":
      return <Text color="cyan">{clip(`  * ${formatToolStart(event.tool, event.args)}`, maxWidth)}</Text>;
    case "tool_result": {
      const lines = event.summary.split("\n");
      return (
        <>
          {lines.map((line, i) => {
            const prefix = i === 0 ? "    -> " : "       ";
            return <Text key={i} dimColor>{clip(`${prefix}${line}`, maxWidth)}</Text>;
          })}
        </>
      );
    }
    case "thinking":
      return <Text wrap="wrap">{event.delta}</Text>;
    case "verdict":
      return <VerdictBanner verdict={event.verdict} />;
    case "error":
      return <Text color="red">{clip(`  ! ${event.message}`, maxWidth)}</Text>;
    case "usage":
      return (
        <Text dimColor>
          {clip(`  Tokens: ${formatTokenCount(event.inputTokens)} in / ${formatTokenCount(event.outputTokens)} out`, maxWidth)}
        </Text>
      );
    case "followup_start":
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>{clip(`  > ${event.question}`, maxWidth)}</Text>
        </Box>
      );
    case "permission_request":
      return null; // Rendered separately as interactive prompt
  }
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatToolStart(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "read": {
      const path = args.path as string;
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      const range = offset ? ` (lines ${offset}-${(offset ?? 1) + (limit ?? 200) - 1})` : "";
      return `Reading ${path}${range}`;
    }
    case "grep":
      return `Grepping "${args.pattern as string}" in ${(args.path as string) ?? "."}`;
    case "glob":
      return `Finding files: ${args.pattern as string}`;
    case "bash":
      return `Running: ${args.command as string}`;
    case "verdict":
      return `Delivering verdict`;
    default:
      return `${tool}(${JSON.stringify(args)})`;
  }
}
