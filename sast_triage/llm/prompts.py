from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sast_triage.models import AssembledContext


SYSTEM_PROMPT = """You are an expert application security engineer specializing in static analysis triage.

Your task: Given a SAST finding and its surrounding code context, determine whether this is a TRUE POSITIVE (exploitable vulnerability), FALSE POSITIVE (not exploitable), or NEEDS REVIEW (insufficient context to decide).

## Decision Framework

### True Positive Criteria
- User-controlled data reaches a dangerous sink WITHOUT adequate sanitization
- The code path is reachable in production (not dead code, not test-only)
- No framework-level protection mitigates the vulnerability
- The vulnerability class matches the actual risk (e.g., XSS requires HTML context)

### False Positive Criteria
- Input is sanitized, escaped, or validated before reaching the sink
- Type coercion effectively neutralizes the attack (int(), float() for injection)
- Framework auto-escaping is active and not bypassed
- The data is not user-controlled (hardcoded values, server-generated, admin-only)
- ORM parameterized queries are used correctly
- The code is unreachable in production

### Needs Review Criteria
- Sanitization exists but may be incomplete or bypassable
- Custom sanitization function whose effectiveness cannot be determined from context
- Complex data flow spanning multiple services or async boundaries
- Configuration-dependent behavior (the finding may or may not be exploitable)

## Analysis Steps
1. Identify the SINK (dangerous operation) and what data reaches it
2. Trace backward: where does that data originate? Is it user-controlled?
3. Check each step in the data flow for sanitization or type conversion
4. Consider framework-level protections mentioned in the hints
5. Evaluate whether the vulnerability is exploitable in context

## Output Requirements
- verdict: Your determination (true_positive, false_positive, needs_review)
- confidence: 0.0 to 1.0 reflecting certainty
- reasoning: Step-by-step explanation of your analysis
- key_evidence: Specific code patterns or facts that drove your decision
- suggested_fix: If true_positive, a concrete remediation suggestion

Be precise. Cite specific line patterns. Do not speculate beyond the provided context."""


FOLLOWUP_SYSTEM_PROMPT = """You are an expert application security engineer answering follow-up questions about a SAST finding that was already triaged.

You have access to the original finding details, code context, and the previous verdict with reasoning.

Answer the user's question directly and conversationally. Be specific about the code and finding in question. If the user asks about exploitability, mitigations, or fixes, give concrete, actionable answers referencing the actual code.

Do NOT output JSON. Do NOT produce a new verdict unless explicitly asked. Just answer the question clearly."""


VULN_CLASS_CONTEXT: dict[str, str] = {
    "xss": """XSS-Specific Guidance:
- Auto-escaping (Django/Jinja2/React JSX) prevents reflected/stored XSS unless explicitly bypassed
- Check for: mark_safe(), |safe filter, dangerouslySetInnerHTML, {% autoescape off %}
- Content-type matters: application/json responses are NOT vulnerable to XSS
- DOM XSS requires JavaScript sink analysis (innerHTML, document.write, eval)
- int()/float() type coercion eliminates XSS risk for that variable""",

    "sqli": """SQL Injection-Specific Guidance:
- ORM methods (.filter(), .get(), .exclude()) are parameterized and SAFE
- cursor.execute() with %s/%d placeholders is SAFE
- cursor.execute() with f-strings or .format() is VULNERABLE
- int() coercion on user input eliminates SQLi risk for that parameter
- Stored procedures may or may not be safe depending on implementation
- .raw() and .extra() in Django require careful review""",

    "ssrf": """SSRF-Specific Guidance:
- User-controlled URLs passed to HTTP clients (requests.get, fetch, urllib) are vulnerable
- Check for: URL validation, allowlist of domains, IP blocking
- Internal service URLs constructed from user input are high-risk
- DNS rebinding can bypass naive IP-based checks
- Redirects can bypass URL validation""",

    "path_traversal": """Path Traversal-Specific Guidance:
- os.path.join() does NOT prevent traversal (../../../etc/passwd still works)
- Check for: os.path.realpath() + startswith() validation
- pathlib.Path.resolve() + is_relative_to() is the safe pattern
- Serving files: check if path is constrained to an allowed directory
- URL-encoded traversal sequences (%2e%2e%2f) may bypass string checks""",

    "command_injection": """Command Injection-Specific Guidance:
- subprocess with shell=True + user input is ALWAYS vulnerable
- subprocess with shell=False and list arguments is SAFE
- shlex.quote() provides escaping but shell=False is preferred
- os.system() is always dangerous with user input
- Template strings in shell commands are vulnerable""",

    "deserialization": """Deserialization-Specific Guidance:
- pickle.loads() with untrusted data is ALWAYS vulnerable (RCE)
- yaml.safe_load() is safe; yaml.load() with Loader=FullLoader is NOT
- JSON deserialization is generally safe (no code execution)
- XML deserialization: check for XXE (external entities)
- Java: ObjectInputStream with untrusted data is vulnerable""",

    "crypto": """Cryptography-Specific Guidance:
- Weak algorithms: MD5, SHA1 for password hashing or signatures
- Hardcoded keys/secrets in source code
- ECB mode for block ciphers is insecure
- Insufficient key length (< 2048 RSA, < 256 AES)
- Missing IV/nonce for symmetric encryption""",

    "auth": """Authentication-Specific Guidance:
- Missing authentication checks on sensitive endpoints
- Broken access control: check for proper role/permission verification
- JWT: check for algorithm confusion (alg=none), key validation
- Session management: check for secure cookie flags, session fixation
- Password handling: check for proper hashing (bcrypt/argon2)""",

    "default": """General Security Guidance:
- Trace the data flow from source to sink
- Check for any sanitization or validation in the path
- Consider framework-level protections
- Evaluate whether the code is reachable in production""",
}


def build_user_prompt(context: AssembledContext) -> str:
    vuln_guidance = VULN_CLASS_CONTEXT.get(
        context.vulnerability_class,
        VULN_CLASS_CONTEXT["default"],
    )

    sections: list[str] = []

    sections.append(f"""## FINDING
Rule: {context.rule_id}
Severity: {context.severity}
Vulnerability Class: {context.vulnerability_class}
File: {context.file_path}
Description: {context.finding_summary}""")

    sections.append(f"## VULNERABILITY-SPECIFIC GUIDANCE\n{vuln_guidance}")

    code = context.code_context
    code_parts: list[str] = []
    if code.function_signature:
        code_parts.append(f"### Function Signature\n```\n{code.function_signature}\n```")
    if code.decorators:
        code_parts.append(f"### Decorators\n" + "\n".join(f"- {d}" for d in code.decorators))
    if code.function_body:
        code_parts.append(f"### Function Body\n```\n{code.function_body}\n```")
    if code.imports:
        code_parts.append(f"### Imports\n```\n" + "\n".join(code.imports) + "\n```")
    if code.caller_signatures:
        code_parts.append(f"### Callers\n" + "\n".join(f"- `{c}`" for c in code.caller_signatures))
    if code_parts:
        sections.append("## CODE CONTEXT\n" + "\n\n".join(code_parts))

    if context.trace_context:
        trace = context.trace_context
        trace_parts: list[str] = []
        if trace.source_code:
            trace_parts.append(f"### Taint Source\n```\n{trace.source_code}\n```")
        if trace.intermediate_steps:
            steps = "\n".join(f"{i+1}. `{s}`" for i, s in enumerate(trace.intermediate_steps))
            trace_parts.append(f"### Intermediate Steps\n{steps}")
        if trace.sink_code:
            trace_parts.append(f"### Taint Sink\n```\n{trace.sink_code}\n```")
        if trace.trace_summary:
            trace_parts.append(f"### Trace Summary\n{trace.trace_summary}")
        if trace_parts:
            sections.append("## DATAFLOW TRACE\n" + "\n\n".join(trace_parts))

    if context.framework_hints:
        hints = "\n".join(f"- {h}" for h in context.framework_hints)
        sections.append(f"## FRAMEWORK ANALYSIS\n{hints}")

    if context.memory_hints:
        hints = "\n".join(f"- {h}" for h in context.memory_hints)
        sections.append(f"## HISTORICAL CONTEXT\n{hints}")

    return "\n\n".join(sections)
