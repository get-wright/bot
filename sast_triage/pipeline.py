from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from sast_triage.context.assembler import ContextAssembler
from sast_triage.context.code_extractor import CodeExtractor
from sast_triage.llm.client import TriageLLMClient
from sast_triage.memory.store import MemoryStore
from sast_triage.models import SemgrepFinding, TriageRecord, TriageVerdict
from sast_triage.parser import (
    classify_finding,
    fingerprint_finding,
    parse_semgrep_output,
)
from sast_triage.prefilter import prefilter_finding

logger = logging.getLogger(__name__)


@dataclass
class TriageResult:
    finding: SemgrepFinding
    fingerprint: str
    classification: str = "pattern"
    verdict: TriageVerdict | None = None
    filtered: bool = False
    filter_reason: str | None = None

    def to_dict(self) -> dict:
        result = {
            "rule_id": self.finding.check_id,
            "path": self.finding.path,
            "line": self.finding.start.line,
            "fingerprint": self.fingerprint,
            "classification": self.classification,
            "filtered": self.filtered,
        }
        if self.filtered:
            result["filter_reason"] = self.filter_reason
        if self.verdict:
            result["verdict"] = self.verdict.verdict
            result["confidence"] = self.verdict.confidence
            result["reasoning"] = self.verdict.reasoning
            result["key_evidence"] = self.verdict.key_evidence
            if self.verdict.suggested_fix:
                result["suggested_fix"] = self.verdict.suggested_fix
        return result


class TriagePipeline:
    def __init__(
        self,
        llm_client: TriageLLMClient | None = None,
        memory: MemoryStore | None = None,
        code_extractor: CodeExtractor | None = None,
        file_reader: Callable[[str], bytes] | None = None,
    ):
        self._llm = llm_client
        self._memory = memory
        self._extractor = code_extractor or CodeExtractor()
        self._assembler = ContextAssembler(code_extractor=self._extractor)
        self._file_reader = file_reader or self._default_file_reader

    def run(self, semgrep_input: dict | str | list) -> list[TriageResult]:
        findings = parse_semgrep_output(semgrep_input)
        if not findings:
            return []

        file_contents = self._read_files(findings)
        results = []

        for finding in findings:
            result = self._process_finding(finding, file_contents)
            results.append(result)

        return results

    def _process_finding(
        self, finding: SemgrepFinding, file_contents: dict[str, bytes]
    ) -> TriageResult:
        fp = fingerprint_finding(finding)
        classification = classify_finding(finding)

        pf_result = prefilter_finding(finding, self._memory)
        if not pf_result.passed:
            return TriageResult(
                finding=finding,
                fingerprint=fp,
                classification=classification,
                filtered=True,
                filter_reason=pf_result.reason,
            )

        memory_hints = []
        if self._memory:
            memory_hints = self._memory.get_hints(finding.check_id, fp)

        context = self._assembler.assemble(finding, file_contents, memory_hints)

        verdict = None
        if self._llm:
            verdict = self._llm.triage(context)

            if self._memory and verdict:
                now = datetime.now(timezone.utc).isoformat()
                record = TriageRecord(
                    fingerprint=fp,
                    check_id=finding.check_id,
                    path=finding.path,
                    verdict=verdict.verdict,
                    confidence=verdict.confidence,
                    reasoning=verdict.reasoning,
                    created_at=now,
                    updated_at=now,
                )
                self._memory.store(record)

        return TriageResult(
            finding=finding,
            fingerprint=fp,
            classification=classification,
            verdict=verdict,
        )

    def _read_files(self, findings: list[SemgrepFinding]) -> dict[str, bytes]:
        paths = set()
        for f in findings:
            paths.add(f.path)
            if f.extra.dataflow_trace:
                trace = f.extra.dataflow_trace
                if trace.taint_source:
                    paths.add(trace.taint_source.location.path)
                if trace.taint_sink:
                    paths.add(trace.taint_sink.location.path)
                for iv in trace.intermediate_vars:
                    paths.add(iv.location.path)

        contents = {}
        for path in paths:
            try:
                contents[path] = self._file_reader(path)
            except (FileNotFoundError, OSError) as e:
                logger.warning("Could not read file %s: %s", path, e)
        return contents

    @staticmethod
    def _default_file_reader(path: str) -> bytes:
        return Path(path).read_bytes()
