import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { SUPPORTED_PROVIDERS, detectProviders } from "../../provider/registry.js";
import type { ProviderName } from "../../provider/registry.js";

const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  google: "gemini-2.5-pro",
  openrouter: "anthropic/claude-sonnet-4",
};

export interface SetupResult {
  provider: string;
  model: string;
  findingsPath: string;
}

type SetupStep = "trust" | "provider" | "model" | "file";

export function SetupScreen({ cwd, onComplete }: { cwd: string; onComplete: (result: SetupResult) => void }) {
  const [step, setStep] = useState<SetupStep>("trust");
  const [providerIndex, setProviderIndex] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState<ProviderName>("openai");
  const [modelInput, setModelInput] = useState("");
  const [fileInput, setFileInput] = useState("findings.json");

  const providers = detectProviders();

  useInput((input, key) => {
    if (step === "trust") {
      if (input === "y") {
        const firstAvailable = providers.find((p) => p.hasKey);
        if (firstAvailable) {
          setProviderIndex(SUPPORTED_PROVIDERS.indexOf(firstAvailable.name));
        }
        setStep("provider");
      }
      if (input === "n") process.exit(0);
    }

    if (step === "provider") {
      if (key.upArrow && providerIndex > 0) setProviderIndex(providerIndex - 1);
      if (key.downArrow && providerIndex < providers.length - 1) setProviderIndex(providerIndex + 1);
      if (key.return) {
        const chosen = providers[providerIndex]!;
        setSelectedProvider(chosen.name);
        setModelInput(DEFAULT_MODELS[chosen.name]);
        setStep("model");
      }
    }
  });

  if (step === "trust") {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">sast-triage</Text>
        <Text> </Text>
        <Text>Do you trust the files in this folder?</Text>
        <Text> </Text>
        <Text dimColor>{cwd}</Text>
        <Text> </Text>
        <Text><Text bold color="green">y</Text> — yes, trust   <Text bold color="red">n</Text> — no, exit</Text>
      </Box>
    );
  }

  if (step === "provider") {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Select Provider</Text>
        <Text> </Text>
        {providers.map((p, i) => {
          const selected = i === providerIndex;
          const indicator = selected ? ">" : " ";
          const keyStatus = p.hasKey ? <Text color="green"> ●</Text> : <Text color="red"> ○ no key</Text>;
          return (
            <Text key={p.name}>
              <Text color={selected ? "cyan" : undefined} bold={selected}> {indicator} {p.name}</Text>
              {keyStatus}
            </Text>
          );
        })}
        <Text> </Text>
        <Text dimColor>↑/↓ to select, Enter to confirm</Text>
      </Box>
    );
  }

  if (step === "model") {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Model</Text>
        <Text dimColor>Provider: {selectedProvider}</Text>
        <Text> </Text>
        <Box>
          <Text>Model: </Text>
          <TextInput
            value={modelInput}
            onChange={setModelInput}
            onSubmit={() => setStep("file")}
          />
        </Box>
        <Text> </Text>
        <Text dimColor>Enter to confirm</Text>
      </Box>
    );
  }

  // step === "file"
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>Findings File</Text>
      <Text dimColor>Provider: {selectedProvider} / {modelInput}</Text>
      <Text> </Text>
      <Box>
        <Text>Path: </Text>
        <TextInput
          value={fileInput}
          onChange={setFileInput}
          onSubmit={(value) => {
            onComplete({
              provider: selectedProvider,
              model: modelInput,
              findingsPath: value || "findings.json",
            });
          }}
        />
      </Box>
      <Text> </Text>
      <Text dimColor>Enter to start (relative to project root)</Text>
    </Box>
  );
}
