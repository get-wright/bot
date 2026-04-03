from __future__ import annotations

import pytest

from sast_triage.context.assembler import ContextAssembler
from sast_triage.context.code_extractor import CodeExtractor
from sast_triage.models import (
    DataflowTrace,
    DataflowTraceNode,
    Location,
    Position,
    SemgrepExtra,
    SemgrepFinding,
    SemgrepMetadata,
)


SAMPLE_PY_SOURCE = b"""\
import os
from django.http import HttpResponse
from django.db import connection

def get_user(request):
    user_id = request.GET.get("id")
    cursor = connection.cursor()
    cursor.execute("SELECT * FROM users WHERE id = " + user_id)
    return HttpResponse(cursor.fetchone())

def caller_of_get_user(request):
    return get_user(request)
"""

SAMPLE_JS_SOURCE = b"""\
const express = require('express');
const app = express();

app.get('/user', (req, res) => {
  const id = req.query.id;
  res.send('<h1>' + id + '</h1>');
});
"""


def _make_finding(
    check_id: str = "python.django.security.injection.sql-injection",
    path: str = "app.py",
    line: int = 8,
    message: str = "SQL injection detected",
    severity: str = "ERROR",
    lines: str = 'cursor.execute("SELECT * FROM users WHERE id = " + user_id)',
    cwe: list[str] | None = None,
    vulnerability_class: list[str] | None = None,
    technology: list[str] | None = None,
    dataflow_trace: DataflowTrace | None = None,
) -> SemgrepFinding:
    return SemgrepFinding(
        check_id=check_id,
        path=path,
        start=Position(line=line, col=0),
        end=Position(line=line, col=80),
        extra=SemgrepExtra(
            message=message,
            severity=severity,
            lines=lines,
            dataflow_trace=dataflow_trace,
            metadata=SemgrepMetadata(
                cwe=cwe or [],
                vulnerability_class=vulnerability_class or [],
                technology=technology or [],
            ),
        ),
    )


def _make_trace(
    source_content: str = "user_id = request.GET.get('id')",
    sink_content: str = "cursor.execute(query)",
    intermediates: list[str] | None = None,
) -> DataflowTrace:
    loc = Location(
        path="app.py",
        start=Position(line=1, col=0),
        end=Position(line=1, col=40),
    )
    source_node = DataflowTraceNode(content=source_content, location=loc)
    sink_node = DataflowTraceNode(content=sink_content, location=loc)
    iv_nodes = [
        DataflowTraceNode(content=c, location=loc)
        for c in (intermediates or [])
    ]
    return DataflowTrace(
        taint_source=source_node,
        taint_sink=sink_node,
        intermediate_vars=iv_nodes,
    )


@pytest.fixture
def extractor():
    return CodeExtractor()


@pytest.fixture
def assembler(extractor):
    return ContextAssembler(code_extractor=extractor)


class TestTaintFindingBranchA:
    def test_taint_finding_uses_branch_a(self, assembler):
        trace = _make_trace()
        finding = _make_finding(dataflow_trace=trace)
        file_contents = {"app.py": SAMPLE_PY_SOURCE}

        result = assembler.assemble(finding, file_contents)

        assert result.trace_context is not None
        assert result.trace_context.source_code == "user_id = request.GET.get('id')"
        assert result.trace_context.sink_code == "cursor.execute(query)"
        assert result.code_context.function_body is not None


class TestPatternFindingBranchB:
    def test_pattern_finding_uses_branch_b(self, assembler):
        finding = _make_finding(dataflow_trace=None)
        file_contents = {"app.py": SAMPLE_PY_SOURCE}

        result = assembler.assemble(finding, file_contents)

        assert result.trace_context is None
        assert result.code_context.function_body is not None
        assert "get_user" in result.code_context.function_signature


class TestFrameworkDetection:
    def test_framework_detection_django(self, assembler):
        finding = _make_finding(
            cwe=["CWE-89: SQL Injection"],
        )
        file_contents = {"app.py": SAMPLE_PY_SOURCE}

        result = assembler.assemble(finding, file_contents)

        assert len(result.framework_hints) > 0
        assert any("Django" in h or "django" in h for h in result.framework_hints)

    def test_framework_detection_express(self, assembler):
        finding = _make_finding(
            check_id="javascript.express.security.xss",
            path="app.js",
            line=6,
            message="XSS detected",
            lines="res.send('<h1>' + id + '</h1>')",
            cwe=["CWE-79: Cross-site Scripting"],
        )
        file_contents = {"app.js": SAMPLE_JS_SOURCE}

        result = assembler.assemble(finding, file_contents)

        assert len(result.framework_hints) > 0
        assert any("Express" in h or "express" in h for h in result.framework_hints)

    def test_framework_detection_none(self, assembler):
        stdlib_source = b"import os\nimport sys\n\ndef func():\n    pass\n"
        finding = _make_finding(
            check_id="generic.security.issue",
            path="app.py",
            line=5,
            cwe=[],
            vulnerability_class=[],
            technology=[],
        )
        file_contents = {"app.py": stdlib_source}

        result = assembler.assemble(finding, file_contents)

        assert result.framework_hints == []

    def test_framework_from_metadata(self, assembler):
        stdlib_source = b"import os\n\ndef func():\n    pass\n"
        finding = _make_finding(
            check_id="python.security.sqli",
            path="app.py",
            line=3,
            cwe=["CWE-89: SQL Injection"],
            technology=["django"],
        )
        file_contents = {"app.py": stdlib_source}

        result = assembler.assemble(finding, file_contents)

        assert len(result.framework_hints) > 0


class TestVulnClassification:
    def test_vuln_classification_from_class(self, assembler):
        finding = _make_finding(vulnerability_class=["SQL Injection"])
        file_contents = {"app.py": SAMPLE_PY_SOURCE}

        result = assembler.assemble(finding, file_contents)

        assert result.vulnerability_class == "sqli"

    def test_vuln_classification_from_cwe(self, assembler):
        finding = _make_finding(
            check_id="generic.rule",
            cwe=["CWE-79: Cross-site Scripting"],
            vulnerability_class=[],
        )
        file_contents = {"app.py": SAMPLE_PY_SOURCE}

        result = assembler.assemble(finding, file_contents)

        assert result.vulnerability_class == "xss"

    def test_vuln_classification_from_rule_id(self, assembler):
        finding = _make_finding(
            check_id="python.django.security.injection.sql-injection",
            cwe=[],
            vulnerability_class=[],
        )
        file_contents = {"app.py": SAMPLE_PY_SOURCE}

        result = assembler.assemble(finding, file_contents)

        assert result.vulnerability_class == "sqli"

    def test_vuln_classification_default(self, assembler):
        finding = _make_finding(
            check_id="generic.unknown.rule",
            cwe=[],
            vulnerability_class=[],
        )
        file_contents = {"app.py": SAMPLE_PY_SOURCE}

        result = assembler.assemble(finding, file_contents)

        assert result.vulnerability_class == "default"


class TestTraceSummary:
    def test_trace_summary(self, assembler):
        trace = _make_trace(
            source_content="user_input = request.args.get('q')",
            sink_content="db.execute(query)",
            intermediates=["query = 'SELECT * FROM t WHERE x=' + user_input"],
        )
        finding = _make_finding(dataflow_trace=trace)
        file_contents = {"app.py": SAMPLE_PY_SOURCE}

        result = assembler.assemble(finding, file_contents)

        summary = result.trace_context.trace_summary
        assert "user_input = request.args.get('q')" in summary
        assert "db.execute(query)" in summary
        assert "1 intermediate step" in summary
        assert "→" in summary


class TestMissingFileGraceful:
    def test_missing_file_graceful(self, assembler):
        finding = _make_finding(path="nonexistent.py")
        file_contents = {}

        result = assembler.assemble(finding, file_contents)

        assert result.code_context.function_body is None
        assert result.code_context.function_signature is None
        assert result.code_context.imports == []


class TestTypeCoercionDetected:
    def test_type_coercion_detected(self, assembler):
        finding = _make_finding(
            lines="user_id = int(request.GET.get('id'))",
            cwe=["CWE-89: SQL Injection"],
        )
        file_contents = {"app.py": SAMPLE_PY_SOURCE}

        result = assembler.assemble(finding, file_contents)

        assert any("Type coercion detected" in h for h in result.framework_hints)
        assert any("int(" in h for h in result.framework_hints)
