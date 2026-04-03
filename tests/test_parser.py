from __future__ import annotations

import json

import pytest

from sast_triage.models import SemgrepFinding
from sast_triage.parser import (
    classify_finding,
    fingerprint_finding,
    has_dataflow_trace,
    parse_semgrep_output,
)


def _make_finding_dict(check_id="test.rule", path="app.py", line=10, has_trace=False):
    finding = {
        "check_id": check_id,
        "path": path,
        "start": {"line": line, "col": 0, "offset": 0},
        "end": {"line": line, "col": 50, "offset": 50},
        "extra": {
            "message": "Test finding",
            "severity": "WARNING",
            "lines": "some_code()",
            "metadata": {},
        },
    }
    if has_trace:
        finding["extra"]["dataflow_trace"] = {
            "taint_source": {
                "content": "source_code",
                "location": {"path": path, "start": {"line": 5, "col": 0, "offset": 0}, "end": {"line": 5, "col": 20, "offset": 20}},
            },
            "intermediate_vars": [],
            "taint_sink": {
                "content": "sink_code",
                "location": {"path": path, "start": {"line": line, "col": 0, "offset": 0}, "end": {"line": line, "col": 50, "offset": 50}},
            },
        }
    return finding


def test_parse_full_output():
    raw = {"results": [_make_finding_dict(), _make_finding_dict(check_id="other.rule")]}
    findings = parse_semgrep_output(raw)
    assert len(findings) == 2
    assert all(isinstance(f, SemgrepFinding) for f in findings)


def test_parse_raw_json_string():
    raw = json.dumps({"results": [_make_finding_dict()]})
    findings = parse_semgrep_output(raw)
    assert len(findings) == 1
    assert findings[0].check_id == "test.rule"


def test_parse_list_of_findings():
    raw = [_make_finding_dict(), _make_finding_dict(check_id="rule.two")]
    findings = parse_semgrep_output(raw)
    assert len(findings) == 2


def test_parse_empty_results():
    findings = parse_semgrep_output({"results": []})
    assert findings == []


def test_parse_malformed_skips():
    valid = _make_finding_dict()
    invalid = {"path": "app.py", "start": {"line": 1, "col": 0, "offset": 0}}
    findings = parse_semgrep_output([valid, invalid])
    assert len(findings) == 1
    assert findings[0].check_id == "test.rule"


def test_has_dataflow_trace_true():
    finding = SemgrepFinding.model_validate(_make_finding_dict(has_trace=True))
    assert has_dataflow_trace(finding) is True


def test_has_dataflow_trace_false():
    finding = SemgrepFinding.model_validate(_make_finding_dict(has_trace=False))
    assert has_dataflow_trace(finding) is False


def test_has_dataflow_trace_none():
    d = _make_finding_dict()
    d["extra"]["dataflow_trace"] = None
    finding = SemgrepFinding.model_validate(d)
    assert has_dataflow_trace(finding) is False


def test_classify_taint():
    finding = SemgrepFinding.model_validate(_make_finding_dict(has_trace=True))
    assert classify_finding(finding) == "taint"


def test_classify_pattern():
    finding = SemgrepFinding.model_validate(_make_finding_dict(has_trace=False))
    assert classify_finding(finding) == "pattern"


def test_fingerprint_stability():
    finding = SemgrepFinding.model_validate(_make_finding_dict())
    assert fingerprint_finding(finding) == fingerprint_finding(finding)


def test_fingerprint_different_for_different_lines():
    f1 = SemgrepFinding.model_validate(_make_finding_dict(line=10))
    f2 = SemgrepFinding.model_validate(_make_finding_dict(line=20))
    assert fingerprint_finding(f1) != fingerprint_finding(f2)
