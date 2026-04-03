from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from textual import work
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import Footer, Header, Input, Static, TabbedContent, TabPane
from textual.worker import get_current_worker

from sast_triage.llm.client import Provider, TriageLLMClient
from sast_triage.tui.config import ProjectConfig
from sast_triage.tui.orchestrator import AuditOrchestrator
from sast_triage.tui.widgets.sidebar import SessionSidebar
from sast_triage.tui.widgets.thinking_log import ThinkingLog
from sast_triage.tui.widgets.verdict_panel import VerdictPanel

if TYPE_CHECKING:
    from sast_triage.memory.store import MemoryStore
    from sast_triage.models import AssembledContext, SemgrepFinding, TriageVerdict


class AuditScreen(Screen):
    BINDINGS = [
        ("tab", "next_tab", "Thinking/Verdict"),
        ("s", "star", "Star"),
        ("r", "reaudit", "Re-audit"),
        ("f", "followup", "Follow-up"),
        ("n", "next_finding", "Next"),
        ("escape", "back", "Back"),
    ]

    def __init__(
        self,
        workspace: Path,
        config: ProjectConfig,
        findings: list[SemgrepFinding],
    ) -> None:
        super().__init__()
        self._workspace = workspace
        self._config = config
        self._findings = findings
        self._current_index = 0
        self._current_verdict: TriageVerdict | None = None
        self._current_context: AssembledContext | None = None
        self._current_fingerprint: str | None = None
        self._queue_status: list[tuple[int, str, str]] = []

        # Build LLM client from config
        self._llm: TriageLLMClient | None = None
        if config.api_key:
            self._llm = TriageLLMClient(
                model=config.model,
                provider=config.provider_name,
                reasoning_effort=config.reasoning_effort,
                base_url=config.base_url,
                api_key=config.api_key,
            )

        self._memory_db_path = config.memory_db_path
        self._orchestrator = AuditOrchestrator(
            workspace=workspace,
            llm_client=self._llm,
            memory_db_path=config.memory_db_path,
        )
        self._orchestrator.set_allowed_paths(config.allowed_paths)

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal():
            with Vertical(id="audit-content"):
                with TabbedContent(id="audit-tabs"):
                    with TabPane("Thinking", id="thinking"):
                        yield ThinkingLog(id="thinking-log")
                    with TabPane("Verdict", id="verdict"):
                        yield VerdictPanel(id="verdict-panel")
            yield SessionSidebar()
        yield Footer()

    def on_mount(self) -> None:
        # Main-thread MemoryStore for star/unstar actions
        self._main_memory = None
        if self._memory_db_path:
            from sast_triage.memory.store import MemoryStore
            self._main_memory = MemoryStore(db_path=self._memory_db_path)

        sidebar = self.query_one(SessionSidebar)
        sidebar.set_session_info(
            self._config.provider_name,
            self._config.model,
            self._config.reasoning_effort,
        )
        self._init_queue()
        self._run_current_audit()

    def _init_queue(self) -> None:
        self._queue_status = []
        for i, f in enumerate(self._findings):
            label = f.check_id.rsplit(".", 1)[-1] if "." in f.check_id else f.check_id
            self._queue_status.append((i + 1, label, ""))
        self._update_queue_sidebar()

    def _update_queue_sidebar(self) -> None:
        sidebar = self.query_one(SessionSidebar)
        # Show completed count, then current + remaining only
        completed = sum(1 for _, _, s in self._queue_status if s and s.startswith("✓"))
        total = len(self._queue_status)
        items = []
        for i, (idx, label, status) in enumerate(self._queue_status):
            if status and status.startswith("✓"):
                continue  # hide completed items
            if i == self._current_index and not status:
                items.append((idx, label, "▸"))
            else:
                items.append((idx, label, status))
        # Prepend summary if any completed
        if completed:
            sidebar.update_section(
                "QUEUE",
                f"  {completed}/{total} done\n" + "\n".join(
                    f" {s} {idx}.{label[:18]}" if s else f"   {idx}.{label[:18]}"
                    for idx, label, s in items
                ),
            )
        else:
            sidebar.set_queue(items)

    def _run_current_audit(self) -> None:
        if self._current_index >= len(self._findings):
            self.notify("All findings audited", severity="information")
            return

        finding = self._findings[self._current_index]

        # Update header
        total = len(self._findings)
        current = self._current_index + 1
        rule = finding.check_id.rsplit(".", 1)[-1] if "." in finding.check_id else finding.check_id
        self.sub_title = f"auditing {current}/{total}  {rule}"

        # Reset UI
        thinking_log = self.query_one("#thinking-log", ThinkingLog)
        thinking_log.clear()
        verdict_panel = self.query_one("#verdict-panel", VerdictPanel)
        verdict_panel.clear_verdict()
        self.query_one(TabbedContent).active = "thinking"

        self._current_verdict = None
        self._current_context = None
        self._audit_worker(finding)

    @work(exclusive=True, group="audit", thread=True)
    def _audit_worker(self, finding: SemgrepFinding) -> None:
        worker = get_current_worker()
        thinking_log = self.query_one("#thinking-log", ThinkingLog)

        from sast_triage.parser import fingerprint_finding
        self._current_fingerprint = fingerprint_finding(finding)

        for step_result in self._orchestrator.audit_finding_iter(finding):
            if worker.is_cancelled:
                return

            self.app.call_from_thread(
                thinking_log.log_step,
                step_result.icon,
                step_result.message,
                step_result.detail,
            )

            if step_result.needs_permission:
                for blocked_path in step_result.blocked_paths:
                    self.app.call_from_thread(
                        self.notify,
                        f"Skipped {blocked_path} (outside workspace). Allow via config.",
                        severity="warning",
                        timeout=5,
                    )

            if step_result.context:
                self._current_context = step_result.context

            if step_result.verdict:
                self._current_verdict = step_result.verdict
                verdict_panel = self.query_one("#verdict-panel", VerdictPanel)
                self.app.call_from_thread(verdict_panel.show_verdict, step_result.verdict)
                self.app.call_from_thread(
                    self._update_queue_complete,
                    step_result.verdict,
                )
                self.app.call_from_thread(
                    self.query_one(TabbedContent).__setattr__,
                    "active",
                    "verdict",
                )

    def _update_queue_complete(self, verdict: TriageVerdict) -> None:
        verdict_map = {"true_positive": "TP", "false_positive": "FP", "needs_review": "NR"}
        short = verdict_map.get(verdict.verdict, "?")
        conf = f"{verdict.confidence:.0%}"
        idx, label, _ = self._queue_status[self._current_index]
        self._queue_status[self._current_index] = (idx, label, f"✓ {short} {conf}")
        self._update_queue_sidebar()
        self._update_finished_sidebar()

    def _update_finished_sidebar(self) -> None:
        sidebar = self.query_one(SessionSidebar)
        finished = [
            (idx, label, status)
            for idx, label, status in self._queue_status
            if status and status.startswith("✓")
        ]
        sidebar.set_finished(finished)

    def action_next_tab(self) -> None:
        tabs = self.query_one(TabbedContent)
        tabs.active = "verdict" if tabs.active == "thinking" else "thinking"

    def action_star(self) -> None:
        if self._main_memory and self._current_fingerprint:
            self._main_memory.set_starred(self._current_fingerprint, True)
            self.notify("Verdict starred", severity="information", timeout=3)

    def action_reaudit(self) -> None:
        self._run_current_audit()

    def action_followup(self) -> None:
        if not self._current_context or not self._current_verdict:
            self.notify("No verdict to follow up on", severity="warning")
            return
        self.app.push_screen(
            _FollowUpScreen(),
            callback=self._on_followup_submitted,
        )

    def _on_followup_submitted(self, question: str | None) -> None:
        if not question or not self._llm or not self._current_context:
            return
        self._run_followup(question)

    @work(exclusive=False, group="followup", thread=True)
    def _run_followup(self, question: str) -> None:
        from sast_triage.llm.prompts import SYSTEM_PROMPT, build_user_prompt

        thinking_log = self.query_one("#thinking-log", ThinkingLog)
        self.app.call_from_thread(
            thinking_log.log_step, "?", f"Follow-up: {question}"
        )

        user_prompt = build_user_prompt(self._current_context)
        user_prompt += (
            f"\n\nPrevious verdict: {self._current_verdict.verdict} "
            f"({self._current_verdict.confidence:.0%})\n"
            f"Reasoning: {self._current_verdict.reasoning}\n\n"
            f"User question: {question}\n\n"
            "Answer the question about this finding."
        )

        role = "developer" if self._llm.provider == Provider.OPENAI_REASONING else "system"
        try:
            response = self._llm.chat([
                {"role": role, "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ])
            self.app.call_from_thread(
                thinking_log.log_step, "→", "Follow-up answer", response
            )
        except Exception as e:
            self.app.call_from_thread(
                self.notify, f"Follow-up failed: {e}", severity="error"
            )

    def action_next_finding(self) -> None:
        self._current_index += 1
        if self._current_index < len(self._findings):
            self._run_current_audit()
        else:
            self.notify("All findings audited")

    def action_back(self) -> None:
        self.workers.cancel_group(self, "audit")
        self.app.pop_screen()


class _FollowUpScreen(Screen):
    """Modal screen for entering a follow-up question."""

    BINDINGS = [("escape", "cancel", "Cancel")]

    def compose(self) -> ComposeResult:
        yield Static("Enter your follow-up question:")
        yield Input(placeholder="e.g., Is there a WAF protecting this endpoint?", id="followup-input")

    def on_input_submitted(self, event: Input.Submitted) -> None:
        self.dismiss(event.value.strip() or None)

    def action_cancel(self) -> None:
        self.dismiss(None)
