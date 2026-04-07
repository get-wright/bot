import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface CommandDef {
  label: string;
  shortcut: string;
  action: () => void;
}

export interface CommandPanelProps {
  commands: CommandDef[];
  concurrency: number;
  onConcurrencyChange: (value: number) => void;
  onClose: () => void;
  width: number;
  height: number;
}

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 10;

export function CommandPanel({
  commands,
  concurrency,
  onConcurrencyChange,
  onClose,
  width,
  height,
}: CommandPanelProps) {
  const allItems = [
    ...commands.map((c) => ({ type: "command" as const, ...c })),
    { type: "concurrency" as const, label: "Concurrency", shortcut: "", action: () => {} },
  ];
  const [cursorIndex, setCursorIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape || input === "m") {
      onClose();
      return;
    }
    if (key.upArrow) {
      setCursorIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow) {
      setCursorIndex((prev) => Math.min(allItems.length - 1, prev + 1));
      return;
    }
    if (key.return) {
      const item = allItems[cursorIndex];
      if (item && item.type === "command") {
        item.action();
        onClose();
      }
      return;
    }
    // Left/right arrows adjust concurrency when on that row
    const item = allItems[cursorIndex];
    if (item?.type === "concurrency") {
      if (key.leftArrow) {
        onConcurrencyChange(Math.max(MIN_CONCURRENCY, concurrency - 1));
        return;
      }
      if (key.rightArrow) {
        onConcurrencyChange(Math.min(MAX_CONCURRENCY, concurrency + 1));
        return;
      }
    }
  });

  const panelWidth = Math.min(40, width - 10);
  const panelHeight = allItems.length + 5;
  const padTop = Math.max(0, Math.floor((height - panelHeight) / 2));

  const isConcurrencyRow = allItems[cursorIndex]?.type === "concurrency";
  const footerHint = isConcurrencyRow
    ? "↑↓ navigate · ←→ adjust · Esc close"
    : "↑↓ navigate · Enter select · Esc close";

  return (
    <Box flexDirection="column" width={width} height={height}>
      {padTop > 0 && <Box height={padTop} />}
      <Box justifyContent="center">
        <Box
          flexDirection="column"
          width={panelWidth}
          borderStyle="round"
          paddingX={1}
        >
          <Text bold>Commands</Text>
          <Text> </Text>
          {allItems.map((item, i) => {
            const isSelected = i === cursorIndex;
            const contentWidth = panelWidth - 4; // border + paddingX
            if (item.type === "concurrency") {
              const right = `← ${concurrency} →`;
              const gap = Math.max(1, contentWidth - item.label.length - right.length);
              return (
                <Box key="concurrency">
                  <Text
                    bold={isSelected}
                    inverse={isSelected}
                  >
                    {item.label}{"".padEnd(gap)}{right}
                  </Text>
                </Box>
              );
            }
            const gap = Math.max(1, contentWidth - item.label.length - item.shortcut.length);
            return (
              <Box key={item.label}>
                <Text
                  bold={isSelected}
                  inverse={isSelected}
                >
                  {item.label}{"".padEnd(gap)}
                  <Text dimColor={!isSelected}>{item.shortcut}</Text>
                </Text>
              </Box>
            );
          })}
          <Text> </Text>
          <Text dimColor>{footerHint}</Text>
        </Box>
      </Box>
    </Box>
  );
}
