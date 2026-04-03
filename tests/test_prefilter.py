from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from sast_triage.memory.store import MemoryStore
from sast_triage.models import Position, SemgrepExtra, SemgrepFinding, TriageRecord
from sast_triage.prefilter import PrefilterResult, prefilter_finding


def _make_finding(path="src/app.py", severity="WARNING"):
    return SemgrepFinding(
        check_id="test.rule",
        path=path,
        start=Position(line=10, col=0),
        end=Position(line=10, col=50),
        extra=SemgrepExtra(severity=severity),
    )


def _make_record(fingerprint="fp1", verdict="true_positive", confidence=0.9):
    return TriageRecord(
        fingerprint=fingerprint,
        check_id="test.rule",
        path="src/app.py",
        verdict=verdict,
        confidence=confidence,
        reasoning="Test reasoning",
        created_at="2025-01-01T00:00:00+00:00",
        updated_at="2025-01-01T00:00:00+00:00",
    )


def test_test_file_py():
    result = prefilter_finding(_make_finding(path="tests/test_views.py"))
    assert result.passed is False
    assert result.reason == "Test file"


def test_test_file_js():
    result = prefilter_finding(_make_finding(path="src/utils.spec.js"))
    assert result.passed is False
    assert result.reason == "Test file"


def test_test_file_dir():
    result = prefilter_finding(_make_finding(path="__tests__/helper.ts"))
    assert result.passed is False
    assert result.reason == "Test file"


def test_non_test_file_passes():
    result = prefilter_finding(_make_finding(path="src/app.py"))
    assert result.passed is True


def test_generated_migrations():
    result = prefilter_finding(_make_finding(path="app/migrations/0001.py"))
    assert result.passed is False
    assert result.reason == "Generated/vendor file"


def test_generated_node_modules():
    result = prefilter_finding(_make_finding(path="node_modules/foo/index.js"))
    assert result.passed is False
    assert result.reason == "Generated/vendor file"


def test_generated_vendor():
    result = prefilter_finding(_make_finding(path="vendor/lib/x.go"))
    assert result.passed is False
    assert result.reason == "Generated/vendor file"


def test_normal_file_passes_generated():
    result = prefilter_finding(_make_finding(path="src/handlers/auth.py"))
    assert result.passed is True


def test_cached_high_confidence_filters(tmp_path):
    db_path = str(tmp_path / "memory.db")
    with MemoryStore(db_path=db_path) as memory:
        finding = _make_finding()
        from sast_triage.parser import fingerprint_finding
        fp = fingerprint_finding(finding)
        record = _make_record(fingerprint=fp, confidence=0.9)
        memory.store(record)
        result = prefilter_finding(finding, memory=memory)
    assert result.passed is False
    assert "Cached verdict" in result.reason


def test_cached_low_confidence_passes(tmp_path):
    db_path = str(tmp_path / "memory.db")
    with MemoryStore(db_path=db_path) as memory:
        finding = _make_finding()
        from sast_triage.parser import fingerprint_finding
        fp = fingerprint_finding(finding)
        record = _make_record(fingerprint=fp, confidence=0.5)
        memory.store(record)
        result = prefilter_finding(finding, memory=memory)
    assert result.passed is True


def test_no_memory_skips_cache():
    finding = _make_finding()
    result = prefilter_finding(finding, memory=None)
    assert result.passed is True


def test_info_severity_filtered():
    result = prefilter_finding(_make_finding(severity="INFO"))
    assert result.passed is False
    assert result.reason == "Informational severity"


def test_warning_severity_passes():
    result = prefilter_finding(_make_finding(severity="WARNING"))
    assert result.passed is True


def test_error_severity_passes():
    result = prefilter_finding(_make_finding(severity="ERROR"))
    assert result.passed is True
