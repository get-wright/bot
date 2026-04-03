import React from "react";
import { Box, Text } from "ink";
import type { AgentEvent } from "../../models/events.js";
import { VerdictBanner } from "./verdict-banner.js";

/**
 * Collapse consecutive thinking events into single text blocks.
 * Returns a mixed array of: { type: "thinking_block", text: string } | AgentEvent
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

export function AgentPanel({ events, isActive }: { events: AgentEvent[]; isActive: boolean }) {
  if (events.length === 0 && !isActive) {
    return (
      <Box padding={1}>
        <Text dimColor>Press Enter to start investigating this finding.</Text>
      </Box>
    );
  }

  const collapsed = collapseEvents(events);

  return (
    <Box flexDirection="column" padding={1} overflow="hidden">
      {collapsed.map((item, i) => {
        if (item.type === "thinking_block") {
          return <Text key={i} wrap="wrap">{item.text}</Text>;
        }
        return <EventLine key={i} event={item as AgentEvent} />;
      })}
      {isActive && events.length > 0 && (
        <Text color="yellow">  Investigating...</Text>
      )}
    </Box>
  );
}

function EventLine({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case "tool_start":
      return <Text color="cyan" wrap="truncate">  * {formatToolStart(event.tool, event.args)}</Text>;
    case "tool_result": {
      const lines = event.summary.split("\n");
      return (
        <Box flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i} dimColor wrap="truncate">    {i === 0 ? "-> " : "   "}{line}</Text>
          ))}
        </Box>
      );
    }
    case "thinking":
      // Should not reach here after collapse, but handle gracefully
      return <Text wrap="wrap">{event.delta}</Text>;
    case "verdict":
      return <VerdictBanner verdict={event.verdict} />;
    case "error":
      return <Text color="red" wrap="truncate">  ! {event.message}</Text>;
  }
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
