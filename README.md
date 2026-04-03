# sast-triage

Deterministic context assembly + single LLM call for Semgrep finding triage.

## Setup

```bash
pip install -e ".[dev]"
```

### Semgrep

```bash
pip install semgrep
export SEMGREP_APP_TOKEN="<your-token>"  # from semgrep.dev/orgs/-/settings/tokens
```

Without the token, Semgrep registry rules redact the `lines` field (`"requires login"`), which degrades context quality. Local YAML rules work without auth.

## Unit Tests

```bash
python3 -m pytest tests/ -v
```

87 tests across 8 files. No API keys or network access needed — LLM calls are mocked.

## End-to-End Testing with Real LLM

### 1. Scan a repo

```bash
semgrep scan --config=auto --json --dataflow-traces /path/to/repo > findings.json
```

Good test repos (non-framework, produce diverse findings):

| Repo | Language | Typical findings |
|------|----------|-----------------|
| `juice-shop/juice-shop` | JS/TS | ~66 (40 taint: SQLi, XSS, ReDoS, session fixation) |
| `httpie/cli` | Python | ~6 (1 taint, 5 pattern: Jinja2, cert validation) |
| `locustio/locust` | Python | ~3 (subprocess, insecure hash) |
| `encode/httpx` | Python | ~1 (insecure hash) |

Avoid framework repos (flask, django, express) — findings are mostly FP by design.

### 2. Run triage (no LLM — pre-filter + context assembly only)

```bash
sast-triage triage findings.json --no-llm
```

Verify:
- Test file findings are filtered (`"filter_reason": "Test file"`)
- INFO severity findings are filtered
- `classification` is `"taint"` for findings with dataflow traces, `"pattern"` for others
- No crashes on any input

### 3. Run triage with LLM

```bash
# OpenAI
export OPENAI_API_KEY="sk-..."
sast-triage triage findings.json --model o3-mini

# OpenRouter (or any OpenAI-compatible provider)
sast-triage triage findings.json \
  --model z-ai/glm-4.7 \
  --base-url https://openrouter.ai/api/v1 \
  --api-key sk-or-v1-...

# With memory (stores verdicts for future cache hits)
sast-triage triage findings.json --model o3-mini --memory-db ./triage.db

# Save output
sast-triage triage findings.json --model o3-mini -o results.json
```

### 4. Verify taint branch (Branch A)

Juice Shop produces taint findings with `dataflow_trace`. Verify:

```bash
# Scan
semgrep scan --config=auto --json --dataflow-traces /path/to/juice-shop > juice.json

# Check taint count
python3 -c "
import json
d = json.load(open('juice.json'))
taint = [r for r in d['results']
         if r.get('extra',{}).get('dataflow_trace',{}).get('taint_source')]
print(f'Taint: {len(taint)}, Pattern: {len(d[\"results\"])-len(taint)}')
"

# Triage
sast-triage triage juice.json --model o3-mini -o juice_results.json
```

Expected taint findings to look for:
- `sequelize-express` — SQLi via string concat in raw query (should be TP)
- `detect-non-literal-regexp` — user input in RegExp constructor (should be TP)
- `hardcoded-jwt-secret` — private key in source (should be TP)
- `raw-html-format` — template literal with server-generated data (should be FP)

### 5. Verify pattern branch (Branch B)

httpie produces pattern-only findings (no dataflow traces). Verify:

```bash
sast-triage triage httpie_findings.json --model o3-mini -o httpie_results.json
```

Expected:
- `direct-use-of-jinja2` in `docs/generate.py` → FP (docs script, not web endpoint)
- `disabled-cert-validation` in `update_warnings.py` → TP (verify=False)
- `request-session-with-http` → filtered (INFO severity)

### 6. Verify memory/feedback loop

```bash
# First run — stores verdicts
sast-triage triage findings.json --model o3-mini --memory-db ./test.db -o run1.json

# Check the fingerprint from output
cat run1.json | python3 -c "import json,sys; [print(r['fingerprint']) for r in json.load(sys.stdin)[:1]]"

# Add feedback
sast-triage feedback <fingerprint> "Confirmed TP, WAF does not mitigate" --memory-db ./test.db

# Second run — high-confidence cached verdicts get filtered
sast-triage triage findings.json --model o3-mini --memory-db ./test.db -o run2.json
```

### 7. Programmatic testing

```python
from sast_triage.pipeline import TriagePipeline
from sast_triage.llm.client import TriageLLMClient
from sast_triage.memory.store import MemoryStore

llm = TriageLLMClient(
    model="z-ai/glm-4.7",
    api_key="sk-or-v1-...",
    base_url="https://openrouter.ai/api/v1",
)

# With memory
memory = MemoryStore(db_path="./triage.db")

# Custom file reader (if source files aren't at the paths Semgrep reports)
def reader(path: str) -> bytes:
    # Remap paths, e.g. strip prefix
    actual = path.replace("/tmp/test_repos/juice-shop/", "/home/me/juice-shop/")
    return open(actual, "rb").read()

pipeline = TriagePipeline(llm_client=llm, memory=memory, file_reader=reader)

import json
data = json.load(open("findings.json"))
results = pipeline.run(data)

for r in results:
    if r.verdict:
        print(f"{r.finding.check_id}: {r.verdict.verdict} ({r.verdict.confidence:.0%})")
    elif r.filtered:
        print(f"{r.finding.check_id}: FILTERED ({r.filter_reason})")

memory.close()
```

## Known Quirks

1. **Semgrep CliLoc format**: Registry taint rules return `taint_source`/`taint_sink` as `["CliLoc", [{location}, "content"]]` instead of `{content, location}`. The `DataflowTrace` model normalizes this automatically via `model_validator`.

2. **Pre-filter path matching**: Test file detection checks the basename for `test_`, `_test.`, `.spec.` etc., and the full path for `/tests/`, `/test/` directories. If your repo lives under a path like `/tmp/test_repos/`, the directory pattern won't false-positive match (only basename patterns would).

3. **LLM structured output fallback**: Not all models support OpenAI's `response_format` with Pydantic schemas. The client tries structured output first, then falls back to raw JSON parsing with a bracket-matching extractor. If both fail, returns `needs_review` with 0% confidence.

4. **Model verbosity**: `glm-4.7` produces ~1,500-2,500 completion tokens per finding. `o3-mini` with structured output produces ~200 tokens. Prompt tokens are consistently ~1,000-1,200 regardless of model.

## Architecture

```
Semgrep JSON ──► Parser ──► Pre-filter ──► Context Assembler ──► LLM ──► Memory
                  │              │               │                │
                  │         test files?      Branch A (taint)     │
                  │         generated?       Branch B (pattern)   │
                  │         cached?          framework KB         │
                  │         INFO sev?        tree-sitter          │
                  ▼              ▼               ▼                ▼
            SemgrepFinding  PrefilterResult  AssembledContext  TriageVerdict
```
