import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { SUPPORTED_PROVIDERS, PROVIDER_DISPLAY_NAMES } from "../../provider/registry.js";
import type { ProviderName } from "../../provider/registry.js";
import { ProjectConfig } from "../../config/project-config.js";

const DEFAULT_MODELS: Record<ProviderName, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  google: "gemini-2.5-pro",
  openrouter: "anthropic/claude-sonnet-4",
  fpt: "DeepSeek-R1",
};

export interface SetupResult {
  provider: string;
  model: string;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  findingsPath: string;
  reasoningEffort: string | undefined;
}

type SetupStep = "trust" | "provider" | "apikey" | "baseurl" | "model" | "effort" | "file";
const STEP_ORDER: SetupStep[] = ["trust", "provider", "apikey", "baseurl", "model", "effort", "file"];

function prevStep(current: SetupStep): SetupStep | null {
  const idx = STEP_ORDER.indexOf(current);
  return idx > 0 ? STEP_ORDER[idx - 1]! : null;
}

export function SetupScreen({
  cwd,
  projectConfig,
  onComplete,
  onCancel,
  startStep: startStepProp,
}: {
  cwd: string;
  projectConfig: ProjectConfig;
  onComplete: (result: SetupResult) => void;
  onCancel?: () => void;
  startStep?: SetupStep;
}) {
  const saved = projectConfig.hasConfig();
  const [step, setStep] = useState<SetupStep>(
    startStepProp ?? (saved ? "file" : "trust"),
  );
  const [providerIndex, setProviderIndex] = useState(() => {
    const idx = SUPPORTED_PROVIDERS.indexOf(projectConfig.provider);
    return idx >= 0 ? idx : 0;
  });
  const [selectedProvider, setSelectedProvider] = useState<ProviderName>(projectConfig.provider);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState(projectConfig.baseUrl ?? (projectConfig.provider === "openrouter" ? "https://openrouter.ai/api/v1" : ""));
  const [modelInput, setModelInput] = useState(projectConfig.model);
  const [fileInput, setFileInput] = useState("findings.json");
  const [effortIndex, setEffortIndex] = useState(() => {
    const efforts = ["low", "medium", "high"];
    const idx = efforts.indexOf(projectConfig.reasoningEffort ?? "");
    return idx >= 0 ? idx : -1; // -1 = none/skip
  });

  const providers = projectConfig.detectedProviders();

  // Auto-complete: saved config + findings.json exists → skip setup entirely
  // Skip when startStepProp is set (e.g. provider switch via Ctrl+P)
  useEffect(() => {
    if (startStepProp) return;
    if (saved) {
      onComplete({
        provider: projectConfig.provider,
        model: projectConfig.model,
        apiKey: projectConfig.resolvedApiKey(),
        baseUrl: projectConfig.baseUrl,
        findingsPath: "findings.json",
        reasoningEffort: projectConfig.reasoningEffort,
      });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

    // Escape: if we entered mid-flow (provider switch), always cancel back to main
    if (key.escape) {
      if (onCancel) {
        onCancel();
      } else {
        goBack();
      }
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
        setBaseUrlInput(
          chosen.name === "openrouter" ? "https://openrouter.ai/api/v1"
          : chosen.name === "fpt" ? "https://mkp-api.fptcloud.com/v1"
          : ""
        );
        setStep("apikey");
      }
    }

    if (step === "effort") {
      if (key.upArrow) {
        setEffortIndex((prev) => (prev <= -1 ? 2 : prev - 1));
      }
      if (key.downArrow) {
        setEffortIndex((prev) => (prev >= 2 ? -1 : prev + 1));
      }
      if (key.return) {
        setStep("file");
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
                {" "}{indicator} {PROVIDER_DISPLAY_NAMES[p.name]}
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
    const savedHasKey = !!projectConfig.savedApiKeys[selectedProvider];
    const envKeyName = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", google: "GOOGLE_API_KEY", openrouter: "OPENROUTER_API_KEY", fpt: "FPT_API_KEY" }[selectedProvider];
    const envHasKey = !!process.env[envKeyName];
    const hasAnyKey = savedHasKey || envHasKey;
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>API Key</Text>
        <Text dimColor>Provider: {PROVIDER_DISPLAY_NAMES[selectedProvider]}</Text>
        <Text> </Text>
        {savedHasKey && <Text color="green">● Saved key found</Text>}
        {!savedHasKey && envHasKey && <Text color="green">● Environment variable detected</Text>}
        <Text> </Text>
        <Box>
          <Text>API Key: </Text>
          <TextInput
            value={apiKeyInput}
            onChange={setApiKeyInput}
            mask="*"
            onSubmit={() => setStep("baseurl")}
          />
        </Box>
        <Text> </Text>
        <Text dimColor>
          {hasAnyKey
            ? "Enter to skip (use existing) · Or paste key to override · Esc back"
            : "Paste your API key · Enter to confirm · Esc back"}
        </Text>
      </Box>
    );
  }

  // --- Base URL ---
  if (step === "baseurl") {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Base URL</Text>
        <Text dimColor>Provider: {PROVIDER_DISPLAY_NAMES[selectedProvider]}</Text>
        <Text> </Text>
        <Box>
          <Text>URL: </Text>
          <TextInput
            value={baseUrlInput}
            onChange={setBaseUrlInput}
            onSubmit={() => setStep("model")}
          />
        </Box>
        <Text> </Text>
        <Text dimColor>Enter to skip (use default) · Or paste custom URL · Esc back</Text>
      </Box>
    );
  }

  // --- Model ---
  if (step === "model") {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Model</Text>
        <Text dimColor>Provider: {PROVIDER_DISPLAY_NAMES[selectedProvider]}</Text>
        <Text> </Text>
        <Box>
          <Text>Model: </Text>
          <TextInput
            value={modelInput}
            onChange={setModelInput}
            onSubmit={() => setStep("effort")}
          />
        </Box>
        <Text> </Text>
        <Text dimColor>Enter to confirm · Esc back</Text>
      </Box>
    );
  }

  // --- Reasoning Effort ---
  if (step === "effort") {
    const efforts = ["low", "medium", "high"];
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Reasoning Effort</Text>
        <Text dimColor>Controls thinking budget for reasoning models. Skip if not using reasoning models.</Text>
        <Text> </Text>
        {efforts.map((e, i) => {
          const sel = i === effortIndex;
          return (
            <Text key={e}>
              <Text color={sel ? "cyan" : undefined} bold={sel}>
                {" "}{sel ? ">" : " "} {e}
              </Text>
            </Text>
          );
        })}
        <Text>
          <Text color={effortIndex === -1 ? "cyan" : undefined} bold={effortIndex === -1}>
            {" "}{effortIndex === -1 ? ">" : " "} skip (use provider default)
          </Text>
        </Text>
        <Text> </Text>
        <Text dimColor>↑/↓ select · Enter confirm · Esc back</Text>
      </Box>
    );
  }

  // --- File ---
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>Findings File</Text>
      <Text dimColor>
        {PROVIDER_DISPLAY_NAMES[selectedProvider]} / {modelInput}
      </Text>
      <Text> </Text>
      <Box>
        <Text>Path: </Text>
        <TextInput
          value={fileInput}
          onChange={setFileInput}
          onSubmit={(value) => {
            const efforts = ["low", "medium", "high"];
            const effort = effortIndex >= 0 ? efforts[effortIndex] : undefined;

            onComplete({
              provider: selectedProvider,
              model: modelInput,
              apiKey: apiKeyInput || projectConfig.resolvedApiKey(),
              baseUrl: baseUrlInput || undefined,
              findingsPath: value || "findings.json",
              reasoningEffort: effort,
            });
          }}
        />
      </Box>
      <Text> </Text>
      <Text dimColor>Enter to start · Esc back</Text>
    </Box>
  );
}
