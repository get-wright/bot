from unittest.mock import MagicMock

import pytest

from sast_triage.models import (
    AssembledContext,
    CodeContext,
    SemgrepExtra,
    SemgrepFinding,
    SemgrepMetadata,
    Position,
    TriageVerdict,
)
from sast_triage.pipeline import TriagePipeline, TriageResult


def _make_finding(path="src/app.py", has_trace=False, severity="WARNING"):
    extra_dict = {"severity": severity, "message": "Test", "lines": "code()"}
    if has_trace:
        extra_dict["dataflow_trace"] = {
            "taint_source": {
                "content": "request.GET.get('x')",
                "location": {"path": path, "start": {"line": 5, "col": 0}, "end": {"line": 5, "col": 20}},
            },
            "intermediate_vars": [],
            "taint_sink": {
                "content": "execute(x)",
                "location": {"path": path, "start": {"line": 10, "col": 0}, "end": {"line": 10, "col": 20}},
            },
        }
    return SemgrepFinding(
        check_id="test.rule.sqli",
        path=path,
        start=Position(line=10, col=0),
        end=Position(line=10, col=50),
        extra=SemgrepExtra(**extra_dict),
    )


def _make_mock_llm():
    mock = MagicMock()
    mock.triage.return_value = TriageVerdict(
        verdict="true_positive",
        confidence=0.9,
        reasoning="User input reaches SQL query",
        key_evidence=["request.GET flows to execute()"],
    )
    return mock


def _file_reader(path: str) -> bytes:
    return b"import os\n\ndef foo(request):\n    x = request.GET.get('x')\n    execute(x)\n"


class TestTriagePipeline:
    def test_full_pipeline_taint(self):
        mock_llm = _make_mock_llm()
        pipeline = TriagePipeline(llm_client=mock_llm, file_reader=_file_reader)
        results = pipeline.run({"results": [_make_finding(has_trace=True).model_dump()]})
        assert len(results) == 1
        assert results[0].verdict is not None
        assert results[0].verdict.verdict == "true_positive"
        assert not results[0].filtered
        mock_llm.triage.assert_called_once()

    def test_full_pipeline_pattern(self):
        mock_llm = _make_mock_llm()
        pipeline = TriagePipeline(llm_client=mock_llm, file_reader=_file_reader)
        results = pipeline.run({"results": [_make_finding(has_trace=False).model_dump()]})
        assert len(results) == 1
        assert results[0].classification == "pattern"
        assert results[0].verdict is not None

    def test_filtered_finding_skips_llm(self):
        mock_llm = _make_mock_llm()
        finding = _make_finding(path="tests/test_views.py")
        pipeline = TriagePipeline(llm_client=mock_llm, file_reader=_file_reader)
        results = pipeline.run({"results": [finding.model_dump()]})
        assert len(results) == 1
        assert results[0].filtered is True
        assert results[0].filter_reason == "Test file"
        mock_llm.triage.assert_not_called()

    def test_no_llm_returns_none_verdict(self):
        pipeline = TriagePipeline(llm_client=None, file_reader=_file_reader)
        results = pipeline.run({"results": [_make_finding().model_dump()]})
        assert len(results) == 1
        assert results[0].verdict is None
        assert not results[0].filtered

    def test_memory_populated_after_triage(self, tmp_path):
        from sast_triage.memory.store import MemoryStore
        mock_llm = _make_mock_llm()
        memory = MemoryStore(db_path=str(tmp_path / "test.db"))
        pipeline = TriagePipeline(llm_client=mock_llm, memory=memory, file_reader=_file_reader)
        results = pipeline.run({"results": [_make_finding().model_dump()]})
        assert len(results) == 1
        record = memory.lookup(results[0].fingerprint)
        assert record is not None
        assert record.verdict == "true_positive"
        memory.close()

    def test_empty_input(self):
        pipeline = TriagePipeline(file_reader=_file_reader)
        results = pipeline.run({"results": []})
        assert results == []

    def test_to_dict(self):
        mock_llm = _make_mock_llm()
        pipeline = TriagePipeline(llm_client=mock_llm, file_reader=_file_reader)
        results = pipeline.run({"results": [_make_finding().model_dump()]})
        d = results[0].to_dict()
        assert "rule_id" in d
        assert "verdict" in d
        assert "confidence" in d
        assert d["verdict"] == "true_positive"

    def test_file_reader_callable(self):
        custom_source = b"custom source content"
        called_paths = []
        def custom_reader(path):
            called_paths.append(path)
            return custom_source
        pipeline = TriagePipeline(file_reader=custom_reader)
        pipeline.run({"results": [_make_finding().model_dump()]})
        assert len(called_paths) > 0
