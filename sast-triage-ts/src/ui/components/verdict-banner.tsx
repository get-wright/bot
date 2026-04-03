import React from "react";
import { Box, Text } from "ink";
import type { TriageVerdict } from "../../models/verdict.js";

const VERDICT_COLORS: Record<string, string> = {
  true_positive: "red",
  false_positive: "green",
  needs_review: "#FF8C00",
};

const VERDICT_LABELS: Record<string, string> = {
  true_positive: "TRUE POSITIVE",
  false_positive: "FALSE POSITIVE",
  needs_review: "NEEDS REVIEW",
};

export function VerdictBanner({ verdict }: { verdict: TriageVerdict }) {
  const color = VERDICT_COLORS[verdict.verdict] ?? "white";
  const label = VERDICT_LABELS[verdict.verdict] ?? verdict.verdict;
  return (
    <Box flexDirection="column" marginTop={1} paddingX={2}>
      <Box>
        <Text bold color={color}>
          # {label}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text bold>Reasoning: </Text>
          {verdict.reasoning}
        </Text>
      </Box>
      {verdict.key_evidence.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Evidence:</Text>
          {verdict.key_evidence.map((e, i) => (
            <Text key={i}>  - {e}</Text>
          ))}
        </Box>
      )}
      {verdict.suggested_fix && (
        <Box marginTop={1}>
          <Text>
            <Text bold>Fix: </Text>
            {verdict.suggested_fix}
          </Text>
        </Box>
      )}
    </Box>
  );
}
