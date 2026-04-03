from __future__ import annotations

import json
import logging
from pathlib import Path

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import DataTable, Footer, Header, Input, Static, TabbedContent, TabPane

from sast_triage.models import SemgrepFinding
from sast_triage.parser import classify_finding, parse_semgrep_output
from sast_triage.prefilter import prefilter_finding
from sast_triage.tui.config import ProjectConfig
from sast_triage.tui.widgets.findings_table import FindingsTable
from sast_triage.tui.widgets.sidebar import SessionSidebar

logger = logging.getLogger(__name__)


class MainScreen(Screen):
    BINDINGS = [
        ("space", "toggle_selection", "Select"),
        ("enter", "audit_selected", "Audit"),
        ("a", "select_all", "Select all"),
        ("o", "load_json", "Load JSON"),
        ("slash", "filter_findings", "Filter"),
        ("tab", "next_tab", "Next tab"),
        ("ctrl+p", "switch_provider", "Provider"),
        ("question_mark", "show_help", "Help"),
        ("q", "quit", "Quit"),
    ]

    def __init__(self, workspace: Path, config: ProjectConfig) -> None:
        super().__init__()
        self._workspace = workspace
        self._config = config
        self._actionable: list[SemgrepFinding] = []
        self._filtered: list[tuple[SemgrepFinding, str]] = []
        self._classifications: dict[str, str] = {}
        self._memory = None

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal():
            with Vertical(id="main-content"):
                with TabbedContent(id="main-tabs"):
                    with TabPane("Actionable", id="actionable"):
                        yield Static("", classes="findings-summary", id="actionable-summary")
                        yield FindingsTable(id="findings-actionable")
                    with TabPane("Filtered", id="filtered"):
                        yield FindingsTable(id="findings-filtered")
                    with TabPane("Saved", id="saved"):
                        yield FindingsTable(id="findings-saved")
                with Vertical(id="detail-preview"):
                    yield Static("", id="detail-rule", classes="detail-value")
                    yield Static("", id="detail-cwe", classes="detail-value")
                    yield Static("", id="detail-msg", classes="detail-value")
            yield SessionSidebar()
        yield Footer()

    def on_mount(self) -> None:
        sidebar = self.query_one(SessionSidebar)
        sidebar.set_session_info(
            self._config.provider_name,
            self._config.model,
            self._config.reasoning_effort,
        )

        # Init memory
        from sast_triage.memory.store import MemoryStore
        self._memory = MemoryStore(db_path=self._config.memory_db_path)
        records = self._memory.list_all()
        sidebar.set_memory_info(
            self._config.memory_db_path.rsplit("/", 1)[-1],
            len(records),
        )

        # Load saved results into Saved tab
        self._load_saved_results(records)

        # Auto-import findings.json if present
        default_path = self._workspace / "findings.json"
        if default_path.exists():
            self._import_findings(default_path)

    def _import_findings(self, path: Path) -> None:
        try:
            data = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError) as e:
            self.notify(f"Failed to load {path.name}: {e}", severity="error")
            return

        all_findings = parse_semgrep_output(data)
        if not all_findings:
            self.notify("No findings in file", severity="warning")
            return

        self._actionable = []
        self._filtered = []
        self._classifications = {}

        for f in all_findings:
            self._classifications[f.check_id] = classify_finding(f)
            pf = prefilter_finding(f, self._memory)
            if pf.passed:
                self._actionable.append(f)
            else:
                self._filtered.append((f, pf.reason or "Unknown"))

        # Populate actionable table
        actionable_table = self.query_one("#findings-actionable", FindingsTable)
        actionable_table.load_findings(self._actionable, self._classifications)

        # Populate filtered table
        filtered_table = self.query_one("#findings-filtered", FindingsTable)
        filtered_findings = [f for f, _ in self._filtered]
        filtered_table.load_findings(filtered_findings, self._classifications)

        # Update summary
        taint_count = sum(1 for f in self._actionable if self._classifications.get(f.check_id) == "taint")
        pattern_count = len(self._actionable) - taint_count
        summary = self.query_one("#actionable-summary", Static)
        summary.update(
            f"  {len(self._actionable)} findings · {taint_count} taint · {pattern_count} pattern"
        )

        # Update sidebar
        sidebar = self.query_one(SessionSidebar)
        sidebar.set_findings_info(path.name, len(self._actionable), len(self._filtered))
        sidebar.set_selected([])

        self.notify(f"Loaded {len(all_findings)} findings from {path.name}")

    def _load_saved_results(self, records) -> None:
        saved_table = self.query_one("#findings-saved", FindingsTable)
        # Reuse DataTable directly for saved results (different column schema)
        saved_table.clear()
        if not saved_table.columns:
            saved_table.add_columns("★", "Rule ID", "Verdict", "Conf.", "Path", "Date")
        for r in records:
            star = "★" if r.starred else " "
            rule_short = r.check_id.rsplit(".", 1)[-1] if "." in r.check_id else r.check_id
            conf = f"{r.confidence:.0%}"
            verdict_short = {"true_positive": "TP", "false_positive": "FP", "needs_review": "NR"}.get(
                r.verdict, r.verdict
            )
            date = r.updated_at[:10] if r.updated_at else ""
            saved_table.add_row(star, rule_short, verdict_short, conf, r.path, date, key=r.fingerprint)

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        # Update detail preview for actionable tab
        tabs = self.query_one(TabbedContent)
        if tabs.active != "actionable":
            return
        table = self.query_one("#findings-actionable", FindingsTable)
        finding = table.finding_at(event.cursor_row)
        if finding:
            self.query_one("#detail-rule", Static).update(f"Rule: {finding.check_id}")
            cwe = ", ".join(finding.extra.metadata.cwe) if finding.extra.metadata.cwe else "—"
            self.query_one("#detail-cwe", Static).update(f"CWE:  {cwe}")
            msg = finding.extra.message[:120]
            self.query_one("#detail-msg", Static).update(f"Msg:  {msg}")

    def action_toggle_selection(self) -> None:
        table = self.query_one("#findings-actionable", FindingsTable)
        table.toggle_row(table.cursor_row)
        self._update_selected_sidebar()

    def action_select_all(self) -> None:
        table = self.query_one("#findings-actionable", FindingsTable)
        table.select_all()
        self._update_selected_sidebar()

    def action_audit_selected(self) -> None:
        table = self.query_one("#findings-actionable", FindingsTable)
        selected = table.selected_findings
        if not selected:
            self.notify("No findings selected", severity="warning")
            return
        from sast_triage.tui.screens.audit import AuditScreen
        self.app.push_screen(
            AuditScreen(
                workspace=self._workspace,
                config=self._config,
                findings=selected,
                memory=self._memory,
            )
        )

    def action_load_json(self) -> None:
        self.app.push_screen(
            _FileInputScreen(workspace=self._workspace),
            callback=self._on_file_selected,
        )

    def _on_file_selected(self, path: str | None) -> None:
        if path:
            self._import_findings(Path(path))

    def action_next_tab(self) -> None:
        tabs = self.query_one(TabbedContent)
        tab_ids = ["actionable", "filtered", "saved"]
        current = tab_ids.index(tabs.active) if tabs.active in tab_ids else 0
        tabs.active = tab_ids[(current + 1) % len(tab_ids)]

    def action_filter_findings(self) -> None:
        self.notify("Filter not yet implemented", severity="information")

    def action_switch_provider(self) -> None:
        from sast_triage.tui.screens.config import ConfigScreen
        self.app.push_screen(ConfigScreen(workspace=self._workspace))

    def action_show_help(self) -> None:
        self.notify(
            "space:select  enter:audit  a:all  o:load  tab:switch  ctrl+p:provider  q:quit",
            title="Keybindings",
            timeout=8,
        )

    def _update_selected_sidebar(self) -> None:
        table = self.query_one("#findings-actionable", FindingsTable)
        selected = table.selected_findings
        rules = [f.check_id.rsplit(".", 1)[-1] for f in selected]
        sidebar = self.query_one(SessionSidebar)
        sidebar.set_selected(rules)


class _FileInputScreen(Screen):
    """Modal screen for entering a file path."""

    BINDINGS = [("escape", "cancel", "Cancel")]

    def __init__(self, workspace: Path) -> None:
        super().__init__()
        self._workspace = workspace

    def compose(self) -> ComposeResult:
        yield Static("Enter path to Semgrep JSON file:")
        yield Input(
            placeholder=str(self._workspace / "findings.json"),
            id="file-path-input",
        )

    def on_input_submitted(self, event: Input.Submitted) -> None:
        path = event.value.strip()
        if path and Path(path).exists():
            self.dismiss(path)
        elif path:
            self.notify(f"File not found: {path}", severity="error")
        else:
            self.dismiss(None)

    def action_cancel(self) -> None:
        self.dismiss(None)
