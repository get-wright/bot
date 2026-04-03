from __future__ import annotations

import json
import logging
import re

import openai
from openai import OpenAI

from sast_triage.llm.prompts import SYSTEM_PROMPT, build_user_prompt
from sast_triage.models import AssembledContext, TriageVerdict

logger = logging.getLogger(__name__)


class TriageLLMClient:
    def __init__(
        self,
        model: str = "o3-mini",
        reasoning_effort: str = "medium",
        api_key: str | None = None,
        base_url: str | None = None,
        max_retries: int = 3,
        timeout: float = 60.0,
    ):
        self._model = model
        self._reasoning_effort = reasoning_effort
        client_kwargs: dict = {
            "api_key": api_key,
            "max_retries": max_retries,
            "timeout": timeout,
        }
        if base_url:
            client_kwargs["base_url"] = base_url
        self._client = OpenAI(**client_kwargs)

    def triage(self, context: AssembledContext) -> TriageVerdict:
        role = "developer" if self._model.startswith("o") else "system"
        user_prompt = build_user_prompt(context)

        json_schema_hint = (
            "\n\nRespond with ONLY a JSON object matching this schema, no other text:\n"
            '{"verdict": "true_positive"|"false_positive"|"needs_review", '
            '"confidence": 0.0-1.0, "reasoning": "string", '
            '"key_evidence": ["string"], "suggested_fix": "string or null"}'
        )

        kwargs: dict = {
            "model": self._model,
            "messages": [
                {"role": role, "content": SYSTEM_PROMPT + json_schema_hint},
                {"role": "user", "content": user_prompt},
            ],
        }

        if self._model.startswith("o"):
            kwargs["reasoning_effort"] = self._reasoning_effort

        try:
            return self._try_structured(kwargs) or self._try_raw(kwargs)
        except openai.LengthFinishReasonError:
            logger.error("Response truncated")
            return self._fallback("LLM response was truncated")
        except openai.APIError as e:
            logger.error("OpenAI API error: %s", e)
            raise
        except Exception as e:
            logger.error("Unexpected error during triage: %s", e)
            return self._fallback(f"Unexpected error: {e}")

    def _try_structured(self, kwargs: dict) -> TriageVerdict | None:
        try:
            kwargs["response_format"] = TriageVerdict
            completion = self._client.chat.completions.parse(**kwargs)
            message = completion.choices[0].message

            if message.refusal:
                logger.warning("LLM refused: %s", message.refusal)
                return self._fallback(f"LLM refused: {message.refusal}")

            self._log_usage(completion)

            if message.parsed:
                return message.parsed

            raw = message.content or ""
            if raw:
                return self._parse_raw_json(raw)
            return None

        except (openai.APIError, openai.LengthFinishReasonError):
            raise
        except Exception as e:
            logger.info("Structured output failed (%s), falling back to raw", type(e).__name__)
            kwargs.pop("response_format", None)
            return None

    def _try_raw(self, kwargs: dict) -> TriageVerdict:
        kwargs.pop("response_format", None)
        try:
            completion = self._client.chat.completions.create(**kwargs)
            raw_content = completion.choices[0].message.content or ""
            self._log_usage(completion)
            return self._parse_raw_json(raw_content)
        except (openai.APIError, openai.LengthFinishReasonError):
            raise
        except Exception as e:
            logger.error("Raw fallback also failed: %s", e)
            return self._fallback(f"Both structured and raw parsing failed: {e}")

    @staticmethod
    def _fallback(reason: str) -> TriageVerdict:
        return TriageVerdict(
            verdict="needs_review",
            confidence=0.0,
            reasoning=reason,
        )

    def _log_usage(self, completion) -> None:
        if hasattr(completion, "usage") and completion.usage:
            total = completion.usage.total_tokens
            prompt = completion.usage.prompt_tokens
            output = completion.usage.completion_tokens
            logger.info("Token usage: %d prompt + %d completion = %d total", prompt, output, total)
            prompt_details = getattr(completion.usage, "prompt_tokens_details", None)
            if prompt_details:
                cached = getattr(prompt_details, "cached_tokens", 0) or 0
                if cached and prompt:
                    logger.info("Prompt cache: %d/%d tokens (%.0f%%)", cached, prompt, cached / prompt * 100)

    @staticmethod
    def _parse_raw_json(raw: str) -> TriageVerdict:
        data = None

        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            pass

        if data is None:
            depth = 0
            start_idx = None
            for i, ch in enumerate(raw):
                if ch == '{':
                    if depth == 0:
                        start_idx = i
                    depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0 and start_idx is not None:
                        try:
                            data = json.loads(raw[start_idx:i + 1])
                            break
                        except json.JSONDecodeError:
                            start_idx = None

        if data is None:
            verdict_match = re.search(r'"verdict"\s*:\s*"(true_positive|false_positive|needs_review)"', raw)
            reasoning_match = re.search(r'"reasoning"\s*:\s*"([^"]*)"', raw)
            confidence_match = re.search(r'"confidence"\s*:\s*([\d.]+)', raw)

            return TriageVerdict(
                verdict=verdict_match.group(1) if verdict_match else "needs_review",
                confidence=float(confidence_match.group(1)) if confidence_match else 0.5,
                reasoning=reasoning_match.group(1) if reasoning_match else f"Could not parse LLM response",
                key_evidence=[],
            )

        if not isinstance(data, dict):
            return TriageVerdict(verdict="needs_review", confidence=0.0, reasoning="LLM returned non-object JSON")

        verdict_val = data.get("verdict", "needs_review")
        valid_verdicts = {"true_positive", "false_positive", "needs_review"}
        if verdict_val not in valid_verdicts:
            verdict_val = "needs_review"

        confidence_val = data.get("confidence", 0.5)
        if not isinstance(confidence_val, (int, float)):
            confidence_val = 0.5
        confidence_val = max(0.0, min(1.0, float(confidence_val)))

        evidence = data.get("key_evidence", [])
        if not isinstance(evidence, list):
            evidence = [str(evidence)]

        return TriageVerdict(
            verdict=verdict_val,
            confidence=confidence_val,
            reasoning=str(data.get("reasoning", "")),
            key_evidence=evidence,
            suggested_fix=data.get("suggested_fix"),
        )
