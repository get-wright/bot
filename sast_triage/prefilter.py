from __future__ import annotations

import os

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sast_triage.memory.store import MemoryStore
    from sast_triage.models import SemgrepFinding


TEST_DIR_PATTERNS = (
    "__tests__", "/tests/", "/test/", "testing/",
)

TEST_FILE_PATTERNS = (
    "test_", "_test.", ".test.", ".spec.", "conftest.", "test_helper",
)

GENERATED_PATH_PATTERNS = (
    "/migrations/", "node_modules/", "/vendor/", "vendor/", "/dist/", "/build/",
    ".generated.", "_pb2.py", ".min.js", "package-lock.json",
    "yarn.lock", ".pb.go", "/gen/", "/generated/",
)


@dataclass
class PrefilterResult:
    passed: bool
    reason: str | None = None


def prefilter_finding(
    finding: SemgrepFinding,
    memory: MemoryStore | None = None,
) -> PrefilterResult:
    if _is_test_file(finding.path):
        return PrefilterResult(passed=False, reason="Test file")

    if _is_generated_file(finding.path):
        return PrefilterResult(passed=False, reason="Generated/vendor file")

    if memory is not None:
        from sast_triage.parser import fingerprint_finding
        cached = _has_cached_verdict(finding, memory, fingerprint_finding(finding))
        if cached:
            return cached

    if _is_info_severity(finding):
        return PrefilterResult(passed=False, reason="Informational severity")

    return PrefilterResult(passed=True)


def _is_test_file(path: str) -> bool:
    path_lower = path.lower()
    basename = os.path.basename(path_lower)
    if any(pattern in basename for pattern in TEST_FILE_PATTERNS):
        return True
    return any(pattern in path_lower for pattern in TEST_DIR_PATTERNS)


def _is_generated_file(path: str) -> bool:
    path_lower = path.lower()
    return any(pattern in path_lower for pattern in GENERATED_PATH_PATTERNS)


def _has_cached_verdict(
    finding: SemgrepFinding, memory: MemoryStore, fingerprint: str
) -> PrefilterResult | None:
    record = memory.lookup(fingerprint)
    if record and record.confidence >= 0.8:
        return PrefilterResult(
            passed=False,
            reason=f"Cached verdict: {record.verdict} ({record.confidence:.0%} confidence)",
        )
    return None


def _is_info_severity(finding: SemgrepFinding) -> bool:
    return finding.extra.severity.upper() == "INFO"
