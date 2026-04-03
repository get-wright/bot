import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { withFullScreen } from "fullscreen-ink";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Finding } from "../models/finding.js";
import type { AppConfig } from "../config.js";
import type { MemoryStore } from "../memory/store.js";
import type { AgentEvent } from "../models/events.js";
import type { TriageVerdict } from "../models/verdict.js";
import { parseSemgrepOutput, fingerprintFinding } from "../parser/semgrep.js";
import { prefilterFinding } from "../parser/prefilter.js";
import { runAgentLoop } from "../agent/loop.js";
import { FindingsTable, type FindingEntry, type FindingStatus } from "./components/findings-table.js";
import { AgentPanel } from "./components/agent-panel.js";
import { Sidebar } from "./components/sidebar.js";
import { SetupScreen, type SetupResult } from "./components/setup-screen.js";
import { ProjectConfig } from "../config/project-config.js";

interface FindingState {
  entry: FindingEntry;
  finding: Finding;
  events: AgentEvent[];
  verdict?: TriageVerdict;
}

function MainScreen({
  findings,
  filteredFindings,
  totalCount,
  config,
  memory,
}: {
  findings: Finding[];
  filteredFindings: { finding: Finding; reason: string }[];
  totalCount: number;
  config: AppConfig;
  memory: MemoryStore;
}) {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [viewMode, setViewMode] = useState<"active" | "filtered">("active");
  const [findingStates, setFindingStates] = useState<FindingState[]>(() =>
    findings.map((f) => ({
      entry: {
        fingerprint: fingerprintFinding(f),
        ruleId: f.check_id,
        fileLine: `${f.path}:${f.start.line}`,
        severity: f.extra.severity,
        status: "pending" as FindingStatus,
      },
      finding: f,
      events: [],
    })),
  );
  const [isTriaging, setIsTriaging] = useState(false);

  const triaged = findingStates.filter((s) => s.verdict != null).length;
  const selected = findingStates[selectedIndex];

  const triageCurrent = useCallback(async () => {
    if (isTriaging || !selected || selected.verdict) return;
    setIsTriaging(true);
    const idx = selectedIndex;

    setFindingStates((prev) =>
      prev.map((s, i) =>
        i === idx
          ? { ...s, entry: { ...s.entry, status: "in_progress" as FindingStatus }, events: [] }
          : s,
      ),
    );

    const fp = selected.entry.fingerprint;
    const memoryHints = memory.getHints(selected.finding.check_id, fp);

    const verdict = await runAgentLoop({
      finding: selected.finding,
      projectRoot: process.cwd(),
      provider: config.provider,
      model: config.model,
      maxSteps: config.maxSteps,
      allowBash: config.allowBash,
      onEvent: (event) => {
        setFindingStates((prev) =>
          prev.map((s, i) => (i === idx ? { ...s, events: [...s.events, event] } : s)),
        );
      },
      memoryHints,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });

    memory.store({
      fingerprint: fp,
      check_id: selected.finding.check_id,
      path: selected.finding.path,
      verdict: verdict.verdict,
      reasoning: verdict.reasoning,
    });

    setFindingStates((prev) =>
      prev.map((s, i) =>
        i === idx
          ? { ...s, verdict, entry: { ...s.entry, status: verdict.verdict as FindingStatus } }
          : s,
      ),
    );

    setIsTriaging(false);
  }, [selectedIndex, selected, isTriaging, config, memory]);

  const listLength = viewMode === "active" ? findingStates.length : filteredFindings.length;

  useInput((input, key) => {
    if (input === "q") {
      exit();
      return;
    }
    if (key.tab) {
      setViewMode(viewMode === "active" ? "filtered" : "active");
      setSelectedIndex(0);
      return;
    }
    if (key.upArrow && selectedIndex > 0) setSelectedIndex(selectedIndex - 1);
    if (key.downArrow && selectedIndex < listLength - 1)
      setSelectedIndex(selectedIndex + 1);
    if (key.return && !isTriaging && viewMode === "active") {
      triageCurrent();
    }
  });

  const termWidth = process.stdout.columns ?? 120;
  const showSidebar = termWidth >= 100;
  const sidebarWidth = showSidebar ? Math.floor(termWidth * 0.18) : 0;
  const tableWidth = Math.floor(termWidth * 0.28);
  const panelWidth = termWidth - tableWidth - sidebarWidth;

  return (
    <Box flexDirection="row" width={termWidth} height={process.stdout.rows - 1}>
      <Box width={tableWidth} flexDirection="column" borderStyle="single" overflow="hidden">
        {viewMode === "active" ? (
          <FindingsTable
            findings={findingStates.map((s) => s.entry)}
            selectedIndex={selectedIndex}
            triaged={triaged}
          />
        ) : (
          <Box flexDirection="column" padding={1}>
            <Text bold>{`Filtered (${filteredFindings.length})`}</Text>
            {filteredFindings.map((item, i) => {
              const isSelected = i === selectedIndex;
              return (
                <Box key={i} flexDirection="column">
                  <Text dimColor={!isSelected}>
                    {isSelected ? "> " : "  "}
                    {item.finding.check_id.split(".").pop()} {item.finding.path}:{item.finding.start.line}
                  </Text>
                  <Text color="yellow" dimColor={!isSelected}>{`    ${item.reason}`}</Text>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>
      <Box width={panelWidth} flexDirection="column" borderStyle="single" overflow="hidden">
        {viewMode === "filtered" ? (
          <Text>Select a finding to investigate.</Text>
        ) : selected ? (
          <AgentPanel
            events={selected.events}
            isActive={isTriaging && selectedIndex === findingStates.indexOf(selected)}
          />
        ) : (
          <Text>Select a finding and press Enter to investigate.</Text>
        )}
      </Box>
      {showSidebar && (
        <Box width={sidebarWidth} flexDirection="column" borderStyle="single" overflow="hidden">
          <Sidebar
            total={totalCount}
            active={findings.length}
            filtered={filteredFindings.length}
            triaged={triaged}
            tp={findingStates.filter((s) => s.verdict?.verdict === "true_positive").length}
            fp={findingStates.filter((s) => s.verdict?.verdict === "false_positive").length}
            nr={findingStates.filter((s) => s.verdict?.verdict === "needs_review").length}
            provider={config.provider}
            model={config.model}
          />
        </Box>
      )}
    </Box>
  );
}

function App({
  initialConfig,
  memory,
  projectConfig,
}: {
  initialConfig: Partial<AppConfig>;
  memory: MemoryStore;
  projectConfig: ProjectConfig;
}) {
  // Use saved config to fill in missing CLI args
  const effectiveConfig = { ...initialConfig };
  if (projectConfig.hasConfig()) {
    effectiveConfig.provider ??= projectConfig.provider;
    effectiveConfig.model ??= projectConfig.model;
    effectiveConfig.apiKey ??= projectConfig.resolvedApiKey();
    effectiveConfig.baseUrl ??= projectConfig.baseUrl;
  }

  const [screen, setScreen] = useState<"setup" | "main">(
    effectiveConfig.provider && effectiveConfig.model && effectiveConfig.findingsPath
      ? "main"
      : "setup",
  );
  const [config, setConfig] = useState<AppConfig | null>(
    screen === "main"
      ? (effectiveConfig as AppConfig)
      : null,
  );
  const [findings, setFindings] = useState<Finding[]>([]);
  const [filteredFindings, setFilteredFindings] = useState<{ finding: Finding; reason: string }[]>([]);
  const [totalCount, setTotalCount] = useState(0);

  const handleSetupComplete = useCallback(
    (result: SetupResult) => {
      const fullConfig: AppConfig = {
        findingsPath: result.findingsPath,
        provider: result.provider,
        model: result.model,
        headless: false,
        allowBash: initialConfig.allowBash ?? false,
        maxSteps: initialConfig.maxSteps ?? 15,
        memoryDb: initialConfig.memoryDb ?? ".sast-triage/memory.db",
        apiKey: result.apiKey,
        baseUrl: result.baseUrl,
      };

      const filePath = resolve(result.findingsPath);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        // File not found — try relative to cwd
        try {
          raw = JSON.parse(readFileSync(resolve(process.cwd(), result.findingsPath), "utf-8"));
        } catch {
          return; // stay on setup — TODO: show error
        }
      }

      const allFindings = parseSemgrepOutput(raw);
      const memoryLookup = memory.createLookup();
      const active: Finding[] = [];
      const filtered: { finding: Finding; reason: string }[] = [];
      for (const f of allFindings) {
        const result = prefilterFinding(f, memoryLookup);
        if (result.passed) {
          active.push(f);
        } else {
          filtered.push({ finding: f, reason: result.reason ?? "Unknown" });
        }
      }

      setConfig(fullConfig);
      setFindings(active);
      setFilteredFindings(filtered);
      setTotalCount(allFindings.length);
      setScreen("main");
    },
    [initialConfig, memory],
  );

  if (screen === "setup") {
    return <SetupScreen cwd={process.cwd()} projectConfig={projectConfig} onComplete={handleSetupComplete} />;
  }

  if (!config || findings.length === 0) {
    return <Text color="yellow">No actionable findings found.</Text>;
  }

  return (
    <MainScreen
      findings={findings}
      filteredFindings={filteredFindings}
      totalCount={totalCount}
      config={config}
      memory={memory}
    />
  );
}

export async function runTui(
  initialConfig: Partial<AppConfig>,
  memory: MemoryStore,
  projectConfig: ProjectConfig,
): Promise<void> {
  const app = withFullScreen(
    <App initialConfig={initialConfig} memory={memory} projectConfig={projectConfig} />,
  );
  await app.start();
  await app.waitUntilExit();
}
