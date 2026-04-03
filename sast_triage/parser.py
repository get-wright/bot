from __future__ import annotations

import hashlib
import json
import logging
from typing import Literal

from sast_triage.models import SemgrepFinding

logger = logging.getLogger(__name__)


def parse_semgrep_output(raw: dict | str | list) -> list[SemgrepFinding]:
    if isinstance(raw, str):
        raw = json.loads(raw)

    if isinstance(raw, list):
        results = raw
    elif isinstance(raw, dict):
        results = raw.get("results", [])
    else:
        return []

    findings = []
    for i, item in enumerate(results):
        try:
            findings.append(SemgrepFinding.model_validate(item))
        except Exception as e:
            logger.warning("Skipping malformed finding at index %d: %s", i, e)
    return findings


def has_dataflow_trace(finding: SemgrepFinding) -> bool:
    trace = finding.extra.dataflow_trace
    if trace is None:
        return False
    return trace.taint_source is not None or trace.taint_sink is not None


def classify_finding(finding: SemgrepFinding) -> Literal["taint", "pattern"]:
    return "taint" if has_dataflow_trace(finding) else "pattern"


def fingerprint_finding(finding: SemgrepFinding) -> str:
    data = f"{finding.check_id}:{finding.path}:{finding.start.line}:{finding.extra.lines}"
    return hashlib.sha256(data.encode()).hexdigest()[:16]
