import React from "react";
import { Box, Text } from "ink";

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
      <Text> </Text>
      <Text dimColor>q: quit</Text>
      <Text dimColor>Enter: triage</Text>
      <Text dimColor>Tab: switch view</Text>
    </Box>
  );
}
