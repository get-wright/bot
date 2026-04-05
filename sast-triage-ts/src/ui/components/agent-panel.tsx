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
    if (para === "") { out.push(""); continue; }
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

// --- Tool call formatting ---

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

  // Partition events: investigation log (tool calls) and verdict
  const toolCalls: { name: string; detail: string }[] = [];
  let verdict: TriageVerdict | undefined;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let error: string | undefined;
  let followUpQuestion: string | undefined;
  let permissionEvent: Extract<AgentEvent, { type: "permission_request" }> | undefined;

  for (const ev of events) {
    switch (ev.type) {
      case "tool_start":
        if (ev.tool !== "verdict") {
          toolCalls.push(formatToolCall(ev.tool, ev.args));
        }
        break;
      case "verdict":
        verdict = ev.verdict;
        break;
      case "usage":
        usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
        break;
      case "error":
        error = ev.message;
        break;
      case "followup_start":
        followUpQuestion = ev.question;
        break;
      case "permission_request":
        permissionEvent = ev;
        break;
    }
  }

  const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  return (
    <Box flexDirection="column" padding={1} overflow="hidden">
      {/* Investigation log — compact tool calls */}
      {toolCalls.map((tc, i) => (
        <Box key={`t${i}`}>
          <Text>
            <Text dimColor>  ● </Text>
            <Text bold>{tc.name}</Text>
            {tc.detail ? <Text color="cyan">{` ${clip(tc.detail, w - tc.name.length - 5)}`}</Text> : null}
          </Text>
        </Box>
      ))}

      {/* Active spinner */}
      {isActive && !verdict && (
        <Box marginTop={toolCalls.length > 0 ? 1 : 0}>
          <Text color="yellow">  ◌ Investigating...</Text>
        </Box>
      )}

      {/* Error */}
      {error && (
        <Box marginTop={1}>
          <Text color="red">{clip(`  ✗ ${error}`, w)}</Text>
        </Box>
      )}

      {/* Permission prompt */}
      {permissionEvent && onPermissionResolve && (
        <Box flexDirection="column" marginTop={1} paddingX={2}>
          <Box><Text color="yellow" bold>Permission required</Text></Box>
          <Box><Text dimColor>{permissionEvent.path}</Text></Box>
          <Box>
            <Text>
              <Text color="green" bold>[a]</Text>{" once  "}
              <Text color="cyan" bold>[d]</Text>{" dir always  "}
              <Text color="red" bold>[x]</Text>{" deny"}
            </Text>
          </Box>
        </Box>
      )}

      {/* Verdict card */}
      {verdict && <VerdictCard verdict={verdict} width={w} />}

      {/* Token usage — below card */}
      {usage && (
        <Box marginTop={verdict ? 1 : 0}>
          <Text dimColor>{`  ${fmt(usage.inputTokens)} in / ${fmt(usage.outputTokens)} out`}</Text>
        </Box>
      )}

      {/* Follow-up question display */}
      {followUpQuestion && (
        <Box marginTop={1}>
          <Text color="cyan" bold>{clip(`  > ${followUpQuestion}`, w)}</Text>
        </Box>
      )}

      {/* Follow-up input */}
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

// --- Verdict card ---

function VerdictCard({ verdict, width }: { verdict: TriageVerdict; width: number }) {
  const color = {
    true_positive: "red" as const,
    false_positive: "green" as const,
    needs_review: "yellow" as const,
  }[verdict.verdict] ?? "white" as const;

  const label = {
    true_positive: "TRUE POSITIVE",
    false_positive: "FALSE POSITIVE",
    needs_review: "NEEDS REVIEW",
  }[verdict.verdict] ?? verdict.verdict.toUpperCase();

  // Content width = total width - border(2) - inner padding(2)
  const cw = width - 4;

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      overflow="hidden"
    >
      {/* Header */}
      <Box>
        <Text bold color={color}>{label}</Text>
      </Box>

      {/* Reasoning */}
      {verdict.reasoning && (
        <Box flexDirection="column" marginTop={1}>
          {wrapText(verdict.reasoning, cw).map((line, i) => (
            <Box key={`r${i}`}><Text>{line}</Text></Box>
          ))}
        </Box>
      )}

      {/* Evidence */}
      {verdict.key_evidence.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box><Text bold dimColor>Evidence</Text></Box>
          {verdict.key_evidence.map((e, i) => {
            const lines = wrapText(e, cw - 4);
            return (
              <Box key={`e${i}`} flexDirection="column">
                {lines.map((line, li) => (
                  <Box key={`e${i}-${li}`}>
                    <Text dimColor>{li === 0 ? `  · ${line}` : `    ${line}`}</Text>
                  </Box>
                ))}
              </Box>
            );
          })}
        </Box>
      )}

      {/* Fix */}
      {verdict.suggested_fix && (
        <Box flexDirection="column" marginTop={1}>
          <Box><Text bold dimColor>Fix</Text></Box>
          {wrapText(verdict.suggested_fix, cw).map((line, i) => (
            <Box key={`f${i}`}><Text>{line}</Text></Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
