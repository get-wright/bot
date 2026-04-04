import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { AgentEvent } from "../../models/events.js";
import type { TriageVerdict } from "../../models/verdict.js";

// --- Text utilities ---

/** Clip text to maxWidth. Tabs → 4 spaces. */
function clip(text: string, maxWidth: number): string {
  const s = text.replace(/\t/g, "    ");
  return s.length > maxWidth ? s.slice(0, maxWidth - 1) + "…" : s;
}

/** Word-wrap text respecting existing newlines. */
function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(" ");
    let line = "";
    for (const word of words) {
      if (line.length + word.length + (line ? 1 : 0) > maxWidth) {
        if (line) out.push(line);
        line = word.length > maxWidth ? word.slice(0, maxWidth - 1) + "…" : word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    out.push(line);
  }
  return out.length > 0 ? out : [""];
}

// --- Block-level line ---
// Wrapping Text in Box forces Ink to treat it as a block element,
// preventing inline merging with adjacent elements.
function L({ children, ...props }: { children: string } & Record<string, unknown>) {
  return <Box><Text {...props}>{children}</Text></Box>;
}

// --- Event collapsing ---

type CollapsedEvent = AgentEvent | { type: "thinking_block"; text: string };

function collapseEvents(events: AgentEvent[]): CollapsedEvent[] {
  const result: CollapsedEvent[] = [];
  let buf = "";
  for (const ev of events) {
    if (ev.type === "thinking") {
      buf += ev.delta;
    } else {
      if (buf) { result.push({ type: "thinking_block", text: buf }); buf = ""; }
      result.push(ev);
    }
  }
  if (buf) result.push({ type: "thinking_block", text: buf });
  return result;
}

// --- Tool result formatting ---
// Pi shows 10 lines for read, 15 for grep, 20 for find.
// We show the summary (already truncated to 3 lines in loop.ts).
// Reformat it for clarity.

function formatToolResult(tool: string, summary: string, maxWidth: number): string[] {
  const raw = summary.replace(/\t/g, "    ");
  const lines = raw.split("\n");
  const indent = "    ";
  const cw = maxWidth - indent.length;

  return lines.map((line) => {
    const clipped = line.length > cw ? line.slice(0, cw - 1) + "…" : line;
    return `${indent}${clipped}`;
  });
}

// --- Tool call formatting (Pi style) ---
// Pi: bold("read") + " " + accent(path) + warning(range)
// We use: bold tool name + cyan args

function formatToolCall(tool: string, args: Record<string, unknown>): { name: string; detail: string } {
  switch (tool) {
    case "read": {
      const path = args.path as string;
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      const range = offset ? `:${offset}-${(offset ?? 1) + (limit ?? 200) - 1}` : "";
      return { name: "read", detail: `${path}${range}` };
    }
    case "grep": {
      const pattern = args.pattern as string;
      const searchPath = (args.path as string) ?? ".";
      const include = args.include as string | undefined;
      return { name: "grep", detail: `/${pattern}/ in ${searchPath}${include ? ` (${include})` : ""}` };
    }
    case "glob":
      return { name: "glob", detail: `${args.pattern as string}${args.path ? ` in ${args.path as string}` : ""}` };
    case "bash":
      return { name: "bash", detail: args.command as string };
    case "verdict":
      return { name: "verdict", detail: "" };
    default:
      return { name: tool, detail: JSON.stringify(args) };
  }
}

// --- Main component ---

export function AgentPanel({
  events, isActive, width,
  showFollowUpInput, onFollowUp, onPermissionResolve,
}: {
  events: AgentEvent[];
  isActive: boolean;
  width: number;
  showFollowUpInput?: boolean;
  onFollowUp?: (question: string) => void;
  onPermissionResolve?: (decision: "once" | "always" | "deny") => void;
}) {
  const [followUpText, setFollowUpText] = useState("");
  const w = width - 2;

  if (events.length === 0 && !isActive) {
    return <Box padding={1}><Text dimColor>Press Enter to start investigating.</Text></Box>;
  }

  const collapsed = collapseEvents(events);

  return (
    <Box flexDirection="column" padding={1} overflow="hidden">
      {collapsed.map((item, i) => {
        if (item.type === "thinking_block") {
          return (
            <Box key={i} flexDirection="column" marginBottom={1}>
              {wrapText(item.text, w).map((line, li) => (
                <L key={li} dimColor>{line}</L>
              ))}
            </Box>
          );
        }
        return <EventBlock key={i} event={item as AgentEvent} maxWidth={w} />;
      })}

      {isActive && events.length > 0 && (
        <Box marginTop={1}><Text color="yellow">  Investigating...</Text></Box>
      )}

      {/* Permission prompt */}
      {(() => {
        const perm = [...events].reverse().find((e: AgentEvent) => e.type === "permission_request");
        if (perm && perm.type === "permission_request" && onPermissionResolve) {
          return (
            <Box flexDirection="column" marginTop={1} paddingX={2}>
              <L color="yellow" bold>Permission required</L>
              <L dimColor>{perm.path}</L>
              <Box>
                <Text>
                  <Text color="green" bold>[a]</Text>{" once  "}
                  <Text color="cyan" bold>[d]</Text>{" dir always  "}
                  <Text color="red" bold>[x]</Text>{" deny"}
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
            onSubmit={(v) => { if (v.trim()) { onFollowUp(v.trim()); setFollowUpText(""); } }}
            placeholder="Ask a follow-up question..."
          />
        </Box>
      )}
    </Box>
  );
}

// --- Event rendering ---

function EventBlock({ event, maxWidth }: { event: AgentEvent; maxWidth: number }) {
  switch (event.type) {
    case "tool_start": {
      // Pi style: bold(name) + accent(detail)
      const { name, detail } = formatToolCall(event.tool, event.args);
      const line = detail ? `${name} ${detail}` : name;
      return (
        <Box marginTop={1}>
          <Text>
            <Text color="gray">  </Text>
            <Text bold>{name}</Text>
            {detail ? <Text color="cyan">{` ${clip(detail, maxWidth - name.length - 3)}`}</Text> : null}
          </Text>
        </Box>
      );
    }

    case "tool_result": {
      // read/glob: tool_start already shows what's happening — no need to echo file content
      if (event.tool === "read" || event.tool === "glob") return null;
      // grep/bash/verdict: show result lines (matches, command output, verdict JSON)
      const lines = formatToolResult(event.tool, event.summary, maxWidth);
      return (
        <Box flexDirection="column">
          {lines.map((line, i) => (
            <L key={i} dimColor>{line}</L>
          ))}
        </Box>
      );
    }

    case "thinking":
      return <L dimColor>{clip(event.delta, maxWidth)}</L>;

    case "verdict":
      return <VerdictBlock verdict={event.verdict} maxWidth={maxWidth} />;

    case "error":
      return <L color="red">{clip(`  ! ${event.message}`, maxWidth)}</L>;

    case "usage": {
      const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
      return <L dimColor>{`  Tokens: ${fmt(event.inputTokens)} in / ${fmt(event.outputTokens)} out`}</L>;
    }

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

// --- Verdict rendering ---

function VerdictBlock({ verdict, maxWidth }: { verdict: TriageVerdict; maxWidth: number }) {
  const color = { true_positive: "red", false_positive: "green", needs_review: "#FF8C00" }[verdict.verdict] ?? "white";
  const label = { true_positive: "TRUE POSITIVE", false_positive: "FALSE POSITIVE", needs_review: "NEEDS REVIEW" }[verdict.verdict] ?? verdict.verdict;
  const cw = maxWidth - 4;

  return (
    <Box flexDirection="column" marginTop={1} paddingX={2}>
      {/* Header */}
      <Box><Text bold color={color}>{`  ${label}`}</Text></Box>
      <L> </L>

      {/* Reasoning — word-wrapped */}
      <Box><Text bold>Reasoning: </Text></Box>
      <Box flexDirection="column">
        {wrapText(verdict.reasoning, cw).map((line, i) => (
          <L key={`r${i}`}>{line}</L>
        ))}
      </Box>

      {/* Evidence — each clipped */}
      {verdict.key_evidence.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box><Text bold>Evidence:</Text></Box>
          {verdict.key_evidence.map((e, i) => (
            <L key={`e${i}`} dimColor>{clip(`  - ${e}`, cw)}</L>
          ))}
        </Box>
      )}

      {/* Fix — word-wrapped */}
      {verdict.suggested_fix && (
        <Box flexDirection="column" marginTop={1}>
          <Box><Text bold>Fix:</Text></Box>
          {wrapText(verdict.suggested_fix, cw).map((line, i) => (
            <L key={`f${i}`}>{line}</L>
          ))}
        </Box>
      )}
    </Box>
  );
}
