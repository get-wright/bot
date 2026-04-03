from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Position(BaseModel):
    line: int
    col: int
    offset: int = 0


class Location(BaseModel):
    path: str
    start: Position
    end: Position


class DataflowTraceNode(BaseModel):
    model_config = ConfigDict(extra="allow")

    content: str
    location: Location


class DataflowTrace(BaseModel):
    model_config = ConfigDict(extra="allow")

    taint_source: DataflowTraceNode | None = None
    intermediate_vars: list[DataflowTraceNode] = Field(default_factory=list)
    taint_sink: DataflowTraceNode | None = None

    @model_validator(mode="before")
    @classmethod
    def _normalize_cliloc(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        for field in ("taint_source", "taint_sink"):
            val = data.get(field)
            if isinstance(val, list) and len(val) == 2 and val[0] == "CliLoc":
                payload = val[1]
                if isinstance(payload, list) and len(payload) == 2:
                    loc, content = payload
                    if isinstance(loc, dict) and isinstance(content, str):
                        data[field] = {"location": loc, "content": content}
        ivars = data.get("intermediate_vars")
        if isinstance(ivars, list):
            normalized = []
            for iv in ivars:
                if isinstance(iv, list) and len(iv) == 2 and iv[0] == "CliLoc":
                    payload = iv[1]
                    if isinstance(payload, list) and len(payload) == 2:
                        loc, content = payload
                        iv = {"location": loc, "content": content}
                normalized.append(iv)
            data["intermediate_vars"] = normalized
        return data


class SemgrepMetadata(BaseModel):
    model_config = ConfigDict(extra="allow")

    cwe: list[str] = Field(default_factory=list)
    confidence: str = "MEDIUM"
    category: str = "security"
    technology: list[str] = Field(default_factory=list)
    owasp: list[str] = Field(default_factory=list)
    vulnerability_class: list[str] = Field(default_factory=list)


class SemgrepExtra(BaseModel):
    model_config = ConfigDict(extra="allow")

    message: str = ""
    severity: str = "WARNING"
    metadata: SemgrepMetadata = Field(default_factory=SemgrepMetadata)
    dataflow_trace: DataflowTrace | None = None
    lines: str = ""
    metavars: dict[str, Any] = Field(default_factory=dict)


class SemgrepFinding(BaseModel):
    model_config = ConfigDict(extra="allow")

    check_id: str
    path: str
    start: Position
    end: Position
    extra: SemgrepExtra = Field(default_factory=SemgrepExtra)


class CodeContext(BaseModel):
    function_body: str | None = None
    function_signature: str | None = None
    decorators: list[str] = Field(default_factory=list)
    imports: list[str] = Field(default_factory=list)
    caller_signatures: list[str] = Field(default_factory=list)


class TraceContext(BaseModel):
    source_code: str | None = None
    source_context: CodeContext | None = None
    sink_code: str | None = None
    sink_context: CodeContext | None = None
    intermediate_steps: list[str] = Field(default_factory=list)
    trace_summary: str = ""


class AssembledContext(BaseModel):
    finding_summary: str
    rule_id: str
    vulnerability_class: str
    severity: str
    file_path: str
    code_context: CodeContext
    trace_context: TraceContext | None = None
    framework_hints: list[str] = Field(default_factory=list)
    memory_hints: list[str] = Field(default_factory=list)


class TriageVerdict(BaseModel):
    verdict: Literal["true_positive", "false_positive", "needs_review"] = Field(
        description="The triage decision for this finding"
    )
    confidence: float = Field(
        ge=0.0, le=1.0, description="Confidence score between 0 and 1"
    )
    reasoning: str = Field(
        description="Step-by-step reasoning explaining the verdict"
    )
    key_evidence: list[str] = Field(
        default_factory=list,
        description="Specific code or context evidence supporting the verdict",
    )
    suggested_fix: str | None = Field(
        default=None, description="Suggested remediation if true positive"
    )


class TriageRecord(BaseModel):
    fingerprint: str
    check_id: str
    path: str
    verdict: str
    confidence: float
    reasoning: str
    feedback: str | None = None
    created_at: str
    updated_at: str
