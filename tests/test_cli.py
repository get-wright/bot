from __future__ import annotations

from sast_triage.cli import _infer_provider
from sast_triage.llm.client import Provider


def test_infer_provider_reasoning_model():
    assert _infer_provider("o3-mini", None) == Provider.OPENAI_REASONING
    assert _infer_provider("o1", None) == Provider.OPENAI_REASONING
    assert _infer_provider("o4-mini", None) == Provider.OPENAI_REASONING


def test_infer_provider_gpt_model():
    assert _infer_provider("gpt-4o", None) == Provider.OPENAI
    assert _infer_provider("gpt-4o-mini", None) == Provider.OPENAI
    assert _infer_provider("gpt-3.5-turbo", None) == Provider.OPENAI


def test_infer_provider_claude_model():
    assert _infer_provider("claude-3-haiku", None) == Provider.ANTHROPIC
    assert _infer_provider("claude-sonnet-4-5", None) == Provider.ANTHROPIC


def test_infer_provider_with_base_url():
    assert _infer_provider("any-model", "http://localhost:11434/v1") == Provider.OPENAI_COMPATIBLE
    assert _infer_provider("o3-mini", "https://openrouter.ai/api/v1") == Provider.OPENAI_COMPATIBLE
    assert _infer_provider("claude-3-haiku", "https://custom-proxy.com/v1") == Provider.OPENAI_COMPATIBLE


def test_infer_provider_unknown_model():
    assert _infer_provider("llama3", None) == Provider.OPENAI
    assert _infer_provider("mixtral-8x7b", None) == Provider.OPENAI
    assert _infer_provider("qwen-2.5-coder", None) == Provider.OPENAI
