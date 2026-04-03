from __future__ import annotations

from unittest.mock import MagicMock, patch

import openai
import pytest

from sast_triage.llm.client import TriageLLMClient
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
def test_developer_role_for_o_models(mock_openai_cls):
    verdict = _make_verdict()
    completion = _make_mock_completion(verdict)
    mock_client = MagicMock()
    mock_client.chat.completions.parse.return_value = completion
    mock_openai_cls.return_value = mock_client

    client = TriageLLMClient(model="o3-mini", api_key="test-key")
    client.triage(_make_context())

    call_kwargs = mock_client.chat.completions.parse.call_args[1]
    messages = call_kwargs["messages"]
    assert messages[0]["role"] == "developer"


@patch("sast_triage.llm.client.OpenAI")
def test_system_role_for_gpt_models(mock_openai_cls):
    verdict = _make_verdict()
    completion = _make_mock_completion(verdict)
    mock_client = MagicMock()
    mock_client.chat.completions.parse.return_value = completion
    mock_openai_cls.return_value = mock_client

    client = TriageLLMClient(model="gpt-4o-mini", api_key="test-key")
    client.triage(_make_context())

    call_kwargs = mock_client.chat.completions.parse.call_args[1]
    messages = call_kwargs["messages"]
    assert messages[0]["role"] == "system"


@patch("sast_triage.llm.client.OpenAI")
def test_reasoning_effort_only_for_o_models(mock_openai_cls):
    verdict = _make_verdict()
    completion = _make_mock_completion(verdict)
    mock_client = MagicMock()
    mock_client.chat.completions.parse.return_value = completion
    mock_openai_cls.return_value = mock_client

    o_client = TriageLLMClient(model="o3-mini", api_key="test-key")
    o_client.triage(_make_context())
    o_kwargs = mock_client.chat.completions.parse.call_args[1]
    assert "reasoning_effort" in o_kwargs

    mock_client.chat.completions.parse.reset_mock()
    mock_client.chat.completions.parse.return_value = completion

    gpt_client = TriageLLMClient(model="gpt-4o", api_key="test-key")
    gpt_client.triage(_make_context())
    gpt_kwargs = mock_client.chat.completions.parse.call_args[1]
    assert "reasoning_effort" not in gpt_kwargs


@patch("sast_triage.llm.client.OpenAI")
def test_api_error_propagates(mock_openai_cls):
    mock_client = MagicMock()
    api_err = openai.APIError(
        message="API error", request=MagicMock(), body=None
    )
    mock_client.chat.completions.parse.side_effect = api_err
    mock_client.chat.completions.create.side_effect = api_err
    mock_openai_cls.return_value = mock_client

    client = TriageLLMClient(api_key="test-key")
    with pytest.raises(openai.APIError):
        client.triage(_make_context())
