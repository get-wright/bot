import React from "react";
import { Box, Text } from "ink";

export interface QueueItem {
  label: string;
  status: "pending" | "done" | "active";
  verdict?: string;
}

export interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function Sidebar({
  total,
  active,
  filtered,
  triaged,
  tp,
  fp,
  nr,
  provider,
  model,
  queue,
  sessionUsage,
  currentUsage,
}: {
  total: number;
  active: number;
  filtered: number;
  triaged: number;
  tp: number;
  fp: number;
  nr: number;
  provider: string;
  model: string;
  queue?: QueueItem[];
  sessionUsage?: UsageStats;
  currentUsage?: UsageStats;
}) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Stats</Text>
      <Text>Total: {total}</Text>
      <Text>Active: {active}</Text>
      <Text>Filtered: {filtered}</Text>
      <Text>Done: {triaged}</Text>
      <Text> </Text>
      <Text color="red">TP: {tp}</Text>
      <Text color="green">FP: {fp}</Text>
      <Text color="#FF8C00">NR: {nr}</Text>
      <Text> </Text>
      <Text bold>Model</Text>
      <Text dimColor>{provider}</Text>
      <Text dimColor>{model}</Text>
      {queue && queue.length > 0 && (
        <>
          <Text> </Text>
          <Text bold>
            Queue: {queue.filter((q) => q.status === "done").length}/{queue.length}
          </Text>
          {queue.map((item, i) => {
            const icon = item.status === "done" ? "✓" : item.status === "active" ? "▸" : " ";
            const verdictLabel = item.verdict
              ? item.verdict === "true_positive"
                ? "TP"
                : item.verdict === "false_positive"
                  ? "FP"
                  : "NR"
              : "";
            const verdictColor =
              item.verdict === "true_positive"
                ? "red"
                : item.verdict === "false_positive"
                  ? "green"
                  : item.verdict === "needs_review"
                    ? "#FF8C00"
                    : undefined;
            return (
              <Text key={i} dimColor={item.status === "pending"}>
                {"  "}{icon} {item.label.slice(0, 16)}
                {verdictLabel ? <Text color={verdictColor}> {verdictLabel}</Text> : ""}
              </Text>
            );
          })}
        </>
      )}
      {currentUsage && (
        <>
          <Text> </Text>
          <Text bold>Tokens</Text>
          <Text dimColor>
            {formatTokens(currentUsage.inputTokens)} in / {formatTokens(currentUsage.outputTokens)} out
          </Text>
        </>
      )}
      {sessionUsage && sessionUsage.totalTokens > 0 && (
        <Text dimColor>
          Session: {formatTokens(sessionUsage.totalTokens)}
        </Text>
      )}
      <Text> </Text>
      <Text dimColor>q: quit</Text>
      <Text dimColor>Enter: triage</Text>
      <Text dimColor>Space: select</Text>
      <Text dimColor>a: select all</Text>
      <Text dimColor>Tab: switch view</Text>
      <Text dimColor>r: re-audit</Text>
      <Text dimColor>f: follow-up</Text>
      <Text dimColor>^P: provider</Text>
    </Box>
  );
}
