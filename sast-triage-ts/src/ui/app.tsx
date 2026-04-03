import React, { useState, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { withFullScreen } from "fullscreen-ink";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Finding } from "../models/finding.js";
import type { AppConfig } from "../config.js";
import type { MemoryStore } from "../memory/store.js";
import type { AgentEvent, PermissionDecision } from "../models/events.js";
import type { TriageVerdict } from "../models/verdict.js";
import { parseSemgrepOutput, fingerprintFinding } from "../parser/semgrep.js";
import { prefilterFinding } from "../parser/prefilter.js";
import { runAgentLoop } from "../agent/loop.js";
import { runFollowUp, type FollowUpExchange } from "../agent/follow-up.js";
import { FindingsTable, type FindingEntry, type FindingStatus } from "./components/findings-table.js";
import { AgentPanel } from "./components/agent-panel.js";
import { Sidebar, type QueueItem, type UsageStats } from "./components/sidebar.js";
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
  filteredFindings: initialFilteredFindings,
  totalCount,
  config,
  memory,
  onSwitchProvider,
  initialView = "active",
}: {
  findings: Finding[];
  filteredFindings: { finding: Finding; reason: string }[];
  totalCount: number;
  config: AppConfig;
  memory: MemoryStore;
  onSwitchProvider?: () => void;
  initialView?: "active" | "filtered" | "dismissed";
}) {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [viewMode, setViewMode] = useState<"active" | "filtered" | "dismissed">(initialView);
  const [filteredFindings, setFilteredFindings] = useState(initialFilteredFindings);
  const [dismissedFindings, setDismissedFindings] = useState<{ finding: Finding; reason: string }[]>([]);
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
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [queueState, setQueueState] = useState<{
    items: number[];
    currentIndex: number;
    isRunning: boolean;
  } | null>(null);
  const [sessionUsage, setSessionUsage] = useState<UsageStats>({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  const [currentUsage, setCurrentUsage] = useState<UsageStats | undefined>();
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [followUpExchanges, setFollowUpExchanges] = useState<Map<number, FollowUpExchange[]>>(new Map());
  const stopQueueRef = useRef(false);
  const pendingPermissionRef = useRef<((decision: PermissionDecision) => void) | null>(null);

  const triaged = findingStates.filter((s) => s.verdict != null).length;
  const selected = findingStates[selectedIndex];

  const triageIndex = useCallback(
    async (idx: number) => {
      const state = findingStates[idx];
      if (!state || state.verdict) return;

      setFindingStates((prev) =>
        prev.map((s, i) =>
          i === idx
            ? { ...s, entry: { ...s.entry, status: "in_progress" as FindingStatus }, events: [] }
            : s,
        ),
      );
      setCurrentUsage(undefined);
      setSelectedIndex(idx);

      const fp = state.entry.fingerprint;
      const memoryHints = memory.getHints(state.finding.check_id, fp);

      const verdict = await runAgentLoop({
        finding: state.finding,
        projectRoot: process.cwd(),
        provider: config.provider,
        model: config.model,
        maxSteps: config.maxSteps,
        allowBash: config.allowBash,
        onEvent: (event) => {
          if (event.type === "usage") {
            const usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens };
            setCurrentUsage(usage);
            setSessionUsage((prev) => ({
              inputTokens: prev.inputTokens + event.inputTokens,
              outputTokens: prev.outputTokens + event.outputTokens,
              totalTokens: prev.totalTokens + event.totalTokens,
            }));
          }
          if (event.type === "permission_request") {
            pendingPermissionRef.current = event.resolve;
          }
          setFindingStates((prev) =>
            prev.map((s, i) => (i === idx ? { ...s, events: [...s.events, event] } : s)),
          );
        },
        memoryHints,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        reasoningEffort: config.reasoningEffort,
        allowedPaths: config.allowedPaths,
      });

      memory.store({
        fingerprint: fp,
        check_id: state.finding.check_id,
        path: state.finding.path,
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
      pendingPermissionRef.current = null;

      return verdict;
    },
    [findingStates, config, memory],
  );

  const startBatchQueue = useCallback(
    async (indices: number[]) => {
      if (isTriaging || indices.length === 0) return;
      setIsTriaging(true);
      stopQueueRef.current = false;

      setQueueState({ items: indices, currentIndex: 0, isRunning: true });

      for (let qi = 0; qi < indices.length; qi++) {
        if (stopQueueRef.current) break;
        setQueueState({ items: indices, currentIndex: qi, isRunning: true });
        await triageIndex(indices[qi]!);
      }

      setQueueState(null);
      setIsTriaging(false);
      setSelectedIndices(new Set());
    },
    [isTriaging, triageIndex],
  );

  const reauditCurrent = useCallback(async () => {
    if (isTriaging) return;
    const state = findingStates[selectedIndex];
    if (!state || !state.verdict) return;

    setFindingStates((prev) =>
      prev.map((s, i) =>
        i === selectedIndex
          ? { ...s, verdict: undefined, events: [], entry: { ...s.entry, status: "pending" as FindingStatus } }
          : s,
      ),
    );
    setFollowUpExchanges((prev) => {
      const next = new Map(prev);
      next.delete(selectedIndex);
      return next;
    });

    setIsTriaging(true);
    await triageIndex(selectedIndex);
    setIsTriaging(false);
  }, [selectedIndex, findingStates, isTriaging, triageIndex]);

  const handleFollowUp = useCallback(
    async (question: string) => {
      const state = findingStates[selectedIndex];
      if (!state?.verdict) return;

      setShowFollowUp(false);
      setIsTriaging(true);

      const priorExchanges = followUpExchanges.get(selectedIndex) ?? [];

      const answer = await runFollowUp({
        finding: state.finding,
        previousVerdict: state.verdict,
        question,
        priorExchanges,
        provider: config.provider,
        model: config.model,
        onEvent: (event) => {
          setFindingStates((prev) =>
            prev.map((s, i) =>
              i === selectedIndex ? { ...s, events: [...s.events, event] } : s,
            ),
          );
        },
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        reasoningEffort: config.reasoningEffort,
      });

      setFollowUpExchanges((prev) => {
        const next = new Map(prev);
        const existing = next.get(selectedIndex) ?? [];
        next.set(selectedIndex, [...existing, { question, answer }]);
        return next;
      });
      setIsTriaging(false);
    },
    [selectedIndex, findingStates, followUpExchanges, config],
  );

  const handlePermissionResolve = useCallback((decision: PermissionDecision) => {
    if (pendingPermissionRef.current) {
      pendingPermissionRef.current(decision);
      pendingPermissionRef.current = null;
    }
  }, []);

  // Promote a filtered finding to active and start triaging it
  const promoteFiltered = useCallback(async () => {
    if (isTriaging || viewMode !== "filtered") return;
    const item = filteredFindings[selectedIndex];
    if (!item) return;

    const f = item.finding;
    const newState: FindingState = {
      entry: {
        fingerprint: fingerprintFinding(f),
        ruleId: f.check_id,
        fileLine: `${f.path}:${f.start.line}`,
        severity: f.extra.severity,
        status: "pending" as FindingStatus,
      },
      finding: f,
      events: [],
    };

    // Remove from filtered, add to active
    setFilteredFindings((prev) => prev.filter((_, i) => i !== selectedIndex));
    setFindingStates((prev) => [...prev, newState]);
    if (selectedIndex >= filteredFindings.length - 1) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    }

    // Switch to active view and triage the new finding
    const newIdx = findingStates.length; // it'll be appended at the end
    setViewMode("active");
    setSelectedIndex(newIdx);
    setIsTriaging(true);
    await triageIndex(newIdx);
    setIsTriaging(false);
  }, [isTriaging, viewMode, filteredFindings, selectedIndex, findingStates.length, triageIndex]);

  // Dismiss a filtered finding (move to dismissed list)
  const dismissFiltered = useCallback(() => {
    if (viewMode !== "filtered") return;
    const item = filteredFindings[selectedIndex];
    if (!item) return;
    setDismissedFindings((prev) => [...prev, item]);
    setFilteredFindings((prev) => prev.filter((_, i) => i !== selectedIndex));
    if (selectedIndex >= filteredFindings.length - 1) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    }
  }, [viewMode, selectedIndex, filteredFindings]);

  // Restore a dismissed finding back to filtered
  const restoreDismissed = useCallback(() => {
    if (viewMode !== "dismissed") return;
    const item = dismissedFindings[selectedIndex];
    if (!item) return;
    setFilteredFindings((prev) => [...prev, item]);
    setDismissedFindings((prev) => prev.filter((_, i) => i !== selectedIndex));
    if (selectedIndex >= dismissedFindings.length - 1) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    }
  }, [viewMode, selectedIndex, dismissedFindings]);

  const listLength = viewMode === "active"
    ? findingStates.length
    : viewMode === "filtered"
      ? filteredFindings.length
      : dismissedFindings.length;

  useInput((input, key) => {
    if (showFollowUp) return;

    if (input === "q") {
      exit();
      return;
    }

    // Permission response
    if (pendingPermissionRef.current) {
      if (input === "a") { handlePermissionResolve("once"); return; }
      if (input === "d") { handlePermissionResolve("always"); return; }
      if (input === "x") { handlePermissionResolve("deny"); return; }
      return;
    }

    if (key.tab) {
      const views: Array<"active" | "filtered" | "dismissed"> = ["active", "filtered", "dismissed"];
      const next = views[(views.indexOf(viewMode) + 1) % views.length]!;
      setViewMode(next);
      setSelectedIndex(0);
      return;
    }
    if (key.upArrow && selectedIndex > 0) setSelectedIndex(selectedIndex - 1);
    if (key.downArrow && selectedIndex < listLength - 1) setSelectedIndex(selectedIndex + 1);

    // Space: toggle selection
    if (input === " " && viewMode === "active" && !isTriaging) {
      setSelectedIndices((prev) => {
        const next = new Set(prev);
        if (next.has(selectedIndex)) next.delete(selectedIndex);
        else next.add(selectedIndex);
        return next;
      });
      return;
    }

    // a: select all
    if (input === "a" && viewMode === "active" && !isTriaging) {
      setSelectedIndices(new Set(findingStates.map((_, i) => i).filter((i) => !findingStates[i]!.verdict)));
      return;
    }

    // Enter: start triage (active), promote filtered, or restore dismissed
    if (key.return && !isTriaging) {
      if (viewMode === "active") {
        const indices = selectedIndices.size > 0
          ? [...selectedIndices].filter((i) => !findingStates[i]!.verdict).sort((a, b) => a - b)
          : [selectedIndex];
        startBatchQueue(indices);
      } else if (viewMode === "filtered") {
        promoteFiltered();
      } else if (viewMode === "dismissed") {
        restoreDismissed();
      }
      return;
    }

    // d: dismiss filtered finding
    if (input === "d" && viewMode === "filtered" && !isTriaging) {
      dismissFiltered();
      return;
    }

    // Esc: stop batch queue
    if (key.escape && queueState?.isRunning) {
      stopQueueRef.current = true;
      return;
    }

    // r: re-audit
    if (input === "r" && viewMode === "active" && !isTriaging) {
      reauditCurrent();
      return;
    }

    // f: follow-up
    if (input === "f" && viewMode === "active" && !isTriaging && selected?.verdict) {
      setShowFollowUp(true);
      return;
    }

    // Ctrl+P: switch provider
    if (input === "p" && key.ctrl && !isTriaging) {
      onSwitchProvider?.();
      return;
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
            selectedIndices={selectedIndices}
          />
        ) : (
          <Box flexDirection="column" padding={1}>
            <Text bold>
              {viewMode === "filtered"
                ? `Filtered (${filteredFindings.length})`
                : `Dismissed (${dismissedFindings.length})`}
            </Text>
            {(viewMode === "filtered" ? filteredFindings : dismissedFindings).map((item, i) => {
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
        {viewMode === "filtered" || viewMode === "dismissed" ? (
          (() => {
            const items = viewMode === "filtered" ? filteredFindings : dismissedFindings;
            const item = items[selectedIndex];
            if (!item) return <Text>No {viewMode} findings.</Text>;
            return (
              <Box flexDirection="column" padding={1}>
                <Text bold>Rule: {item.finding.check_id}</Text>
                <Text>File: {item.finding.path}:{item.finding.start.line}</Text>
                <Text>Severity: {item.finding.extra.severity}</Text>
                <Text> </Text>
                <Text color="yellow">{viewMode === "filtered" ? "Filtered" : "Dismissed"}: {item.reason}</Text>
                <Text> </Text>
                <Text wrap="wrap">{item.finding.extra.message}</Text>
                <Text> </Text>
                <Text dimColor>
                  {viewMode === "filtered"
                    ? "Enter: re-audit · d: dismiss"
                    : "Enter: restore to filtered"}
                </Text>
              </Box>
            );
          })()
        ) : selected ? (
          <AgentPanel
            events={selected.events}
            isActive={isTriaging && selectedIndex === findingStates.indexOf(selected)}
            width={panelWidth - 4}
            showFollowUpInput={showFollowUp}
            onFollowUp={handleFollowUp}
            onPermissionResolve={handlePermissionResolve}
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
            queue={queueState ? queueState.items.map((idx, qi) => ({
              label: findingStates[idx]!.finding.check_id.split(".").pop() ?? "",
              status: qi < queueState.currentIndex ? "done" as const
                : qi === queueState.currentIndex ? "active" as const
                : "pending" as const,
              verdict: findingStates[idx]!.verdict?.verdict,
            })) : undefined}
            sessionUsage={sessionUsage}
            currentUsage={currentUsage}
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
    effectiveConfig.reasoningEffort ??= projectConfig.reasoningEffort;
    effectiveConfig.allowedPaths ??= projectConfig.allowedPaths.length > 0 ? projectConfig.allowedPaths : undefined;
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
  const [switchingProvider, setSwitchingProvider] = useState(false);

  const handleSwitchProvider = useCallback(() => {
    setSwitchingProvider(true);
    setScreen("setup");
  }, []);

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
        reasoningEffort: result.reasoningEffort as AppConfig["reasoningEffort"],
        allowedPaths: projectConfig.allowedPaths,
      };

      if (switchingProvider) {
        setConfig(fullConfig);
        setScreen("main");
        setSwitchingProvider(false);
        return;
      }

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
    [initialConfig, memory, switchingProvider, projectConfig],
  );

  if (screen === "setup") {
    return <SetupScreen cwd={process.cwd()} projectConfig={projectConfig} onComplete={handleSetupComplete} startStep={switchingProvider ? "provider" : undefined} />;
  }

  if (!config || (findings.length === 0 && filteredFindings.length === 0)) {
    return <Text color="yellow">No findings found.</Text>;
  }

  return (
    <MainScreen
      findings={findings}
      filteredFindings={filteredFindings}
      totalCount={totalCount}
      config={config}
      memory={memory}
      onSwitchProvider={handleSwitchProvider}
      initialView={findings.length === 0 ? "filtered" : "active"}
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
