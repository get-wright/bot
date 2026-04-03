from __future__ import annotations

import os
from pathlib import Path

from sast_triage.tui.config import ProjectConfig


class TestProjectConfig:
    def test_defaults_when_no_file(self, tmp_path):
        cfg = ProjectConfig(workspace=tmp_path)
        assert cfg.provider_name == "openai-reasoning"
        assert cfg.model == "o3-mini"
        assert cfg.reasoning_effort == "medium"
        assert cfg.base_url is None
        assert cfg.api_key is None
        assert cfg.memory_db_path == str(tmp_path / "triage.db")
        assert cfg.allowed_paths == []

    def test_loads_from_toml(self, tmp_path):
        toml_path = tmp_path / ".sast-triage.toml"
        toml_path.write_text(
            '[provider]\n'
            'name = "openai"\n'
            'model = "gpt-4o"\n'
            'reasoning_effort = "high"\n'
            'base_url = "https://example.com/v1"\n\n'
            '[provider.api_keys]\n'
            'openai = "sk-test-123"\n\n'
            '[memory]\n'
            'db_path = "./custom.db"\n\n'
            '[workspace]\n'
            'allowed_paths = ["/shared/libs/"]\n'
        )
        cfg = ProjectConfig(workspace=tmp_path)
        assert cfg.provider_name == "openai"
        assert cfg.model == "gpt-4o"
        assert cfg.reasoning_effort == "high"
        assert cfg.base_url == "https://example.com/v1"
        assert cfg.api_key == "sk-test-123"
        assert cfg.memory_db_path == str(tmp_path / "custom.db")
        assert cfg.allowed_paths == ["/shared/libs/"]

    def test_env_var_detection(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "sk-env-key")
        cfg = ProjectConfig(workspace=tmp_path)
        assert cfg.api_key == "sk-env-key"

    def test_toml_overrides_env(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "sk-env-key")
        toml_path = tmp_path / ".sast-triage.toml"
        toml_path.write_text(
            '[provider]\nname = "openai"\n\n'
            '[provider.api_keys]\nopenai = "sk-toml-key"\n'
        )
        cfg = ProjectConfig(workspace=tmp_path)
        assert cfg.api_key == "sk-toml-key"

    def test_save_creates_toml(self, tmp_path):
        cfg = ProjectConfig(workspace=tmp_path)
        cfg.provider_name = "openai-compatible"
        cfg.model = "qwen/qwq-32b"
        cfg.base_url = "https://openrouter.ai/api/v1"
        cfg.save()

        toml_path = tmp_path / ".sast-triage.toml"
        assert toml_path.exists()
        content = toml_path.read_text()
        assert 'name = "openai-compatible"' in content
        assert 'model = "qwen/qwq-32b"' in content

    def test_detected_providers(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        cfg = ProjectConfig(workspace=tmp_path)
        detected = cfg.detected_providers()
        assert "openai" in detected
        assert "anthropic" not in detected

    def test_add_allowed_path(self, tmp_path):
        cfg = ProjectConfig(workspace=tmp_path)
        cfg.add_allowed_path("/external/repo/")
        assert "/external/repo/" in cfg.allowed_paths

    def test_is_path_allowed_inside_workspace(self, tmp_path):
        cfg = ProjectConfig(workspace=tmp_path)
        assert cfg.is_path_allowed(str(tmp_path / "src" / "app.py")) is True

    def test_is_path_allowed_outside_workspace(self, tmp_path):
        cfg = ProjectConfig(workspace=tmp_path)
        assert cfg.is_path_allowed("/other/repo/file.py") is False

    def test_is_path_allowed_after_adding(self, tmp_path):
        cfg = ProjectConfig(workspace=tmp_path)
        cfg.add_allowed_path("/other/repo/")
        assert cfg.is_path_allowed("/other/repo/file.py") is True
