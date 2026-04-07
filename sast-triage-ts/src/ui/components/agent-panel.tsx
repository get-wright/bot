import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { AgentEvent } from "../../models/events.js";
import type { TriageVerdict } from "../../models/verdict.js";
import type { Finding } from "../../models/finding.js";

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

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())} - ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  } catch {
    return iso;
  }
}

// --- Line-based rendering for scroll ---

type VerdictColor = "red" | "green" | "yellow" | "white";

type Line =
  | { kind: "tool"; name: string; detail: string }
  | { kind: "blank" }
  | { kind: "spinner"; text: string }
  | { kind: "error"; text: string }
  | { kind: "verdict-head"; label: string; color: VerdictColor }
  | { kind: "verdict-blank"; color: VerdictColor }
  | { kind: "verdict-text"; text: string; color: VerdictColor }
  | { kind: "verdict-label"; text: string; color: VerdictColor }
  | { kind: "verdict-evidence"; text: string; color: VerdictColor }
  | { kind: "usage"; left: string; right: string }
  | { kind: "followup-q"; text: string }
  | { kind: "followup-a"; text: string };

function verdictStyle(v: TriageVerdict["verdict"]): { color: VerdictColor; label: string } {
  switch (v) {
    case "true_positive": return { color: "red", label: "TRUE POSITIVE" };
    case "false_positive": return { color: "green", label: "FALSE POSITIVE" };
    case "needs_review": return { color: "yellow", label: "NEEDS REVIEW" };
    default: return { color: "white", label: String(v).toUpperCase() };
  }
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const SEVERITY_COLORS: Record<string, string> = {
  ERROR: "red",
  WARNING: "#FF8C00",
  INFO: "gray",
};

/** Extract CWE code from "CWE-269: Improper Privilege Management" → "CWE-269" */
function cweCode(cwe: string): string {
  const colon = cwe.indexOf(":");
  return colon > 0 ? cwe.slice(0, colon).trim() : cwe.trim();
}

/** Calculate how many terminal lines the FindingHeader will occupy. */
export function findingHeaderHeight(finding: Finding, width: number): number {
  // Inner width: subtract border (2) + paddingX (2)
  const innerW = Math.max(1, width - 4);
  const message = finding.extra.message;
  const messageLines = message ? wrapText(message, innerW).length : 0;
  // border top(1) + severity(1) + rule(1) + fileLine(1) + messageLines + border bottom(1) + marginBottom(1)
  return 5 + messageLines;
}

function FindingHeader({ finding, width }: { finding: Finding; width: number }) {
  // Inner width: subtract border (2) + paddingX (2)
  const innerW = Math.max(1, width - 4);
  const severity = finding.extra.severity;
  const sevColor = SEVERITY_COLORS[severity] ?? "white";
  const ruleShort = finding.check_id.split(".").pop() ?? finding.check_id;
  const fileLine = `${finding.path}:${finding.start.line}`;
  const cwes = finding.extra.metadata.cwe;
  const vulnClass = finding.extra.metadata.vulnerability_class;
  const message = finding.extra.message;

  const metaParts: string[] = [];
  if (cwes.length > 0) metaParts.push(cwes.map(cweCode).join(", "));
  if (vulnClass.length > 0) metaParts.push(vulnClass.join(", "));
  const metaStr = metaParts.join(" · ");

  const wrappedMessage = message ? wrapText(message, innerW) : [];

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} marginBottom={1} overflow="hidden">
      <Box overflow="hidden">
        <Text color={sevColor} bold>{severity}</Text>
        {metaStr ? <Text dimColor> · {clip(metaStr, Math.max(1, innerW - severity.length - 4))}</Text> : null}
      </Box>
      <Box overflow="hidden"><Text color="yellow" bold>{clip(ruleShort, innerW)}</Text></Box>
      <Box overflow="hidden"><Text color="cyan">{clip(fileLine, innerW)}</Text></Box>
      {wrappedMessage.map((line, i) => (
        <Box key={i} overflow="hidden"><Text dimColor>{line}</Text></Box>
      ))}
    </Box>
  );
}

function buildLines(params: {
  toolCalls: { name: string; detail: string }[];
  isActive: boolean;
  verdict?: TriageVerdict;
  usage?: { inputTokens: number; outputTokens: number };
  cachedAt?: string;
  error?: string;
  followUpQuestion?: string;
  followUpAnswer?: string;
  w: number;
}): Line[] {
  const { toolCalls, isActive, verdict, usage, cachedAt, error, followUpQuestion, followUpAnswer, w } = params;
  const lines: Line[] = [];

  for (const tc of toolCalls) {
    lines.push({ kind: "tool", name: tc.name, detail: tc.detail });
  }

  if (isActive && !verdict) {
    if (lines.length > 0) lines.push({ kind: "blank" });
    lines.push({ kind: "spinner", text: "◌ Investigating..." });
  }

  if (error) {
    if (lines.length > 0) lines.push({ kind: "blank" });
    lines.push({ kind: "error", text: `✗ ${error}` });
  }

  if (verdict) {
    const { color, label } = verdictStyle(verdict.verdict);
    const cw = Math.max(10, w - 2); // reserve "│ " prefix

    if (lines.length > 0) lines.push({ kind: "blank" });
    lines.push({ kind: "verdict-head", label, color });

    if (verdict.reasoning) {
      lines.push({ kind: "verdict-blank", color });
      for (const wrapped of wrapText(verdict.reasoning, cw)) {
        lines.push({ kind: "verdict-text", text: wrapped, color });
      }
    }

    if (verdict.key_evidence.length > 0) {
      lines.push({ kind: "verdict-blank", color });
      lines.push({ kind: "verdict-label", text: "Evidence", color });
      for (const e of verdict.key_evidence) {
        const wrappedLines = wrapText(e, Math.max(4, cw - 4));
        wrappedLines.forEach((line, li) => {
          lines.push({
            kind: "verdict-evidence",
            text: li === 0 ? `  · ${line}` : `    ${line}`,
            color,
          });
        });
      }
    }

    if (verdict.suggested_fix) {
      lines.push({ kind: "verdict-blank", color });
      lines.push({ kind: "verdict-label", text: "Fix", color });
      for (const wrapped of wrapText(verdict.suggested_fix, cw)) {
        lines.push({ kind: "verdict-text", text: wrapped, color });
      }
    }
  }

  if (usage || cachedAt) {
    lines.push({ kind: "blank" });
    lines.push({
      kind: "usage",
      left: usage ? `${fmtTokens(usage.inputTokens)} in / ${fmtTokens(usage.outputTokens)} out` : "",
      right: cachedAt ? formatTimestamp(cachedAt) : "",
    });
  }

  if (followUpQuestion) {
    lines.push({ kind: "blank" });
    lines.push({ kind: "followup-q", text: `> ${followUpQuestion}` });
    if (followUpAnswer) {
      lines.push({ kind: "blank" });
      const answerLines = followUpAnswer.split("\n");
      for (const line of answerLines) {
        lines.push({ kind: "followup-a", text: line });
      }
    }
  }

  return lines;
}

function renderLine(line: Line, w: number, key: string): React.ReactElement {
  switch (line.kind) {
    case "tool":
      return (
        <Box key={key}>
          <Text>
            <Text dimColor>  ● </Text>
            <Text bold>{line.name}</Text>
            {line.detail ? <Text color="cyan">{` ${clip(line.detail, Math.max(1, w - line.name.length - 5))}`}</Text> : null}
          </Text>
        </Box>
      );
    case "blank":
      return <Box key={key}><Text> </Text></Box>;
    case "spinner":
      return <Box key={key}><Text color="yellow">  {line.text}</Text></Box>;
    case "error":
      return <Box key={key}><Text color="red">{clip(`  ${line.text}`, w)}</Text></Box>;
    case "verdict-head":
      return (
        <Box key={key}>
          <Text color={line.color}>│ </Text>
          <Text color={line.color} bold>{line.label}</Text>
        </Box>
      );
    case "verdict-blank":
      return <Box key={key}><Text color={line.color}>│</Text></Box>;
    case "verdict-text":
      return (
        <Box key={key}>
          <Text color={line.color}>│ </Text>
          <Text>{line.text}</Text>
        </Box>
      );
    case "verdict-label":
      return (
        <Box key={key}>
          <Text color={line.color}>│ </Text>
          <Text bold dimColor>{line.text}</Text>
        </Box>
      );
    case "verdict-evidence":
      return (
        <Box key={key}>
          <Text color={line.color}>│ </Text>
          <Text dimColor>{line.text}</Text>
        </Box>
      );
    case "usage":
      return (
        <Box key={key} width={w} justifyContent="space-between">
          <Text dimColor>{`  ${line.left}`}</Text>
          <Text dimColor>{line.right}</Text>
        </Box>
      );
    case "followup-q":
      return <Box key={key}><Text color="cyan" bold>{clip(`  ${line.text}`, w)}</Text></Box>;
    case "followup-a":
      return <Box key={key}><Text>{clip(`  ${line.text}`, w)}</Text></Box>;
  }
}

// --- Main component ---

export function AgentPanel({
  events, isActive, width, height, finding,
  showFollowUpInput, onFollowUp, onPermissionResolve, cachedAt,
}: {
  events: AgentEvent[];
  isActive: boolean;
  width: number;
  height: number;
  finding?: Finding;
  showFollowUpInput?: boolean;
  onFollowUp?: (question: string) => void;
  onPermissionResolve?: (decision: "once" | "always" | "deny") => void;
  cachedAt?: string;
}) {
  const [followUpText, setFollowUpText] = useState("");
  const [scrollOffset, setScrollOffset] = useState(0);
  const [userScrolled, setUserScrolled] = useState(false);
  const prevLineCountRef = useRef(0);

  const w = width - 2;

  // Partition events
  const toolCalls: { name: string; detail: string }[] = [];
  let verdict: TriageVerdict | undefined;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let error: string | undefined;
  let followUpQuestion: string | undefined;
  let followUpAnswer = "";
  let inFollowUp = false;
  let permissionEvent: Extract<AgentEvent, { type: "permission_request" }> | undefined;

  for (const ev of events) {
    switch (ev.type) {
      case "tool_start":
        if (ev.tool !== "verdict") toolCalls.push(formatToolCall(ev.tool, ev.args));
        break;
      case "verdict": verdict = ev.verdict; break;
      case "usage": usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens }; break;
      case "error": error = ev.message; break;
      case "followup_start": followUpQuestion = ev.question; inFollowUp = true; break;
      case "thinking":
        if (inFollowUp) followUpAnswer += ev.delta;
        break;
      case "permission_request": permissionEvent = ev; break;
    }
  }

  const lines = buildLines({ toolCalls, isActive, verdict, usage, cachedAt, error, followUpQuestion, followUpAnswer, w });

  const headerHeight = finding ? findingHeaderHeight(finding, w) : 0;

  // Footer reservation (interactive elements, always visible below viewport)
  const footerRows = permissionEvent ? 4 : (showFollowUpInput ? 2 : 0);

  // Content budget after padding={1} top+bottom, minus finding header
  const contentHeight = Math.max(1, height - 2 - headerHeight);
  const availableForLines = Math.max(1, contentHeight - footerRows);
  const canScroll = lines.length > availableForLines;
  const viewHeight = canScroll ? Math.max(1, availableForLines - 1) : availableForLines;
  const maxOffset = Math.max(0, lines.length - viewHeight);

  // Auto-follow: on new lines, stick to bottom unless user scrolled away.
  // Reset userScrolled when content shrinks (new audit, reset).
  useEffect(() => {
    const prev = prevLineCountRef.current;
    prevLineCountRef.current = lines.length;
    if (lines.length < prev) {
      setUserScrolled(false);
      setScrollOffset(0);
      return;
    }
    if (!userScrolled) {
      setScrollOffset(Math.max(0, lines.length - viewHeight));
    }
  }, [lines.length, viewHeight, userScrolled]);

  const clampedOffset = Math.min(scrollOffset, maxOffset);

  useInput((_input, key) => {
    if (showFollowUpInput) return;
    if (!canScroll) return;
    const page = Math.max(1, viewHeight - 1);
    if (key.pageUp || (key.upArrow && key.shift)) {
      setUserScrolled(true);
      setScrollOffset((o) => Math.max(0, Math.min(o, maxOffset) - page));
    } else if (key.pageDown || (key.downArrow && key.shift)) {
      setScrollOffset((o) => {
        const next = Math.min(maxOffset, Math.min(o, maxOffset) + page);
        setUserScrolled(next < maxOffset);
        return next;
      });
    } else if (key.home) {
      setUserScrolled(true);
      setScrollOffset(0);
    } else if (key.end) {
      setUserScrolled(false);
      setScrollOffset(maxOffset);
    }
  });

  if (events.length === 0 && !isActive) {
    return (
      <Box flexDirection="column" padding={1}>
        {finding && <FindingHeader finding={finding} width={w} />}
        <Text dimColor>Press Enter to start investigating.</Text>
      </Box>
    );
  }

  const visible = lines.slice(clampedOffset, clampedOffset + viewHeight);
  const above = clampedOffset;
  const below = Math.max(0, lines.length - clampedOffset - viewHeight);

  return (
    <Box flexDirection="column" padding={1}>
      {finding && <FindingHeader finding={finding} width={w} />}
      {visible.map((line, i) => renderLine(line, w, `v${clampedOffset + i}`))}
      {canScroll && (
        <Box width={w}>
          <Text dimColor>{clip(scrollIndicator(above, below), w)}</Text>
        </Box>
      )}
      {permissionEvent && onPermissionResolve && (
        <Box flexDirection="column" paddingX={2}>
          <Box><Text color="yellow" bold>Permission required</Text></Box>
          <Box><Text dimColor>{clip(permissionEvent.path, w - 4)}</Text></Box>
          <Box>
            <Text>
              <Text color="green" bold>[a]</Text>{" once  "}
              <Text color="cyan" bold>[d]</Text>{" dir always  "}
              <Text color="red" bold>[x]</Text>{" deny"}
            </Text>
          </Box>
        </Box>
      )}
      {showFollowUpInput && onFollowUp && (
        <Box paddingX={2}>
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

function scrollIndicator(above: number, below: number): string {
  const parts: string[] = [];
  if (above > 0) parts.push(`↑ ${above} above`);
  if (below > 0) parts.push(`↓ ${below} below`);
  parts.push("PgUp/PgDn · Home/End");
  return `  ${parts.join(" · ")}`;
}
