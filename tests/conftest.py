"""Shared test fixtures for sast_triage tests."""

import json
from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES_DIR


@pytest.fixture
def taint_output(fixtures_dir: Path) -> dict:
    return json.loads((fixtures_dir / "semgrep_taint_output.json").read_text())


@pytest.fixture
def pattern_output(fixtures_dir: Path) -> dict:
    return json.loads((fixtures_dir / "semgrep_pattern_output.json").read_text())


@pytest.fixture
def mixed_output(fixtures_dir: Path) -> dict:
    return json.loads((fixtures_dir / "semgrep_mixed_output.json").read_text())


@pytest.fixture
def sample_py_source(fixtures_dir: Path) -> bytes:
    return (fixtures_dir / "sample_app.py").read_bytes()


@pytest.fixture
def sample_js_source(fixtures_dir: Path) -> bytes:
    return (fixtures_dir / "sample_app.js").read_bytes()


@pytest.fixture
def sample_ts_source(fixtures_dir: Path) -> bytes:
    return (fixtures_dir / "sample_app.ts").read_bytes()
