import React from "react";
import { Box, Text } from "ink";
import type { AgentEvent } from "../../models/events.js";
import { VerdictBanner } from "./verdict-banner.js";

export function AgentPanel({ events, isActive }: { events: AgentEvent[]; isActive: boolean }) {
  if (events.length === 0 && !isActive) {
    return (
      <Box padding={1}>
        <Text dimColor>Press Enter to start investigating this finding.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" padding={1} overflow="hidden">
      {events.map((event, i) => (
        <EventLine key={i} event={event} />
      ))}
      {isActive && events.length > 0 && (
        <Text color="yellow">  Investigating...</Text>
      )}
    </Box>
  );
}

function EventLine({ event }: { event: AgentEvent }) {
  switch (event.type) {
    case "tool_start":
      return <Text color="cyan">  * {formatToolStart(event.tool, event.args)}</Text>;
    case "tool_result":
      return <Text dimColor>    {"-> "}{event.summary}</Text>;
    case "thinking":
      return <Text>  {event.delta}</Text>;
    case "verdict":
      return <VerdictBanner verdict={event.verdict} />;
    case "error":
      return <Text color="red">  ! {event.message}</Text>;
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
