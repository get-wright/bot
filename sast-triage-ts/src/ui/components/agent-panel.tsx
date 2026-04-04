import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { AgentEvent } from "../../models/events.js";
import type { TriageVerdict } from "../../models/verdict.js";

/**
 * Clip text to maxWidth based on visual width.
 * Tabs expanded to 4 spaces. Pads to exact width to prevent Ink layout drift.
 */
function clip(text: string, maxWidth: number): string {
  const expanded = text.replace(/\t/g, "    ");
  if (expanded.length > maxWidth) {
    return expanded.slice(0, maxWidth - 1) + "…";
  }
  return expanded;
}

/** Word-wrap text to maxWidth, returning multiple lines. */
function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const result: string[] = [];
  // Split on existing newlines first
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ");
    let line = "";
    for (const word of words) {
      if (line.length + word.length + (line ? 1 : 0) > maxWidth) {
        if (line) result.push(line);
        line = word.length > maxWidth ? word.slice(0, maxWidth - 1) + "…" : word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    result.push(line);
  }
  return result.length > 0 ? result : [""];
}

type CollapsedEvent =
  | AgentEvent
  | { type: "thinking_block"; text: string };

/**
 * Collapse consecutive thinking events into single text blocks.
 */
function collapseEvents(events: AgentEvent[]): CollapsedEvent[] {
  const result: CollapsedEvent[] = [];
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

/**
 * Render a single pre-clipped line as a block-level element.
 * Using <Box> instead of <Text> ensures Ink treats it as a block,
 * preventing inline merging with adjacent elements.
 */
function Line({ children, ...props }: { children: string } & Record<string, unknown>) {
  return (
    <Box>
      <Text {...props}>{children}</Text>
    </Box>
  );
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
          return (
            <Box key={i} flexDirection="column" marginBottom={1}>
              {wrapText(item.text, w).map((line, li) => (
                <Line key={li} dimColor>{line}</Line>
              ))}
            </Box>
          );
        }
        return <EventLine key={i} event={item as AgentEvent} maxWidth={w} />;
      })}
      {isActive && events.length > 0 && (
        <Box marginTop={1}>
          <Text color="yellow">  Investigating...</Text>
        </Box>
      )}
      {/* Permission prompt */}
      {(() => {
        const permEvent = [...events].reverse().find((e: AgentEvent) => e.type === "permission_request");
        if (permEvent && permEvent.type === "permission_request" && onPermissionResolve) {
          return (
            <Box flexDirection="column" marginTop={1} paddingX={2}>
              <Line color="yellow" bold>Permission required</Line>
              <Line>Read file outside project root:</Line>
              <Line dimColor>{permEvent.path}</Line>
              <Line> </Line>
              <Box>
                <Text>
                  <Text color="green" bold>[a]</Text> Allow once{"  "}
                  <Text color="cyan" bold>[d]</Text> Allow dir always{"  "}
                  <Text color="red" bold>[x]</Text> Deny
                </Text>
              </Box>
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
      return (
        <Box marginTop={1}>
          <Text color="cyan">{clip(`  * ${formatToolStart(event.tool, event.args)}`, maxWidth)}</Text>
        </Box>
      );
    case "tool_result": {
      const lines = event.summary.split("\n");
      return (
        <Box flexDirection="column">
          {lines.map((line, i) => {
            const prefix = i === 0 ? "    -> " : "       ";
            return <Line key={i} dimColor>{clip(`${prefix}${line}`, maxWidth)}</Line>;
          })}
        </Box>
      );
    }
    case "thinking":
      return <Line dimColor>{clip(event.delta, maxWidth)}</Line>;
    case "verdict":
      return <VerdictBanner verdict={event.verdict} maxWidth={maxWidth} />;
    case "error":
      return <Line color="red">{clip(`  ! ${event.message}`, maxWidth)}</Line>;
    case "usage":
      return <Line dimColor>{clip(`  Tokens: ${formatTokenCount(event.inputTokens)} in / ${formatTokenCount(event.outputTokens)} out`, maxWidth)}</Line>;
    case "followup_start":
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>{clip(`  > ${event.question}`, maxWidth)}</Text>
        </Box>
      );
    case "permission_request":
      return null;
  }
}

/** Verdict banner with proper text wrapping — all content in block-level boxes */
function VerdictBanner({ verdict, maxWidth }: { verdict: TriageVerdict; maxWidth: number }) {
  const colors: Record<string, string> = {
    true_positive: "red",
    false_positive: "green",
    needs_review: "#FF8C00",
  };
  const labels: Record<string, string> = {
    true_positive: "TRUE POSITIVE",
    false_positive: "FALSE POSITIVE",
    needs_review: "NEEDS REVIEW",
  };
  const color = colors[verdict.verdict] ?? "white";
  const label = labels[verdict.verdict] ?? verdict.verdict;
  const cw = maxWidth - 4; // content width after paddingX

  return (
    <Box flexDirection="column" marginTop={1} paddingX={2}>
      <Line bold color={color}>{`# ${label}`}</Line>
      <Line> </Line>
      <Line bold>Reasoning:</Line>
      {wrapText(verdict.reasoning, cw).map((line, i) => (
        <Line key={`r-${i}`}>{line}</Line>
      ))}
      {verdict.key_evidence.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Line bold>Evidence:</Line>
          {verdict.key_evidence.map((e, i) => (
            <Line key={`e-${i}`}>{clip(`  - ${e}`, cw)}</Line>
          ))}
        </Box>
      )}
      {verdict.suggested_fix && (
        <Box flexDirection="column" marginTop={1}>
          <Line bold>Fix:</Line>
          {wrapText(verdict.suggested_fix, cw).map((line, i) => (
            <Line key={`f-${i}`}>{line}</Line>
          ))}
        </Box>
      )}
    </Box>
  );
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
