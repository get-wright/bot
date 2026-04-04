import React from "react";
import { Box, Text } from "ink";

export type FindingStatus = "pending" | "in_progress" | "true_positive" | "false_positive" | "needs_review";

export interface FindingEntry {
  fingerprint: string;
  ruleId: string;
  fileLine: string;
  severity: string;
  status: FindingStatus;
}

const STATUS_COLORS: Record<FindingStatus, string> = {
  pending: "gray",
  in_progress: "yellow",
  true_positive: "red",
  false_positive: "green",
  needs_review: "#FF8C00",
};

const STATUS_ICONS: Record<FindingStatus, string> = {
  pending: " ",
  in_progress: "~",
  true_positive: "!",
  false_positive: ".",
  needs_review: "?",
};

export function FindingsTable({
  findings,
  selectedIndex,
  triaged,
  selectedIndices,
}: {
  findings: FindingEntry[];
  selectedIndex: number;
  triaged: number;
  selectedIndices?: Set<number>;
}) {
  const sel = selectedIndices ?? new Set<number>();
  return (
    <Box flexDirection="column" width="100%">
      <Box marginBottom={1}>
        <Text bold>
          Findings {triaged}/{findings.length}
          {sel.size > 0 ? ` (${sel.size} selected)` : ""}
        </Text>
      </Box>
      {findings.map((f, i) => {
        const highlighted = i === selectedIndex;
        const color = STATUS_COLORS[f.status];
        const icon = STATUS_ICONS[f.status];
        const ruleShort = f.ruleId.split(".").pop() ?? f.ruleId;
        const mark = sel.has(i) ? "●" : " ";
        return (
          <Box key={`${f.fingerprint}-${i}`}>
            <Text color={color}>
              {highlighted ? ">" : " "}{mark} {icon} {ruleShort.slice(0, 20).padEnd(20)} {f.fileLine}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
