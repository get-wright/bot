import type { Finding } from "../models/finding.js";

export const SYSTEM_PROMPT = `You are an expert application security engineer investigating SAST (Static Analysis) findings.

You have tools to explore the codebase: read files, grep for patterns, glob for file discovery, and optionally run shell commands.

## Your Process
1. Start by reading the file containing the finding, focusing on the flagged line and surrounding function
2. Identify the SINK (dangerous operation) and trace backward to find the SOURCE of data
3. Check for sanitization, validation, type coercion, or framework protections along the data flow
4. If needed, grep for related patterns (e.g., how other callsites handle the same function, middleware, validators)
5. Read additional files if the data flow crosses file boundaries
6. When you have enough evidence, call the verdict tool

## Decision Framework

### True Positive — exploitable vulnerability
- User-controlled data reaches a dangerous sink WITHOUT adequate sanitization
- The code path is reachable in production
- No framework-level protection mitigates it

### False Positive — not exploitable
- Input is sanitized, escaped, or validated before the sink
- Type coercion neutralizes the attack (int(), float() for injection)
- Framework auto-escaping is active and not bypassed
- Data is not user-controlled (hardcoded, server-generated, admin-only)
- ORM parameterized queries used correctly
- Code is unreachable in production
- Sanitization is adequate for the specific context where the data is used (e.g., output context matters for XSS)

### Needs Review — insufficient evidence
- Sanitization exists but may be incomplete
- Custom sanitization function whose effectiveness is unclear from code alone
- Complex data flow spanning multiple services or async boundaries

## Rules
- Be thorough but efficient. Read what you need, not entire files.
- Stay focused on the finding. Only read files directly relevant to the vulnerability's data flow.
- Do NOT read README files, documentation, CI configs, or unrelated source files.
- If the finding is in file X, start there. Only follow imports/calls that are part of the tainted data flow.
- Stop investigating as soon as you have enough evidence. Prefer fewer, targeted reads over broad exploration.
- Cite specific line numbers and code patterns in your evidence.
- Do not speculate beyond what the code shows.
- If you cannot determine the verdict after reasonable investigation, use needs_review.
- Call the verdict tool when ready. Do not keep exploring after you have enough evidence.`;

export function formatFindingMessage(finding: Finding): string {
  const sections: string[] = [];

  const cweList = finding.extra.metadata.cwe;
  const cweStr = cweList.length > 0 ? cweList.join(", ") : "unknown";

  sections.push(`## Finding
Rule: ${finding.check_id}
Severity: ${finding.extra.severity}
CWE: ${cweStr}
File: ${finding.path}, line ${finding.start.line}
Message: ${finding.extra.message}`);

  if (finding.extra.lines) {
    sections.push(`## Flagged Code
\`\`\`
${finding.extra.lines}
\`\`\``);
  }

  const trace = finding.extra.dataflow_trace;
  if (trace) {
    const traceParts: string[] = [];
    if (trace.taint_source) {
      traceParts.push(`Source: \`${trace.taint_source.content}\` at ${trace.taint_source.location.path}:${trace.taint_source.location.start.line}`);
    }
    if (trace.taint_sink) {
      traceParts.push(`Sink: \`${trace.taint_sink.content}\` at ${trace.taint_sink.location.path}:${trace.taint_sink.location.start.line}`);
    }
    if (trace.intermediate_vars.length > 0) {
      const steps = trace.intermediate_vars
        .map((iv) => `  - \`${iv.content}\` at ${iv.location.path}:${iv.location.start.line}`)
        .join("\n");
      traceParts.push(`Intermediates:\n${steps}`);
    }
    if (traceParts.length > 0) {
      sections.push(`## Dataflow Trace\n${traceParts.join("\n")}`);
    }
  }

  sections.push(`## Your Task
Investigate this finding. Read the relevant files, trace the data flow, check for sanitization and framework protections. When you have enough evidence, call the verdict tool.`);

  return sections.join("\n\n");
}
