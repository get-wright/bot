from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from sast_triage.models import (
    AssembledContext,
    CodeContext,
    Position,
    SemgrepExtra,
    SemgrepFinding,
    SemgrepMetadata,
    TriageVerdict,
)
from sast_triage.tui.orchestrator import AuditOrchestrator, AuditStepResult


def _make_finding(check_id="rule.xss", path="app.py", line=10):
    return SemgrepFinding(
        check_id=check_id,
        path=path,
        start=Position(line=line, col=1),
        end=Position(line=line, col=40),
        extra=SemgrepExtra(
            message="Test finding",
            severity="WARNING",
            metadata=SemgrepMetadata(cwe=["CWE-79"]),
        ),
    )


def _make_verdict(verdict="true_positive", confidence=0.9):
    return TriageVerdict(
        verdict=verdict,
        confidence=confidence,
        reasoning="Test reasoning",
        key_evidence=["evidence1"],
    )


class TestAuditOrchestrator:
    def test_audit_steps_without_llm(self, tmp_path):
        source_file = tmp_path / "app.py"
        source_file.write_bytes(b"def handler():\n    pass\n")

        finding = _make_finding(path=str(source_file))
        orch = AuditOrchestrator(
            workspace=tmp_path,
            llm_client=None,
            memory=None,
        )
        steps = list(orch.audit_finding_iter(finding))
        step_names = [s.step for s in steps]
        assert "fingerprint" in step_names
        assert "classify" in step_names
        assert "read_files" in step_names
        assert "context_assembly" in step_names
        # No LLM step since llm_client is None
        assert "llm_call" not in step_names

    def test_audit_steps_with_llm(self, tmp_path):
        source_file = tmp_path / "app.py"
        source_file.write_bytes(b"def handler():\n    pass\n")

        finding = _make_finding(path=str(source_file))
        mock_llm = MagicMock()
        mock_llm.triage.return_value = _make_verdict()
        mock_llm.provider.value = "openai-reasoning"
        mock_llm._model = "o3-mini"

        orch = AuditOrchestrator(
            workspace=tmp_path,
            llm_client=mock_llm,
            memory=None,
        )
        steps = list(orch.audit_finding_iter(finding))
        step_names = [s.step for s in steps]
        assert "llm_call" in step_names
        verdict_step = next(s for s in steps if s.step == "verdict")
        assert verdict_step.verdict is not None
        assert verdict_step.verdict.verdict == "true_positive"

    def test_file_outside_workspace_flagged(self, tmp_path):
        finding = _make_finding(path="/other/repo/app.py")
        orch = AuditOrchestrator(
            workspace=tmp_path,
            llm_client=None,
            memory=None,
        )
        steps = list(orch.audit_finding_iter(finding))
        read_step = next(s for s in steps if s.step == "read_files" and s.needs_permission)
        assert read_step.needs_permission
        assert "/other/repo/app.py" in read_step.blocked_paths
