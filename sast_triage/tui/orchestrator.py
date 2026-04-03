from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Iterator

from sast_triage.context.assembler import ContextAssembler
from sast_triage.context.code_extractor import CodeExtractor
from sast_triage.parser import classify_finding, fingerprint_finding

if TYPE_CHECKING:
    from sast_triage.llm.client import TriageLLMClient
    from sast_triage.memory.store import MemoryStore
    from sast_triage.models import (
        AssembledContext,
        SemgrepFinding,
        TriageRecord,
        TriageVerdict,
    )

logger = logging.getLogger(__name__)


@dataclass
class AuditStepResult:
    step: str
    icon: str
    message: str
    detail: str = ""
    verdict: TriageVerdict | None = None
    context: AssembledContext | None = None
    needs_permission: bool = False
    blocked_paths: list[str] = field(default_factory=list)


class AuditOrchestrator:
    def __init__(
        self,
        workspace: Path,
        llm_client: TriageLLMClient | None = None,
        memory_db_path: str | None = None,
    ) -> None:
        self._workspace = Path(workspace).resolve()
        self._llm = llm_client
        self._memory_db_path = memory_db_path
        self._extractor = CodeExtractor()
        self._assembler = ContextAssembler(code_extractor=self._extractor)
        self._allowed_paths: list[str] = []

    def set_allowed_paths(self, paths: list[str]) -> None:
        self._allowed_paths = list(paths)

    def add_allowed_path(self, path: str) -> None:
        if path not in self._allowed_paths:
            self._allowed_paths.append(path)

    def _is_path_allowed(self, path: str) -> bool:
        try:
            Path(path).resolve().relative_to(self._workspace)
            return True
        except ValueError:
            pass
        return any(path.startswith(ap) for ap in self._allowed_paths)

    def audit_finding_iter(
        self, finding: SemgrepFinding
    ) -> Iterator[AuditStepResult]:
        # Create a thread-local MemoryStore connection.
        # SQLite connections cannot be shared across threads.
        memory: MemoryStore | None = None
        if self._memory_db_path:
            from sast_triage.memory.store import MemoryStore
            memory = MemoryStore(db_path=self._memory_db_path)

        try:
            yield from self._audit_finding_steps(finding, memory)
        finally:
            if memory:
                memory.close()

    def _audit_finding_steps(
        self, finding: SemgrepFinding, memory: MemoryStore | None
    ) -> Iterator[AuditStepResult]:
        # Step 1: Fingerprint
        fp = fingerprint_finding(finding)
        yield AuditStepResult(
            step="fingerprint",
            icon="✓",
            message="Fingerprint computed",
            detail=fp[:12] + "...",
        )

        # Step 2: Classify
        classification = classify_finding(finding)
        cwe_list = finding.extra.metadata.cwe
        cwe_str = ", ".join(cwe_list) if cwe_list else "unknown"
        yield AuditStepResult(
            step="classify",
            icon="✓",
            message=f"Parsed finding: {classification} classification",
            detail=f"{cwe_str} · {finding.extra.severity}",
        )

        # Step 3: Read files
        paths_needed = self._collect_paths(finding)
        blocked = [p for p in paths_needed if not self._is_path_allowed(p)]
        if blocked:
            yield AuditStepResult(
                step="read_files",
                icon="⚠",
                message="Permission required for files outside workspace",
                needs_permission=True,
                blocked_paths=blocked,
            )

        file_contents: dict[str, bytes] = {}
        for path in paths_needed:
            if not self._is_path_allowed(path):
                continue
            try:
                file_contents[path] = Path(path).read_bytes()
            except (FileNotFoundError, OSError) as e:
                logger.warning("Could not read file %s: %s", path, e)

        read_detail = "\n".join(f"{p} OK" for p in file_contents)
        yield AuditStepResult(
            step="read_files",
            icon="✓",
            message="Reading source files",
            detail=read_detail,
        )

        # Step 4: Context assembly
        memory_hints: list[str] = []
        if memory:
            memory_hints = memory.get_hints(finding.check_id, fp)

        context = self._assembler.assemble(finding, file_contents, memory_hints)
        assembly_parts = [f"Vulnerability class: {context.vulnerability_class}"]

        cc = context.code_context
        if cc.function_signature:
            assembly_parts.append(f"Function: {cc.function_signature}")
        if cc.function_body:
            line_count = cc.function_body.count("\n") + 1
            assembly_parts.append(f"Function body: {line_count} lines extracted")
        if cc.imports:
            assembly_parts.append(f"Imports: {len(cc.imports)} found")
            for imp in cc.imports[:5]:
                assembly_parts.append(f"  {imp.strip()[:80]}")
            if len(cc.imports) > 5:
                assembly_parts.append(f"  ... +{len(cc.imports) - 5} more")
        if cc.decorators:
            assembly_parts.append(f"Decorators: {', '.join(cc.decorators)}")
        if cc.caller_signatures:
            assembly_parts.append(f"Callers: {len(cc.caller_signatures)} found")
            for caller in cc.caller_signatures[:3]:
                assembly_parts.append(f"  {caller.strip()[:80]}")
        if context.framework_hints:
            assembly_parts.append(f"Framework: {', '.join(context.framework_hints)}")
        if context.trace_context:
            tc = context.trace_context
            if tc.source_code:
                assembly_parts.append(f"Taint source: {tc.source_code.strip()[:80]}")
            if tc.sink_code:
                assembly_parts.append(f"Taint sink: {tc.sink_code.strip()[:80]}")
            if tc.intermediate_steps:
                assembly_parts.append(f"{len(tc.intermediate_steps)} intermediate vars traced")
        if context.memory_hints:
            assembly_parts.append(f"Memory: {len(context.memory_hints)} hints from prior triages")

        assembly_detail = "\n".join(assembly_parts)

        yield AuditStepResult(
            step="context_assembly",
            icon="✓",
            message=f"Context assembly ({classification} branch)",
            detail=assembly_detail,
            context=context,
        )

        # Step 5: LLM call
        if self._llm:
            provider_label = f"{self._llm.provider.value}/{self._llm._model}"
            yield AuditStepResult(
                step="llm_call",
                icon="◐",
                message=f"Calling {provider_label}...",
            )

            verdict = self._llm.triage(context)

            # Step 6: Store
            if memory and verdict:
                from sast_triage.models import TriageRecord

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
                memory.store(record)
                yield AuditStepResult(
                    step="stored",
                    icon="✓",
                    message="Verdict stored to memory",
                )

            yield AuditStepResult(
                step="verdict",
                icon="✓",
                message="Verdict ready",
                verdict=verdict,
                context=context,
            )
        else:
            yield AuditStepResult(
                step="verdict",
                icon="—",
                message="No LLM configured — context assembled only",
                context=context,
            )

    def _collect_paths(self, finding: SemgrepFinding) -> list[str]:
        paths = {finding.path}
        trace = finding.extra.dataflow_trace
        if trace:
            if trace.taint_source:
                paths.add(trace.taint_source.location.path)
            if trace.taint_sink:
                paths.add(trace.taint_sink.location.path)
            for iv in trace.intermediate_vars:
                paths.add(iv.location.path)
        return sorted(paths)
