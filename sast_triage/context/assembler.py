from __future__ import annotations

import logging

from sast_triage.context.code_extractor import CodeExtractor
from sast_triage.context.framework_kb import (
    FRAMEWORK_DETECTION,
    FRAMEWORK_SANITIZERS,
    SAFE_DECORATORS,
    TYPE_COERCION_SANITIZERS,
)
from sast_triage.models import (
    AssembledContext,
    CodeContext,
    DataflowTrace,
    SemgrepFinding,
    TraceContext,
)
from sast_triage.parser import has_dataflow_trace

logger = logging.getLogger(__name__)


class ContextAssembler:
    def __init__(
        self,
        code_extractor: CodeExtractor | None = None,
        framework_kb: dict | None = None,
    ):
        self._extractor = code_extractor or CodeExtractor()
        self._framework_kb = framework_kb or FRAMEWORK_SANITIZERS

    def assemble(
        self,
        finding: SemgrepFinding,
        file_contents: dict[str, bytes],
        memory_hints: list[str] | None = None,
    ) -> AssembledContext:
        if has_dataflow_trace(finding):
            code_context, trace_context = self._assemble_taint_context(finding, file_contents)
        else:
            code_context = self._assemble_pattern_context(finding, file_contents)
            trace_context = None

        framework_hints = self._get_framework_hints(finding, code_context.imports)

        return AssembledContext(
            finding_summary=finding.extra.message,
            rule_id=finding.check_id,
            vulnerability_class=self._classify_vuln(finding),
            severity=finding.extra.severity,
            file_path=finding.path,
            code_context=code_context,
            trace_context=trace_context,
            framework_hints=framework_hints,
            memory_hints=memory_hints or [],
        )

    def _assemble_taint_context(
        self, finding: SemgrepFinding, file_contents: dict[str, bytes]
    ) -> tuple[CodeContext, TraceContext]:
        source = file_contents.get(finding.path, b"")
        language = self._extractor.detect_language(finding.path) or "python"

        code_context = self._extract_code_context(source, finding.start.line, language)

        trace_context = self._extract_trace_context(finding.extra.dataflow_trace, file_contents)

        return code_context, trace_context

    def _assemble_pattern_context(
        self, finding: SemgrepFinding, file_contents: dict[str, bytes]
    ) -> CodeContext:
        source = file_contents.get(finding.path, b"")
        language = self._extractor.detect_language(finding.path) or "python"

        code_context = self._extract_code_context(source, finding.start.line, language)

        if code_context.function_signature:
            fn_name = self._extract_fn_name_from_sig(code_context.function_signature)
            if fn_name:
                callers = self._extractor.extract_callers(source, fn_name, language)
                code_context = code_context.model_copy(update={"caller_signatures": callers})

        return code_context

    def _extract_code_context(
        self, source: bytes, line: int, language: str
    ) -> CodeContext:
        if not source:
            return CodeContext()

        body = self._extractor.extract_function_body(source, line, language)
        sig = self._extractor.extract_function_signature(source, line, language)
        decorators = self._extractor.extract_decorators(source, line, language)
        imports = self._extractor.extract_imports(source, language)

        return CodeContext(
            function_body=body,
            function_signature=sig,
            decorators=decorators,
            imports=imports,
        )

    def _extract_trace_context(
        self, trace: DataflowTrace | None, file_contents: dict[str, bytes]
    ) -> TraceContext:
        if trace is None:
            return TraceContext()

        source_code = None
        sink_code = None
        intermediate_steps = []

        if trace.taint_source:
            source_code = trace.taint_source.content

        if trace.taint_sink:
            sink_code = trace.taint_sink.content

        for iv in trace.intermediate_vars:
            intermediate_steps.append(iv.content)

        summary = self._summarize_trace(trace)

        return TraceContext(
            source_code=source_code,
            sink_code=sink_code,
            intermediate_steps=intermediate_steps,
            trace_summary=summary,
        )

    def _summarize_trace(self, trace: DataflowTrace) -> str:
        parts = []
        if trace.taint_source:
            parts.append(trace.taint_source.content[:80])

        n_intermediates = len(trace.intermediate_vars)
        if n_intermediates > 0:
            parts.append(f"({n_intermediates} intermediate step{'s' if n_intermediates > 1 else ''})")

        if trace.taint_sink:
            parts.append(trace.taint_sink.content[:80])

        return " → ".join(parts) if parts else ""

    def _get_framework_hints(
        self, finding: SemgrepFinding, imports: list[str]
    ) -> list[str]:
        framework = self._detect_framework(imports)
        if not framework:
            techs = finding.extra.metadata.technology
            for tech in techs:
                if tech.lower() in self._framework_kb:
                    framework = tech.lower()
                    break

        if not framework:
            return []

        vuln_class = self._classify_vuln(finding)
        hints = []

        framework_vulns = self._framework_kb.get(framework, {})
        if vuln_class in framework_vulns:
            hints.extend(framework_vulns[vuln_class])

        safe_decorators = SAFE_DECORATORS.get(framework, [])
        if safe_decorators:
            hints.append(f"Safe decorators for {framework}: {', '.join(safe_decorators)}")

        code_line = finding.extra.lines
        for sanitizer in TYPE_COERCION_SANITIZERS:
            if sanitizer in code_line:
                hints.append(f"Type coercion detected: {sanitizer} — likely sanitizes injection")
                break

        return hints

    def _detect_framework(self, imports: list[str]) -> str | None:
        import_text = " ".join(imports).lower()
        for framework, patterns in FRAMEWORK_DETECTION.items():
            for pattern in patterns:
                if pattern.lower() in import_text:
                    return framework
        return None

    def _classify_vuln(self, finding: SemgrepFinding) -> str:
        vuln_classes = finding.extra.metadata.vulnerability_class
        if vuln_classes:
            class_lower = vuln_classes[0].lower()
            if "sql" in class_lower or "injection" in class_lower:
                return "sqli"
            if "xss" in class_lower or "cross-site scripting" in class_lower:
                return "xss"
            if "ssrf" in class_lower:
                return "ssrf"
            if "path" in class_lower or "traversal" in class_lower:
                return "path_traversal"
            if "command" in class_lower or "rce" in class_lower:
                return "command_injection"
            if "deserial" in class_lower:
                return "deserialization"
            if "crypto" in class_lower:
                return "crypto"
            if "auth" in class_lower:
                return "auth"

        cwe_map = {
            "79": "xss", "89": "sqli", "918": "ssrf",
            "22": "path_traversal", "78": "command_injection",
            "502": "deserialization", "327": "crypto", "287": "auth",
        }
        for cwe_str in finding.extra.metadata.cwe:
            for cwe_num, vuln_type in cwe_map.items():
                if f"CWE-{cwe_num}" in cwe_str:
                    return vuln_type

        rule_lower = finding.check_id.lower()
        for keyword, vuln_type in [
            ("sql", "sqli"), ("xss", "xss"), ("ssrf", "ssrf"),
            ("path-traversal", "path_traversal"), ("command-injection", "command_injection"),
            ("exec", "command_injection"), ("deserial", "deserialization"),
        ]:
            if keyword in rule_lower:
                return vuln_type

        return "default"

    @staticmethod
    def _extract_fn_name_from_sig(sig: str) -> str | None:
        if sig.startswith("def ") or sig.startswith("async def "):
            parts = sig.split("(")[0].split()
            return parts[-1] if parts else None
        if sig.startswith("function "):
            parts = sig.split("(")[0].split()
            return parts[-1] if parts else None
        if sig.startswith("const "):
            parts = sig.split("=")[0].split()
            return parts[-1] if len(parts) >= 2 else None
        return None
