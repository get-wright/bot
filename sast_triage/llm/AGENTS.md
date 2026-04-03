# LLM MODULE

OpenAI-compatible client with explicit `Provider` enum, structured-output fallback chain, and security-focused prompt templates.

## OVERVIEW

Wraps `openai.OpenAI` to call any compatible API (OpenAI, Anthropic via compat endpoint, OpenRouter, Ollama). Users choose provider explicitly via `Provider` enum — no model-name sniffing. Sends an `AssembledContext` + system prompt → receives a `TriageVerdict`.

## PROVIDER SYSTEM

```python
class Provider(str, Enum):
    OPENAI = "openai"                    # GPT chat models — system role, no reasoning_effort
    OPENAI_REASONING = "openai-reasoning" # o1/o3/o4 — developer role + reasoning_effort
    ANTHROPIC = "anthropic"              # Claude via OpenAI-compat endpoint
    OPENAI_COMPATIBLE = "openai-compatible" # OpenRouter/Ollama/vLLM — skips structured output
```

Provider determines: role (`developer` vs `system`), whether `reasoning_effort` is sent, whether `_try_structured()` is attempted, and default base URL / API key env var.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add new provider | `client.py` → `Provider` enum + `_PROVIDER_BASE_URLS` + `_PROVIDER_API_KEY_ENVS` | Add enum value + mappings |
| Add vuln-class prompt guidance | `prompts.py` → `VULN_CLASS_CONTEXT` | Dict keyed by vuln class string from assembler |
| Change system prompt | `prompts.py` → `SYSTEM_PROMPT` | Single string, role = security analyst |
| Change user prompt format | `prompts.py` → `build_user_prompt()` | Assembles AssembledContext fields into text |
| Add response format | `client.py` → `_try_structured()` | Uses Pydantic schema via `response_format` |
| Change fallback parsing | `client.py` → `_try_raw()` + `_parse_raw_json()` | Bracket-matching JSON extractor |
| Add CLI provider inference | `cli.py` → `_infer_provider()` | Model-name → provider mapping for backward compat |

## FALLBACK CHAIN

```
1. _try_structured()     → OpenAI response_format with Pydantic schema (skipped for OPENAI_COMPATIBLE)
   ↓ (fails: model doesn't support structured output)
2. _try_raw()            → Same prompt, no response_format; parse JSON from text
   ↓ (fails: no valid JSON in response)
3. regex extraction      → Pull verdict/confidence/reasoning from free text
   ↓ (fails: unrecognizable response)
4. _fallback()           → "needs_review", confidence=0.0
```

## ANTI-PATTERNS

- **Never add `reasoning_effort` unconditionally** — only `OPENAI_REASONING` provider sends it. Other APIs reject unknown parameters.
- **Token logging uses `logger.info`** — `_log_usage()` logs prompt/completion tokens at INFO level. Set log level to WARNING in production to suppress.
- **CLI `_infer_provider()` is a convenience, not the source of truth** — programmatic users must pass `provider=` explicitly. Inference exists only for CLI backward compatibility.
