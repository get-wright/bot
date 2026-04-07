import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { withFullScreen } from "fullscreen-ink";
import { resolve } from "node:path";
import type { Finding } from "../models/finding.js";
import type { AppConfig } from "../config.js";
import type { PermissionDecision } from "../models/events.js";
import type { FollowUpExchange } from "../agent/follow-up.js";
import type { TriageOrchestrator, FindingState, FilteredFinding } from "../orchestrator.js";
import { fingerprintFinding } from "../parser/semgrep.js";
import { FindingsTable, type FindingStatus } from "./components/findings-table.js";
import { AgentPanel } from "./components/agent-panel.js";
import { Sidebar, type UsageStats } from "./components/sidebar.js";
import { SetupScreen, type SetupResult } from "./components/setup-screen.js";
import { ProjectConfig } from "../config/project-config.js";
import { FindingDetail } from "./components/finding-detail.js";
import { initTracing, isTracingEnabled } from "../tracing.js";
import { CommandPanel, type CommandDef } from "./components/command-panel.js";

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

function MainScreen({
  findings,
  findingStatesInit,
  filteredFindings: initialFilteredFindings,
  totalCount,
  config,
  orchestrator,
  onSwitchProvider,
  initialView = "active",
  projectConfig,
}: {
  findings: Finding[];
  findingStatesInit: FindingState[];
  filteredFindings: FilteredFinding[];
  totalCount: number;
  config: AppConfig;
  orchestrator: TriageOrchestrator;
  onSwitchProvider?: () => void;
  initialView?: "active" | "filtered" | "dismissed";
  projectConfig?: ProjectConfig;
}) {
  const { exit } = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [viewMode, setViewMode] = useState<"active" | "filtered" | "dismissed">(initialView);
  const [filteredFindings, setFilteredFindings] = useState(initialFilteredFindings);
  const [dismissedFindings, setDismissedFindings] = useState<FilteredFinding[]>([]);
  const [findingStates, setFindingStates] = useState<FindingState[]>(findingStatesInit);
  const [triagingIndices, setTriagingIndices] = useState<Set<number>>(new Set());
  const [showCommandPanel, setShowCommandPanel] = useState(false);
  const [concurrency, setConcurrency] = useState(config.concurrency ?? 1);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [queueState, setQueueState] = useState<{
    items: number[];
    completed: number;
    activeIndices: Set<number>;
  } | null>(null);
  const [sessionUsage, setSessionUsage] = useState<UsageStats>({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  const [currentUsage, setCurrentUsage] = useState<UsageStats | undefined>();
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [followUpExchanges, setFollowUpExchanges] = useState<Map<number, FollowUpExchange[]>>(new Map());
  const [tracingActive, setTracingActive] = useState(isTracingEnabled());
  const [notification, setNotification] = useState<string | undefined>();
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingPermissionRef = useRef<((decision: PermissionDecision) => void) | null>(null);

  const isTriaging = triagingIndices.size > 0;
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

      const result = await orchestrator.triage(
        state.finding,
        state.entry.fingerprint,
        config,
        (event) => {
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
      );

      const verdict = result.verdict;

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
    [findingStates, config, orchestrator],
  );

  const startBatchQueue = useCallback(
    async (indices: number[]) => {
      if (isTriaging || indices.length === 0) return;

      const items = indices
        .map((idx) => {
          const state = findingStates[idx];
          if (!state) return null;
          return { idx, finding: state.finding, fingerprint: state.entry.fingerprint };
        })
        .filter((item): item is NonNullable<typeof item> => item != null);

      if (items.length === 0) return;

      // Eagerly mark all batch items as triaging
      setTriagingIndices(new Set(items.map((item) => item.idx)));

      // Clear verdict/events and mark as in_progress (supports re-audit of completed findings)
      setFindingStates((prev) =>
        prev.map((s, i) =>
          items.some((item) => item.idx === i)
            ? { ...s, verdict: undefined, cachedAt: undefined, entry: { ...s.entry, status: "in_progress" as FindingStatus }, events: [] }
            : s,
        ),
      );
      setFollowUpExchanges((prev) => {
        const next = new Map(prev);
        for (const item of items) next.delete(item.idx);
        return next;
      });

      setQueueState({
        items: items.map((item) => item.idx),
        completed: 0,
        activeIndices: new Set(),
      });

      const ac = new AbortController();
      abortControllerRef.current = ac;

      try {
        await orchestrator.triageBatch(
          items.map(({ finding, fingerprint }) => ({ finding, fingerprint })),
          config,
          concurrency,
          (fingerprint, result) => {
            const item = items.find((i) => i.fingerprint === fingerprint);
            if (!item) return;
            const cachedAt = new Date().toISOString();
            setFindingStates((prev) =>
              prev.map((s, i) =>
                i === item.idx
                  ? { ...s, verdict: result.verdict, cachedAt, entry: { ...s.entry, status: result.verdict.verdict as FindingStatus } }
                  : s,
              ),
            );
            setTriagingIndices((prev) => {
              const next = new Set(prev);
              next.delete(item.idx);
              return next;
            });
            setQueueState((prev) =>
              prev ? {
                ...prev,
                completed: prev.completed + 1,
                activeIndices: new Set([...prev.activeIndices].filter((i) => i !== item.idx)),
              } : null,
            );
            setSessionUsage((prev) => ({
              inputTokens: prev.inputTokens + result.inputTokens,
              outputTokens: prev.outputTokens + result.outputTokens,
              totalTokens: prev.totalTokens + result.inputTokens + result.outputTokens,
            }));
          },
          ac.signal,
          (fingerprint, event) => {
            const item = items.find((i) => i.fingerprint === fingerprint);
            if (!item) return;

            if (event.type === "tool_start") {
              setQueueState((prev) =>
                prev ? { ...prev, activeIndices: new Set(prev.activeIndices).add(item.idx) } : null,
              );
            }

            if (event.type === "usage") {
              setCurrentUsage({
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                totalTokens: event.totalTokens,
              });
            }
            if (event.type === "permission_request") {
              pendingPermissionRef.current = event.resolve;
            }
            setFindingStates((prev) =>
              prev.map((s, i) => (i === item.idx ? { ...s, events: [...s.events, event] } : s)),
            );
          },
        );
      } finally {
        abortControllerRef.current = null;
        setQueueState(null);
        setTriagingIndices(new Set());
        setSelectedIndices(new Set());
      }
    },
    [isTriaging, findingStates, config, orchestrator, concurrency],
  );

  const reauditCurrent = useCallback(async () => {
    if (triagingIndices.has(selectedIndex)) return;
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

    setTriagingIndices((prev) => new Set(prev).add(selectedIndex));
    await triageIndex(selectedIndex);
    setTriagingIndices((prev) => {
      const next = new Set(prev);
      next.delete(selectedIndex);
      return next;
    });
  }, [selectedIndex, findingStates, triagingIndices, triageIndex]);

  const handleFollowUp = useCallback(
    async (question: string) => {
      const state = findingStates[selectedIndex];
      if (!state?.verdict) return;

      setShowFollowUp(false);
      setTriagingIndices((prev) => new Set(prev).add(selectedIndex));

      const priorExchanges = followUpExchanges.get(selectedIndex) ?? [];

      const answer = await orchestrator.followUp(
        state.finding,
        state.verdict,
        question,
        priorExchanges,
        config,
        (event) => {
          setFindingStates((prev) =>
            prev.map((s, i) =>
              i === selectedIndex ? { ...s, events: [...s.events, event] } : s,
            ),
          );
        },
      );

      setFollowUpExchanges((prev) => {
        const next = new Map(prev);
        const existing = next.get(selectedIndex) ?? [];
        next.set(selectedIndex, [...existing, { question, answer }]);
        return next;
      });
      setTriagingIndices((prev) => {
        const next = new Set(prev);
        next.delete(selectedIndex);
        return next;
      });
    },
    [selectedIndex, findingStates, followUpExchanges, config],
  );

  const handlePermissionResolve = useCallback((decision: PermissionDecision) => {
    if (pendingPermissionRef.current) {
      pendingPermissionRef.current(decision);
      pendingPermissionRef.current = null;
    }
  }, []);

  // Promote selected filtered findings to active and triage them concurrently
  const promoteFilteredBatch = useCallback(async (indices: number[]) => {
    if (isTriaging || viewMode !== "filtered" || indices.length === 0) return;
    const sorted = [...indices].sort((a, b) => a - b);
    const itemsToPromote = sorted.map((i) => filteredFindings[i]).filter((item): item is FilteredFinding => item != null);
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

    setFilteredFindings((prev) => prev.filter((_, i) => !sorted.includes(i)));
    setFindingStates((prev) => [...prev, ...newStates]);
    setSelectedIndices(new Set());
    setViewMode("active");
    setSelectedIndex(startIdx);

    startBatchQueue(newIndices);
  }, [isTriaging, viewMode, filteredFindings, findingStates.length, startBatchQueue]);

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
    const items = sorted.map((i) => dismissedFindings[i]).filter((item): item is FilteredFinding => item != null);
    if (items.length === 0) return;
    setFilteredFindings((prev) => [...prev, ...items]);
    setDismissedFindings((prev) => prev.filter((_, i) => !sorted.includes(i)));
    setSelectedIndices(new Set());
    if (selectedIndex >= dismissedFindings.length - items.length) {
      setSelectedIndex(Math.max(0, dismissedFindings.length - items.length - 1));
    }
  }, [viewMode, selectedIndex, dismissedFindings]);

  const listLength = viewMode === "active"
    ? findingStates.length
    : viewMode === "filtered"
      ? filteredFindings.length
      : dismissedFindings.length;

  useInput((input, key) => {
    if (showFollowUp) return;
    if (showCommandPanel) return; // Command panel captures all input

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

    if (input === "m") {
      setShowCommandPanel(true);
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
    // Plain arrows navigate list; shift+arrow is reserved for AgentPanel scroll
    if (key.upArrow && !key.shift && selectedIndex > 0) setSelectedIndex(selectedIndex - 1);
    if (key.downArrow && !key.shift && selectedIndex < listLength - 1) setSelectedIndex(selectedIndex + 1);

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
          ? [...selectedIndices].sort((a, b) => a - b)
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
    if (key.escape && abortControllerRef.current) {
      abortControllerRef.current.abort();
      return;
    }

    // r: re-audit
    if (input === "r" && viewMode === "active" && !isTriaging) {
      reauditCurrent();
      return;
    }

    // f: follow-up (allowed even during batch — only blocked if THIS finding is triaging)
    if (input === "f" && viewMode === "active" && !triagingIndices.has(selectedIndex) && selected?.verdict) {
      setShowFollowUp(true);
      return;
    }

    // Ctrl+P: switch provider
    if (input === "p" && key.ctrl && !isTriaging) {
      onSwitchProvider?.();
      return;
    }

    // Ctrl+L: toggle LangSmith tracing
    if (input === "l" && key.ctrl && !isTriaging) {
      if (tracingActive) {
        setNotification("LangSmith tracing already active");
        setTimeout(() => setNotification(undefined), 3000);
        return;
      }
      if (!process.env.LANGSMITH_API_KEY) {
        setNotification("Set LANGSMITH_API_KEY env var first");
        setTimeout(() => setNotification(undefined), 4000);
        return;
      }
      setNotification("Enabling LangSmith tracing...");
      initTracing().then((ok) => {
        if (ok) {
          setTracingActive(true);
          setNotification("LangSmith tracing enabled");
        } else {
          setNotification("Failed to enable tracing — check logs");
        }
        setTimeout(() => setNotification(undefined), 3000);
      });
      return;
    }
  });

  const { columns: termWidth, rows: termHeight } = useTerminalSize();
  const showSidebar = termWidth >= 100;
  const sidebarWidth = showSidebar ? Math.floor(termWidth * 0.18) : 0;
  const tableWidth = Math.floor(termWidth * 0.28);
  const panelWidth = termWidth - tableWidth - sidebarWidth;

  const mainHeight = notification ? termHeight - 2 : termHeight - 1;

  const commandDefs: CommandDef[] = [
    { label: "Triage selected", shortcut: "Enter", action: () => {
      const indices = selectedIndices.size > 0
        ? [...selectedIndices].filter((i) => !findingStates[i]!.verdict).sort((a, b) => a - b)
        : [selectedIndex];
      startBatchQueue(indices);
    }},
    { label: "Toggle select", shortcut: "Space", action: () => {
      setSelectedIndices((prev) => {
        const next = new Set(prev);
        if (next.has(selectedIndex)) next.delete(selectedIndex);
        else next.add(selectedIndex);
        return next;
      });
    }},
    { label: "Select all", shortcut: "a", action: () => {
      setSelectedIndices(new Set(findingStates.map((_, i) => i).filter((i) => !findingStates[i]!.verdict)));
    }},
    { label: "Switch view", shortcut: "Tab", action: () => {
      const views: Array<"active" | "filtered" | "dismissed"> = ["active", "filtered", "dismissed"];
      setViewMode(views[(views.indexOf(viewMode) + 1) % views.length]!);
      setSelectedIndex(0);
      setSelectedIndices(new Set());
    }},
    { label: "Re-audit", shortcut: "r", action: () => { reauditCurrent(); }},
    { label: "Follow-up", shortcut: "f", action: () => { if (selected?.verdict) setShowFollowUp(true); }},
    { label: "Switch provider", shortcut: "Ctrl+P", action: () => { onSwitchProvider?.(); }},
    { label: "Toggle tracing", shortcut: "Ctrl+L", action: () => {
      if (!tracingActive && process.env.LANGSMITH_API_KEY) {
        initTracing().then((ok) => {
          if (ok) setTracingActive(true);
        });
      }
    }},
    { label: "Quit", shortcut: "q", action: () => { exit(); }},
  ];

  if (showCommandPanel) {
    return (
      <Box width={termWidth} height={termHeight - 1}>
        <CommandPanel
          commands={commandDefs}
          concurrency={concurrency}
          onConcurrencyChange={(value) => {
            setConcurrency(value);
            if (projectConfig) {
              projectConfig.concurrency = value;
              projectConfig.save();
            }
          }}
          onClose={() => setShowCommandPanel(false)}
          width={termWidth}
          height={termHeight - 1}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={termWidth} height={termHeight - 1}>
    <Box flexDirection="row" width={termWidth} height={mainHeight}>
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
              const cw = tableWidth - 7; // padding + marker
              const line = `${fileLine} ${rule}`;
              const clipped = line.length > cw ? line.slice(0, cw - 1) + "…" : line;
              const marker = isMultiSelected ? "●" : " ";
              return (
                <Box key={fp}>
                  <Text dimColor={!isSelected}>
                    {isSelected ? ">" : " "} {marker} {clipped}
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
            finding={selected.finding}
            isActive={triagingIndices.has(selectedIndex)}
            width={panelWidth - 4}
            height={termHeight - 3}
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
            queue={queueState ? [...queueState.activeIndices].map((idx) => ({
              label: findingStates[idx]!.finding.check_id.split(".").pop() ?? "",
              status: "active" as const,
            })) : undefined}
            queueDone={queueState?.completed}
            queueTotal={queueState?.items.length}
            sessionUsage={sessionUsage}
            currentUsage={currentUsage}
            tracingActive={tracingActive}
            width={sidebarWidth}
          />
        </Box>
      )}
    </Box>
    {notification && (
      <Box width={termWidth} height={1}>
        <Text color="cyan" bold> {notification}</Text>
      </Box>
    )}
    </Box>
  );
}

function App({
  orchestrator,
  initialConfig,
  projectConfig,
}: {
  orchestrator: TriageOrchestrator;
  initialConfig: Partial<AppConfig>;
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
  const [findings, setFindings] = useState<FindingState[]>([]);
  const [filteredFindings, setFilteredFindings] = useState<FilteredFinding[]>([]);
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

      // Save config
      projectConfig.provider = result.provider as any;
      projectConfig.model = result.model;
      projectConfig.apiKey = result.apiKey;
      projectConfig.baseUrl = result.baseUrl;
      if (result.reasoningEffort === "low" || result.reasoningEffort === "medium" || result.reasoningEffort === "high") {
        projectConfig.reasoningEffort = result.reasoningEffort;
      } else {
        projectConfig.reasoningEffort = undefined;
      }
      projectConfig.save();

      if (switchingProvider) {
        setConfig(fullConfig);
        setScreen("main");
        setSwitchingProvider(false);
        return;
      }

      try {
        const loaded = orchestrator.loadFindings(resolve(result.findingsPath));
        setConfig(fullConfig);
        setFindings(loaded.active);
        setFilteredFindings(loaded.filtered);
        setTotalCount(loaded.total);
        setScreen("main");
      } catch {
        return; // stay on setup
      }
    },
    [initialConfig, switchingProvider, projectConfig, orchestrator],
  );

  // Auto-load findings when config is already complete on startup
  useEffect(() => {
    if (screen === "main" && config && findings.length === 0 && totalCount === 0) {
      try {
        const loaded = orchestrator.loadFindings(resolve(config.findingsPath));
        setFindings(loaded.active);
        setFilteredFindings(loaded.filtered);
        setTotalCount(loaded.total);
      } catch {
        setScreen("setup");
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (screen === "setup") {
    return <SetupScreen cwd={process.cwd()} projectConfig={projectConfig} onComplete={handleSetupComplete} startStep={switchingProvider ? "provider" : undefined} />;
  }

  if (!config || (findings.length === 0 && filteredFindings.length === 0)) {
    return <Text color="yellow">No findings found.</Text>;
  }

  return (
    <MainScreen
      findings={findings.map((s) => s.finding)}
      findingStatesInit={findings}
      filteredFindings={filteredFindings}
      totalCount={totalCount}
      config={config}
      orchestrator={orchestrator}
      onSwitchProvider={handleSwitchProvider}
      initialView={findings.length === 0 ? "filtered" : "active"}
      projectConfig={projectConfig}
    />
  );
}

export async function runTui(
  orchestrator: TriageOrchestrator,
  initialConfig: Partial<AppConfig>,
  projectConfig: ProjectConfig,
): Promise<void> {
  const app = withFullScreen(
    <App orchestrator={orchestrator} initialConfig={initialConfig} projectConfig={projectConfig} />,
  );
  await app.start();
  await app.waitUntilExit();
}
