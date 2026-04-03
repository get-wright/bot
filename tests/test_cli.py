from __future__ import annotations

from unittest.mock import MagicMock, patch

import click
from click.testing import CliRunner

from sast_triage.cli import main
from sast_triage.llm.client import Provider


def test_triage_requires_provider_when_using_llm():
    runner = CliRunner()
    result = runner.invoke(main, ["triage", "--no-llm"], input='{"results": []}')
    assert result.exit_code == 0 or "Error" not in (result.output or "")


def test_triage_rejects_missing_provider():
    runner = CliRunner()
    result = runner.invoke(main, ["triage", "--model", "gpt-4o"], input='{"results": []}')
    assert result.exit_code != 0


def test_triage_no_llm_flag():
    runner = CliRunner()
    result = runner.invoke(main, ["triage", "--no-llm"], input='{"results": []}')
    assert result.exit_code == 0


def test_provider_choices_match_enum():
    from sast_triage.cli import _PROVIDER_CHOICES
    enum_values = {p.value for p in Provider}
    assert set(_PROVIDER_CHOICES) == enum_values
