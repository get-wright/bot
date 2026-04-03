import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { SUPPORTED_PROVIDERS } from "../../provider/registry.js";
import type { ProviderName } from "../../provider/registry.js";
import { ProjectConfig } from "../../config/project-config.js";

const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  google: "gemini-2.5-pro",
  openrouter: "anthropic/claude-sonnet-4",
};

export interface SetupResult {
  provider: string;
  model: string;
  apiKey: string | undefined;
  findingsPath: string;
}

type SetupStep = "trust" | "provider" | "apikey" | "model" | "file";
const STEP_ORDER: SetupStep[] = ["trust", "provider", "apikey", "model", "file"];

function prevStep(current: SetupStep): SetupStep | null {
  const idx = STEP_ORDER.indexOf(current);
  return idx > 0 ? STEP_ORDER[idx - 1]! : null;
}

export function SetupScreen({
  cwd,
  projectConfig,
  onComplete,
}: {
  cwd: string;
  projectConfig: ProjectConfig;
  onComplete: (result: SetupResult) => void;
}) {
  const saved = projectConfig.hasConfig();
  const [step, setStep] = useState<SetupStep>("trust");
  const [providerIndex, setProviderIndex] = useState(() => {
    const idx = SUPPORTED_PROVIDERS.indexOf(projectConfig.provider);
    return idx >= 0 ? idx : 0;
  });
  const [selectedProvider, setSelectedProvider] = useState<ProviderName>(projectConfig.provider);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [modelInput, setModelInput] = useState(projectConfig.model);
  const [fileInput, setFileInput] = useState("findings.json");

  const providers = projectConfig.detectedProviders();

  const goBack = () => {
    const prev = prevStep(step);
    if (prev) setStep(prev);
  };

  useInput((input, key) => {
    if (step === "trust") {
      if (input === "y") setStep("provider");
      if (input === "n") process.exit(0);
      return;
    }

    // Escape goes back on all steps after trust
    if (key.escape) {
      goBack();
      return;
    }

    if (step === "provider") {
      if (key.upArrow && providerIndex > 0) setProviderIndex(providerIndex - 1);
      if (key.downArrow && providerIndex < providers.length - 1) setProviderIndex(providerIndex + 1);
      if (key.return) {
        const chosen = providers[providerIndex]!;
        setSelectedProvider(chosen.name);
        setModelInput(DEFAULT_MODELS[chosen.name]);
        setApiKeyInput("");
        setStep("apikey");
      }
    }
  });

  // --- Trust ---
  if (step === "trust") {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="cyan">sast-triage</Text>
        <Text> </Text>
        <Text>Do you trust the files in this folder?</Text>
        <Text> </Text>
        <Text dimColor>{cwd}</Text>
        <Text> </Text>
        <Text>
          <Text bold color="green">y</Text> — yes, trust {"  "}
          <Text bold color="red">n</Text> — no, exit
        </Text>
      </Box>
    );
  }

  // --- Provider ---
  if (step === "provider") {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Select Provider</Text>
        {saved && <Text dimColor>Saved config: {projectConfig.provider} / {projectConfig.model}</Text>}
        <Text> </Text>
        {providers.map((p, i) => {
          const sel = i === providerIndex;
          const indicator = sel ? ">" : " ";
          const keyStatus = p.hasKey ? (
            <Text color="green"> ●</Text>
          ) : (
            <Text color="red"> ○ no key</Text>
          );
          return (
            <Text key={p.name}>
              <Text color={sel ? "cyan" : undefined} bold={sel}>
                {" "}{indicator} {p.name}
              </Text>
              {keyStatus}
            </Text>
          );
        })}
        <Text> </Text>
        <Text dimColor>↑/↓ select · Enter confirm · Esc back</Text>
      </Box>
    );
  }

  // --- API Key ---
  if (step === "apikey") {
    const envHasKey = providers.find((p) => p.name === selectedProvider)?.hasKey;
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>API Key</Text>
        <Text dimColor>Provider: {selectedProvider}</Text>
        <Text> </Text>
        {envHasKey && <Text color="green">● Environment variable detected</Text>}
        <Text> </Text>
        <Box>
          <Text>API Key: </Text>
          <TextInput
            value={apiKeyInput}
            onChange={setApiKeyInput}
            mask="*"
            onSubmit={() => setStep("model")}
          />
        </Box>
        <Text> </Text>
        <Text dimColor>
          {envHasKey
            ? "Enter to skip (use env var) · Or paste key to override · Esc back"
            : "Paste your API key · Enter to confirm · Esc back"}
        </Text>
      </Box>
    );
  }

  // --- Model ---
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
        <Text dimColor>Enter to confirm · Esc back</Text>
      </Box>
    );
  }

  // --- File ---
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>Findings File</Text>
      <Text dimColor>
        {selectedProvider} / {modelInput}
      </Text>
      <Text> </Text>
      <Box>
        <Text>Path: </Text>
        <TextInput
          value={fileInput}
          onChange={setFileInput}
          onSubmit={(value) => {
            // Save config for next launch
            projectConfig.provider = selectedProvider;
            projectConfig.model = modelInput;
            projectConfig.apiKey = apiKeyInput || undefined;
            projectConfig.save();

            onComplete({
              provider: selectedProvider,
              model: modelInput,
              apiKey: apiKeyInput || projectConfig.resolvedApiKey(),
              findingsPath: value || "findings.json",
            });
          }}
        />
      </Box>
      <Text> </Text>
      <Text dimColor>Enter to start · Esc back</Text>
    </Box>
  );
}
