from __future__ import annotations

from sast_triage.models import Position, SemgrepExtra, SemgrepFinding, SemgrepMetadata
from sast_triage.tui.widgets.findings_table import FindingsTable


def _make_finding(check_id="rule.xss", path="app.py", line=10, severity="WARNING"):
    return SemgrepFinding(
        check_id=check_id,
        path=path,
        start=Position(line=line, col=1),
        end=Position(line=line, col=40),
        extra=SemgrepExtra(message="Test", severity=severity),
    )


class TestFindingsTable:
    """Test FindingsTable selection logic without mounting the widget.

    DataTable methods (add_columns, add_row, update_cell_at) require a running
    Textual app. We test the pure selection state tracking by manipulating
    _findings and _selected_indices directly.
    """

    def test_selected_findings_empty(self):
        table = FindingsTable()
        assert table.selected_findings == []

    def test_selected_findings_tracks_indices(self):
        table = FindingsTable()
        findings = [
            _make_finding(check_id="rule.xss"),
            _make_finding(check_id="rule.sqli"),
        ]
        table._findings = findings
        table._selected_indices = {0, 1}
        assert len(table.selected_findings) == 2
        assert table.selected_findings[0].check_id == "rule.xss"

    def test_finding_at_valid(self):
        table = FindingsTable()
        findings = [_make_finding(check_id="rule.xss")]
        table._findings = findings
        assert table.finding_at(0) is not None
        assert table.finding_at(0).check_id == "rule.xss"

    def test_finding_at_invalid(self):
        table = FindingsTable()
        table._findings = []
        assert table.finding_at(0) is None
        assert table.finding_at(-1) is None

    def test_selection_toggle_logic(self):
        table = FindingsTable()
        table._findings = [_make_finding(), _make_finding(check_id="rule.b")]
        # Simulate toggle without calling DataTable methods
        table._selected_indices.add(0)
        assert len(table.selected_findings) == 1
        table._selected_indices.discard(0)
        assert len(table.selected_findings) == 0

    def test_select_all_logic(self):
        table = FindingsTable()
        table._findings = [_make_finding(check_id=f"rule.{i}") for i in range(5)]
        table._selected_indices = set(range(5))
        assert len(table.selected_findings) == 5

    def test_clear_selection_logic(self):
        table = FindingsTable()
        table._findings = [_make_finding()]
        table._selected_indices = {0}
        table._selected_indices.clear()
        assert len(table.selected_findings) == 0


from sast_triage.models import TriageVerdict
from sast_triage.tui.widgets.thinking_log import ThinkingLog
from sast_triage.tui.widgets.verdict_panel import VerdictPanel


class TestThinkingLog:
    def test_instantiation(self):
        log = ThinkingLog()
        assert log.highlight is True
        assert log.markup is True

    def test_clear_resets(self):
        log = ThinkingLog()
        log.clear()
        # No exception means it works


class TestVerdictPanel:
    def test_format_verdict_tp(self):
        verdict = TriageVerdict(
            verdict="true_positive",
            confidence=0.92,
            reasoning="SQL injection via string concat",
            key_evidence=["raw query at line 18"],
            suggested_fix="Use parameterized queries",
        )
        banner, details = VerdictPanel.format_verdict(verdict)
        assert "TRUE POSITIVE" in banner
        assert "92%" in banner
        assert "SQL injection" in details
        assert "parameterized queries" in details

    def test_format_verdict_fp(self):
        verdict = TriageVerdict(
            verdict="false_positive",
            confidence=0.81,
            reasoning="Sanitized upstream",
            key_evidence=[],
        )
        banner, details = VerdictPanel.format_verdict(verdict)
        assert "FALSE POSITIVE" in banner
        assert "81%" in banner

    def test_format_verdict_nr(self):
        verdict = TriageVerdict(
            verdict="needs_review",
            confidence=0.45,
            reasoning="Unclear",
            key_evidence=[],
        )
        banner, details = VerdictPanel.format_verdict(verdict)
        assert "NEEDS REVIEW" in banner
