import React, { useState, useCallback, useRef, useEffect } from "react";
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
import { FindingDetail } from "./components/finding-detail.js";

function useTerminalSize(): { columns: number; rows: number } {
  const [size, setSize] = useState({
    columns: process.stdout.columns ?? 120,
    rows: process.stdout.rows ?? 40,
  });

  useEffect(() => {
    const onResize = () => {
      setSize({
        columns: process.stdout.columns ?? 120,
        rows: process.stdout.rows ?? 40,
      });
    };
    process.stdout.on("resize", onResize);
    return () => { process.stdout.off("resize", onResize); };
  }, []);

  return size;
}

interface FindingState {
  entry: FindingEntry;
  finding: Finding;
  events: AgentEvent[];
  verdict?: TriageVerdict;
  cachedAt?: string;
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
    findings.map((f) => {
      const fp = fingerprintFinding(f);
      const cached = memory.lookupCached(fp);
      // Synthesize events for cached findings so the AgentPanel renders the
      // full audit context (tool calls, verdict, token usage) from persisted
      // data — not just the empty-state message.
      const events: AgentEvent[] = [];
      if (cached) {
        for (const tc of cached.tool_calls) {
          events.push({ type: "tool_start", tool: tc.tool, args: tc.args });
        }
        events.push({ type: "verdict", verdict: cached.verdict });
        if (cached.input_tokens > 0 || cached.output_tokens > 0) {
          events.push({
            type: "usage",
            inputTokens: cached.input_tokens,
            outputTokens: cached.output_tokens,
            totalTokens: cached.input_tokens + cached.output_tokens,
          });
        }
      }
      return {
        entry: {
          fingerprint: fp,
          ruleId: f.check_id,
          fileLine: `${f.path}:${f.start.line}`,
          severity: f.extra.severity,
          status: (cached?.verdict.verdict ?? "pending") as FindingStatus,
        },
        finding: f,
        events,
        verdict: cached?.verdict,
        cachedAt: cached?.updated_at,
      };
    }),
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
            ? { ...s, cachedAt: undefined, entry: { ...s.entry, status: "in_progress" as FindingStatus }, events: [] }
            : s,
        ),
      );
      setCurrentUsage(undefined);
      setSelectedIndex(idx);

      const fp = state.entry.fingerprint;
      const memoryHints = memory.getHints(state.finding.check_id, fp);

      const result = await runAgentLoop({
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

      const verdict = result.verdict;
      memory.store({
        fingerprint: fp,
        check_id: state.finding.check_id,
        path: state.finding.path,
        verdict: verdict.verdict,
        reasoning: verdict.reasoning,
        key_evidence: verdict.key_evidence,
        suggested_fix: verdict.suggested_fix,
        tool_calls: result.toolCalls,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
      });

      const cachedAt = new Date().toISOString();
      setFindingStates((prev) =>
        prev.map((s, i) =>
          i === idx
            ? { ...s, verdict, cachedAt, entry: { ...s.entry, status: verdict.verdict as FindingStatus } }
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
          ? { ...s, verdict: undefined, cachedAt: undefined, events: [], entry: { ...s.entry, status: "pending" as FindingStatus } }
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

  // Promote selected filtered findings to active and triage them sequentially
  const promoteFilteredBatch = useCallback(async (indices: number[]) => {
    if (isTriaging || viewMode !== "filtered" || indices.length === 0) return;
    const sorted = [...indices].sort((a, b) => a - b);
    const itemsToPromote = sorted.map((i) => filteredFindings[i]).filter((item): item is { finding: Finding; reason: string } => item != null);
    if (itemsToPromote.length === 0) return;

    const newStates: FindingState[] = itemsToPromote.map((item) => {
      const f = item.finding;
      return {
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
    });

    const startIdx = findingStates.length;
    const newIndices = newStates.map((_, i) => startIdx + i);

    // Remove promoted from filtered, append to active
    setFilteredFindings((prev) => prev.filter((_, i) => !sorted.includes(i)));
    setFindingStates((prev) => [...prev, ...newStates]);
    setSelectedIndices(new Set());
    setViewMode("active");
    setSelectedIndex(startIdx);

    // Triage all newly-promoted findings
    setIsTriaging(true);
    stopQueueRef.current = false;
    setQueueState({ items: newIndices, currentIndex: 0, isRunning: true });
    for (let qi = 0; qi < newIndices.length; qi++) {
      if (stopQueueRef.current) break;
      setQueueState({ items: newIndices, currentIndex: qi, isRunning: true });
      await triageIndex(newIndices[qi]!);
    }
    setQueueState(null);
    setIsTriaging(false);
  }, [isTriaging, viewMode, filteredFindings, findingStates.length, triageIndex]);

  // Promote a single filtered finding (fallback when no selection)
  const promoteFiltered = useCallback(async () => {
    await promoteFilteredBatch([selectedIndex]);
  }, [selectedIndex, promoteFilteredBatch]);

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

  // Restore selected dismissed findings back to filtered
  const restoreDismissedBatch = useCallback((indices: number[]) => {
    if (viewMode !== "dismissed" || indices.length === 0) return;
    const sorted = [...indices].sort((a, b) => a - b);
    const items = sorted.map((i) => dismissedFindings[i]).filter((item): item is { finding: Finding; reason: string } => item != null);
    if (items.length === 0) return;
    setFilteredFindings((prev) => [...prev, ...items]);
    setDismissedFindings((prev) => prev.filter((_, i) => !sorted.includes(i)));
    setSelectedIndices(new Set());
    if (selectedIndex >= dismissedFindings.length - items.length) {
      setSelectedIndex(Math.max(0, dismissedFindings.length - items.length - 1));
    }
  }, [viewMode, selectedIndex, dismissedFindings]);

  const restoreDismissed = useCallback(() => {
    restoreDismissedBatch([selectedIndex]);
  }, [selectedIndex, restoreDismissedBatch]);

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
      setSelectedIndices(new Set());
      return;
    }
    if (key.upArrow && selectedIndex > 0) setSelectedIndex(selectedIndex - 1);
    if (key.downArrow && selectedIndex < listLength - 1) setSelectedIndex(selectedIndex + 1);

    // Space: toggle selection (works in all views)
    if (input === " " && !isTriaging) {
      setSelectedIndices((prev) => {
        const next = new Set(prev);
        if (next.has(selectedIndex)) next.delete(selectedIndex);
        else next.add(selectedIndex);
        return next;
      });
      return;
    }

    // a: select all (view-aware)
    if (input === "a" && !isTriaging) {
      if (viewMode === "active") {
        setSelectedIndices(new Set(findingStates.map((_, i) => i).filter((i) => !findingStates[i]!.verdict)));
      } else if (viewMode === "filtered") {
        setSelectedIndices(new Set(filteredFindings.map((_, i) => i)));
      } else if (viewMode === "dismissed") {
        setSelectedIndices(new Set(dismissedFindings.map((_, i) => i)));
      }
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
        const indices = selectedIndices.size > 0
          ? [...selectedIndices].sort((a, b) => a - b)
          : [selectedIndex];
        promoteFilteredBatch(indices);
      } else if (viewMode === "dismissed") {
        const indices = selectedIndices.size > 0
          ? [...selectedIndices].sort((a, b) => a - b)
          : [selectedIndex];
        restoreDismissedBatch(indices);
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

  const { columns: termWidth, rows: termHeight } = useTerminalSize();
  const showSidebar = termWidth >= 100;
  const sidebarWidth = showSidebar ? Math.floor(termWidth * 0.18) : 0;
  const tableWidth = Math.floor(termWidth * 0.28);
  const panelWidth = termWidth - tableWidth - sidebarWidth;

  return (
    <Box flexDirection="row" width={termWidth} height={termHeight - 1}>
      <Box width={tableWidth} flexDirection="column" borderStyle="single" overflow="hidden">
        {viewMode === "active" ? (
          <FindingsTable
            findings={findingStates.map((s) => s.entry)}
            selectedIndex={selectedIndex}
            triaged={triaged}
            selectedIndices={selectedIndices}
            width={tableWidth - 2}
          />
        ) : (
          <Box flexDirection="column" padding={1}>
            <Box marginBottom={1}>
              <Text bold>
                {viewMode === "filtered"
                  ? `Filtered (${filteredFindings.length})`
                  : `Dismissed (${dismissedFindings.length})`}
              </Text>
            </Box>
            {(viewMode === "filtered" ? filteredFindings : dismissedFindings).map((item, i) => {
              const isSelected = i === selectedIndex;
              const isMultiSelected = selectedIndices.has(i);
              const fp = `${viewMode}-${item.finding.check_id}-${item.finding.path}-${item.finding.start.line}`;
              const fileLine = `${item.finding.path}:${item.finding.start.line}`;
              const rule = item.finding.check_id.split(".").pop() ?? "";
              const cw = tableWidth - 6; // padding + marker
              const line = `${fileLine} ${rule}`;
              const clipped = line.length > cw ? line.slice(0, cw - 1) + "…" : line;
              const marker = isMultiSelected ? "●" : " ";
              return (
                <Box key={fp}>
                  <Text dimColor={!isSelected}>
                    {isSelected ? ">" : " "}{marker} {clipped}
                  </Text>
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
              <FindingDetail
                finding={item.finding}
                reason={item.reason}
                label={viewMode === "filtered" ? "Filtered" : "Dismissed"}
                hint={viewMode === "filtered"
                  ? "Enter: re-audit · d: dismiss"
                  : "Enter: restore to filtered"}
                width={panelWidth - 2}
              />
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
            cachedAt={selected.cachedAt}
          />
        ) : (
          <Text>Select a finding and press Enter to investigate.</Text>
        )}
      </Box>
      {showSidebar && (
        <Box width={sidebarWidth} flexDirection="column" borderStyle="single" overflow="hidden">
          <Sidebar
            total={totalCount}
            active={findingStates.filter((s) => !s.verdict).length}
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
      const active: Finding[] = [];
      const filtered: { finding: Finding; reason: string }[] = [];
      for (const f of allFindings) {
        const result = prefilterFinding(f);
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
    [initialConfig, switchingProvider, projectConfig],
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
