import React from "react";
import { Box, Text } from "ink";
import { PROVIDER_DISPLAY_NAMES, type ProviderName } from "../../provider/registry.js";

export interface QueueItem {
  label: string;
  status: "active";
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
  queueDone,
  queueTotal,
  sessionUsage,
  currentUsage,
  tracingActive,
  width,
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
  queueDone?: number;
  queueTotal?: number;
  sessionUsage?: UsageStats;
  currentUsage?: UsageStats;
  tracingActive?: boolean;
  width?: number;
}) {
  const maxLabelLen = (width ?? 20) - 6; // "  ▸ " prefix + padding

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
      <Text dimColor>{PROVIDER_DISPLAY_NAMES[provider as ProviderName] ?? provider}</Text>
      <Text dimColor>{model}</Text>
      {tracingActive && <Text color="cyan">LangSmith ON</Text>}
      {queue && queue.length > 0 && queueTotal != null && queueDone != null && (
        <>
          <Text> </Text>
          <Text bold>Queue {queueDone}/{queueTotal}</Text>
          {queue.map((item, i) => {
            const label = item.label.length > maxLabelLen
              ? item.label.slice(0, maxLabelLen - 1) + "…"
              : item.label;
            return (
              <Text key={i} color="yellow">
                {"  "}▸ {label}
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
      <Text dimColor>m: commands</Text>
    </Box>
  );
}
