import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Finding } from "../../models/finding.js";

const CONTEXT_LINES = 5;

function clip(text: string, maxWidth: number): string {
  const expanded = text.replace(/\t/g, "    ");
  if (expanded.length <= maxWidth) return expanded;
  return expanded.slice(0, maxWidth - 1) + "…";
}

function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += maxWidth) {
    lines.push(text.slice(i, i + maxWidth));
  }
  return lines.length > 0 ? lines : [""];
}

function loadCodeSnippet(
  filePath: string,
  startLine: number,
  endLine: number,
): { lines: { num: number; text: string }[]; startLine: number; endLine: number } | null {
  try {
    const abs = resolve(process.cwd(), filePath);
    const content = readFileSync(abs, "utf-8");
    const allLines = content.split("\n");

    const from = Math.max(0, startLine - 1 - CONTEXT_LINES);
    const to = Math.min(allLines.length, endLine + CONTEXT_LINES);

    return {
      lines: allLines.slice(from, to).map((text, i) => ({
        num: from + i + 1,
        text,
      })),
      startLine,
      endLine,
    };
  } catch {
    return null;
  }
}

export function FindingDetail({
  finding,
  reason,
  label,
  hint,
  width,
}: {
  finding: Finding;
  reason: string;
  label: string;
  hint: string;
  width: number;
}) {
  const w = width - 4; // padding
  const cweStr = finding.extra.metadata.cwe.length > 0
    ? finding.extra.metadata.cwe.join(", ")
    : undefined;

  const snippet = useMemo(
    () => loadCodeSnippet(finding.path, finding.start.line, finding.end.line),
    [finding.path, finding.start.line, finding.end.line],
  );

  const gutterWidth = snippet
    ? String(snippet.lines[snippet.lines.length - 1]?.num ?? 0).length
    : 0;

  return (
    <Box flexDirection="column" padding={1} overflow="hidden">
      <Text bold>{clip(finding.check_id, w)}</Text>
      <Text dimColor>{clip(`${finding.path}:${finding.start.line}`, w)}</Text>
      <Text>
        Severity: <Text color={finding.extra.severity === "ERROR" ? "red" : "yellow"}>{finding.extra.severity}</Text>
      </Text>
      {cweStr && <Text dimColor>CWE: {clip(cweStr, w - 5)}</Text>}
      <Text> </Text>
      <Text color="yellow">{clip(`${label}: ${reason}`, w)}</Text>
      <Text> </Text>

      {/* Message with manual word wrapping */}
      {finding.extra.message && wrapText(finding.extra.message, w).map((line, i) => (
        <Text key={`msg-${i}`} dimColor>{line}</Text>
      ))}

      {/* Code snippet with context */}
      {snippet && (
        <>
          <Text> </Text>
          {snippet.lines.map((line) => {
            const isFlagged = line.num >= snippet.startLine && line.num <= snippet.endLine;
            const gutter = String(line.num).padStart(gutterWidth);
            const marker = isFlagged ? ">" : " ";
            const codeText = clip(`${marker} ${gutter} | ${line.text}`, w);
            return (
              <Text key={line.num} color={isFlagged ? "red" : undefined} bold={isFlagged}>
                {codeText}
              </Text>
            );
          })}
        </>
      )}

      {/* Flagged code from semgrep if file read failed */}
      {!snippet && finding.extra.lines && (
        <>
          <Text> </Text>
          <Text dimColor>{clip(finding.extra.lines, w)}</Text>
        </>
      )}

      <Text> </Text>
      <Text dimColor>{hint}</Text>
    </Box>
  );
}
