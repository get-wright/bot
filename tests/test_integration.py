import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from sast_triage.memory.store import MemoryStore
from sast_triage.models import TriageVerdict
from sast_triage.pipeline import TriagePipeline


FIXTURES = Path(__file__).parent / "fixtures"


def _make_mock_llm(verdict="true_positive", confidence=0.9):
    mock = MagicMock()
    mock.triage.return_value = TriageVerdict(
        verdict=verdict,
        confidence=confidence,
        reasoning="Integration test reasoning",
        key_evidence=["test evidence"],
    )
    return mock


def _file_reader(path: str) -> bytes:
    """Read from fixtures directory."""
    fixture_path = FIXTURES / Path(path).name
    if fixture_path.exists():
        return fixture_path.read_bytes()
    return b""


class TestEndToEnd:
    def test_taint_finding_full_flow(self):
        """Taint finding -> pre-filter passes -> Branch A context -> LLM -> verdict."""
        data = json.loads((FIXTURES / "semgrep_taint_output.json").read_text())
        mock_llm = _make_mock_llm()
        pipeline = TriagePipeline(llm_client=mock_llm, file_reader=_file_reader)
        results = pipeline.run(data)
        assert len(results) == 2
        assert all(not r.filtered for r in results)
        assert all(r.verdict is not None for r in results)
        assert mock_llm.triage.call_count == 2
        call_args = mock_llm.triage.call_args_list[0]
        context = call_args[0][0]
        assert context.trace_context is not None

    def test_pattern_finding_full_flow(self):
        """Pattern finding -> pre-filter passes -> Branch B context -> LLM -> verdict."""
        data = json.loads((FIXTURES / "semgrep_pattern_output.json").read_text())
        mock_llm = _make_mock_llm()
        pipeline = TriagePipeline(llm_client=mock_llm, file_reader=_file_reader)
        results = pipeline.run(data)
        assert len(results) == 2
        assert all(not r.filtered for r in results)
        assert all(r.classification == "pattern" for r in results)
        for call_args in mock_llm.triage.call_args_list:
            context = call_args[0][0]
            assert context.trace_context is None

    def test_mixed_findings_routing(self):
        """Mixed input: taint -> Branch A, pattern -> Branch B, test file -> filtered."""
        data = json.loads((FIXTURES / "semgrep_mixed_output.json").read_text())
        mock_llm = _make_mock_llm()
        pipeline = TriagePipeline(llm_client=mock_llm, file_reader=_file_reader)
        results = pipeline.run(data)
        assert len(results) == 3
        filtered = [r for r in results if r.filtered]
        assert len(filtered) >= 1
        assert any("Test file" in (r.filter_reason or "") for r in filtered)
        non_filtered = [r for r in results if not r.filtered]
        assert all(r.verdict is not None for r in non_filtered)

    def test_prefilter_skips_test_files(self):
        """Findings in test files are filtered, never hit LLM."""
        data = json.loads((FIXTURES / "semgrep_mixed_output.json").read_text())
        mock_llm = _make_mock_llm()
        pipeline = TriagePipeline(llm_client=mock_llm, file_reader=_file_reader)
        results = pipeline.run(data)
        test_results = [r for r in results if "test" in r.finding.path.lower()]
        for r in test_results:
            assert r.filtered is True
        total_findings = len(results)
        filtered_count = sum(1 for r in results if r.filtered)
        assert mock_llm.triage.call_count == total_findings - filtered_count

    def test_memory_feedback_loop(self, tmp_path):
        """Run pipeline -> store verdict -> add feedback -> verify memory populated."""
        data = json.loads((FIXTURES / "semgrep_taint_output.json").read_text())
        mock_llm = _make_mock_llm()
        db_path = str(tmp_path / "integration_test.db")
        memory = MemoryStore(db_path=db_path)
        pipeline = TriagePipeline(llm_client=mock_llm, memory=memory, file_reader=_file_reader)
        results = pipeline.run(data)
        non_filtered = [r for r in results if not r.filtered]
        assert len(non_filtered) > 0
        for r in non_filtered:
            record = memory.lookup(r.fingerprint)
            assert record is not None
            assert record.verdict == "true_positive"
        fp = non_filtered[0].fingerprint
        memory.add_feedback(fp, "Confirmed true positive")
        record = memory.lookup(fp)
        assert record.feedback == "Confirmed true positive"
        memory.close()

    def test_no_llm_mode(self):
        """No LLM: only pre-filtering runs, no verdicts assigned."""
        data = json.loads((FIXTURES / "semgrep_mixed_output.json").read_text())
        pipeline = TriagePipeline(llm_client=None, file_reader=_file_reader)
        results = pipeline.run(data)
        assert len(results) == 3
        for r in results:
            if not r.filtered:
                assert r.verdict is None

    def test_to_dict_serializable(self):
        """Verify all results can be JSON serialized."""
        data = json.loads((FIXTURES / "semgrep_taint_output.json").read_text())
        mock_llm = _make_mock_llm()
        pipeline = TriagePipeline(llm_client=mock_llm, file_reader=_file_reader)
        results = pipeline.run(data)
        output = [r.to_dict() for r in results]
        json_str = json.dumps(output, indent=2)
        assert len(json_str) > 0
        parsed = json.loads(json_str)
        assert len(parsed) == len(results)
