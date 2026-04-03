from __future__ import annotations

from unittest.mock import MagicMock, patch

import openai
import pytest

from sast_triage.llm.client import Provider, TriageLLMClient
from sast_triage.models import AssembledContext, CodeContext, TriageVerdict


def _make_context():
    return AssembledContext(
        finding_summary="Test finding",
        rule_id="test.rule",
        vulnerability_class="xss",
        severity="ERROR",
        file_path="app.py",
        code_context=CodeContext(),
    )


def _make_verdict():
    return TriageVerdict(
        verdict="true_positive",
        confidence=0.95,
        reasoning="Test reasoning",
        key_evidence=["evidence1"],
    )


def _make_mock_completion(verdict: TriageVerdict, refusal: str | None = None):
    message = MagicMock()
    message.parsed = verdict
    message.refusal = refusal
    choice = MagicMock()
    choice.message = message
    completion = MagicMock()
    completion.choices = [choice]
    completion.usage = None
    return completion


@patch("sast_triage.llm.client.OpenAI")
def test_triage_success(mock_openai_cls):
    verdict = _make_verdict()
    completion = _make_mock_completion(verdict)
    mock_client = MagicMock()
    mock_client.chat.completions.parse.return_value = completion
    mock_openai_cls.return_value = mock_client

    client = TriageLLMClient(api_key="test-key")
    result = client.triage(_make_context())

    assert result is verdict
    mock_client.chat.completions.parse.assert_called_once()


@patch("sast_triage.llm.client.OpenAI")
def test_triage_refusal(mock_openai_cls):
    verdict = _make_verdict()
    completion = _make_mock_completion(verdict, refusal="I cannot help with that.")
    mock_client = MagicMock()
    mock_client.chat.completions.parse.return_value = completion
    mock_openai_cls.return_value = mock_client

    client = TriageLLMClient(api_key="test-key")
    result = client.triage(_make_context())

    assert result.verdict == "needs_review"
    assert result.confidence == 0.0
    assert "I cannot help with that." in result.reasoning


@patch("sast_triage.llm.client.OpenAI")
def test_developer_role_for_reasoning_provider(mock_openai_cls):
    verdict = _make_verdict()
    completion = _make_mock_completion(verdict)
    mock_client = MagicMock()
    mock_client.chat.completions.parse.return_value = completion
    mock_openai_cls.return_value = mock_client

    client = TriageLLMClient(
        model="o3-mini", provider=Provider.OPENAI_REASONING, api_key="test-key",
    )
    client.triage(_make_context())

    call_kwargs = mock_client.chat.completions.parse.call_args[1]
    messages = call_kwargs["messages"]
    assert messages[0]["role"] == "developer"


@patch("sast_triage.llm.client.OpenAI")
def test_system_role_for_openai_provider(mock_openai_cls):
    verdict = _make_verdict()
    completion = _make_mock_completion(verdict)
    mock_client = MagicMock()
    mock_client.chat.completions.parse.return_value = completion
    mock_openai_cls.return_value = mock_client

    client = TriageLLMClient(
        model="gpt-4o-mini", provider=Provider.OPENAI, api_key="test-key",
    )
    client.triage(_make_context())

    call_kwargs = mock_client.chat.completions.parse.call_args[1]
    messages = call_kwargs["messages"]
    assert messages[0]["role"] == "system"


@patch("sast_triage.llm.client.OpenAI")
def test_system_role_for_anthropic_provider(mock_openai_cls):
    verdict = _make_verdict()
    completion = _make_mock_completion(verdict)
    mock_client = MagicMock()
    mock_client.chat.completions.parse.return_value = completion
    mock_openai_cls.return_value = mock_client

    client = TriageLLMClient(
        model="claude-sonnet-4-5", provider=Provider.ANTHROPIC, api_key="test-key",
    )
    client.triage(_make_context())

    call_kwargs = mock_client.chat.completions.parse.call_args[1]
    messages = call_kwargs["messages"]
    assert messages[0]["role"] == "system"
    assert "reasoning_effort" not in call_kwargs


@patch("sast_triage.llm.client.OpenAI")
def test_system_role_for_compatible_provider(mock_openai_cls):
    mock_client = MagicMock()
    raw_completion = MagicMock()
    raw_completion.choices = [MagicMock()]
    raw_completion.choices[0].message.content = (
        '{"verdict": "true_positive", "confidence": 0.9, "reasoning": "test"}'
    )
    raw_completion.usage = None
    mock_client.chat.completions.create.return_value = raw_completion
    mock_openai_cls.return_value = mock_client

    client = TriageLLMClient(
        model="llama3", provider=Provider.OPENAI_COMPATIBLE,
        api_key="test-key", base_url="http://localhost:11434/v1",
    )
    result = client.triage(_make_context())

    mock_client.chat.completions.parse.assert_not_called()
    mock_client.chat.completions.create.assert_called_once()
    call_kwargs = mock_client.chat.completions.create.call_args[1]
    messages = call_kwargs["messages"]
    assert messages[0]["role"] == "system"
    assert "reasoning_effort" not in call_kwargs
    assert result.verdict == "true_positive"


@patch("sast_triage.llm.client.OpenAI")
def test_reasoning_effort_only_for_reasoning_provider(mock_openai_cls):
    verdict = _make_verdict()
    completion = _make_mock_completion(verdict)
    mock_client = MagicMock()
    mock_client.chat.completions.parse.return_value = completion
    mock_openai_cls.return_value = mock_client

    reasoning_client = TriageLLMClient(
        model="o3-mini", provider=Provider.OPENAI_REASONING, api_key="test-key",
    )
    reasoning_client.triage(_make_context())
    reasoning_kwargs = mock_client.chat.completions.parse.call_args[1]
    assert "reasoning_effort" in reasoning_kwargs
    assert reasoning_kwargs["reasoning_effort"] == "medium"

    mock_client.chat.completions.parse.reset_mock()
    mock_client.chat.completions.parse.return_value = completion

    openai_client = TriageLLMClient(
        model="gpt-4o", provider=Provider.OPENAI, api_key="test-key",
    )
    openai_client.triage(_make_context())
    openai_kwargs = mock_client.chat.completions.parse.call_args[1]
    assert "reasoning_effort" not in openai_kwargs


@patch("sast_triage.llm.client.OpenAI")
def test_model_starting_with_o_not_auto_detected(mock_openai_cls):
    mock_client = MagicMock()
    raw_completion = MagicMock()
    raw_completion.choices = [MagicMock()]
    raw_completion.choices[0].message.content = (
        '{"verdict": "false_positive", "confidence": 0.8, "reasoning": "safe"}'
    )
    raw_completion.usage = None
    mock_client.chat.completions.create.return_value = raw_completion
    mock_openai_cls.return_value = mock_client

    client = TriageLLMClient(
        model="ollama/llama3",
        provider=Provider.OPENAI_COMPATIBLE,
        api_key="test-key",
        base_url="http://localhost:11434/v1",
    )
    client.triage(_make_context())

    call_kwargs = mock_client.chat.completions.create.call_args[1]
    messages = call_kwargs["messages"]
    assert messages[0]["role"] == "system"
    assert "reasoning_effort" not in call_kwargs


@patch("sast_triage.llm.client.OpenAI")
def test_api_error_propagates(mock_openai_cls):
    mock_client = MagicMock()
    api_err = openai.APIError(
        message="API error", request=MagicMock(), body=None
    )
    mock_client.chat.completions.parse.side_effect = api_err
    mock_client.chat.completions.create.side_effect = api_err
    mock_openai_cls.return_value = mock_client

    client = TriageLLMClient(
        model="o3-mini", provider=Provider.OPENAI_REASONING, api_key="test-key",
    )
    with pytest.raises(openai.APIError):
        client.triage(_make_context())


@patch("sast_triage.llm.client.OpenAI")
def test_anthropic_no_default_base_url(mock_openai_cls):
    mock_openai_cls.return_value = MagicMock()

    TriageLLMClient(
        model="claude-sonnet-4-5", provider=Provider.ANTHROPIC, api_key="test-key",
    )

    call_kwargs = mock_openai_cls.call_args[1]
    assert "base_url" not in call_kwargs


@patch("sast_triage.llm.client.OpenAI")
def test_explicit_base_url_overrides_default(mock_openai_cls):
    mock_openai_cls.return_value = MagicMock()

    TriageLLMClient(
        model="claude-sonnet-4-5",
        provider=Provider.ANTHROPIC,
        api_key="test-key",
        base_url="https://custom-proxy.example.com/v1",
    )

    call_kwargs = mock_openai_cls.call_args[1]
    assert call_kwargs["base_url"] == "https://custom-proxy.example.com/v1"


def test_provider_enum_validation():
    with pytest.raises(ValueError):
        Provider("invalid-provider")


def test_provider_property():
    with patch("sast_triage.llm.client.OpenAI"):
        client = TriageLLMClient(
            model="gpt-4o", provider=Provider.OPENAI, api_key="test-key",
        )
        assert client.provider == Provider.OPENAI

        reasoning_client = TriageLLMClient(
            model="o3-mini", provider=Provider.OPENAI_REASONING, api_key="test-key",
        )
        assert reasoning_client.provider == Provider.OPENAI_REASONING


def test_provider_accepts_string():
    with patch("sast_triage.llm.client.OpenAI"):
        client = TriageLLMClient(
            model="gpt-4o", provider="openai", api_key="test-key",
        )
        assert client.provider == Provider.OPENAI
