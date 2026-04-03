from __future__ import annotations

import os
import tomllib
from pathlib import Path

_PROVIDER_ENV_KEYS = {
    "openai": ("OPENAI_API_KEY",),
    "openai-reasoning": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY",),
    "openai-compatible": ("OPENAI_API_KEY",),
}

_ALL_PROVIDER_NAMES = list(_PROVIDER_ENV_KEYS.keys())


class ProjectConfig:
    def __init__(self, workspace: Path) -> None:
        self.workspace = Path(workspace)
        self.provider_name: str = "openai-reasoning"
        self.model: str = "o3-mini"
        self.reasoning_effort: str = "medium"
        self.base_url: str | None = None
        self.memory_db_path: str = str(self.workspace / "triage.db")
        self.allowed_paths: list[str] = []
        self._toml_api_key: str | None = None

        self._load_toml()

    @property
    def toml_path(self) -> Path:
        return self.workspace / ".sast-triage.toml"

    @property
    def api_key(self) -> str | None:
        if self._toml_api_key:
            return self._toml_api_key
        return self._detect_env_key(self.provider_name)

    @api_key.setter
    def api_key(self, value: str | None) -> None:
        self._toml_api_key = value

    def _detect_env_key(self, provider: str) -> str | None:
        for env_var in _PROVIDER_ENV_KEYS.get(provider, ()):
            val = os.environ.get(env_var)
            if val:
                return val
        return None

    def _load_toml(self) -> None:
        if not self.toml_path.exists():
            return
        with open(self.toml_path, "rb") as f:
            data = tomllib.load(f)

        provider = data.get("provider", {})
        if "name" in provider:
            self.provider_name = provider["name"]
        if "model" in provider:
            self.model = provider["model"]
        if "reasoning_effort" in provider:
            self.reasoning_effort = provider["reasoning_effort"]
        if "base_url" in provider:
            self.base_url = provider["base_url"]

        api_keys = provider.get("api_keys", {})
        for pname in (self.provider_name, "openai", "anthropic"):
            if pname in api_keys:
                self._toml_api_key = api_keys[pname]
                break

        memory = data.get("memory", {})
        if "db_path" in memory:
            self.memory_db_path = str(self.workspace / memory["db_path"])

        workspace = data.get("workspace", {})
        self.allowed_paths = workspace.get("allowed_paths", [])

    def save(self) -> None:
        lines = []
        lines.append("[provider]")
        lines.append(f'name = "{self.provider_name}"')
        lines.append(f'model = "{self.model}"')
        lines.append(f'reasoning_effort = "{self.reasoning_effort}"')
        if self.base_url:
            lines.append(f'base_url = "{self.base_url}"')
        lines.append("")

        if self._toml_api_key:
            lines.append("[provider.api_keys]")
            key_name = self.provider_name.split("-")[0]
            lines.append(f'{key_name} = "{self._toml_api_key}"')
            lines.append("")

        rel_db = os.path.relpath(self.memory_db_path, self.workspace)
        lines.append("[memory]")
        lines.append(f'db_path = "./{rel_db}"')
        lines.append("")

        if self.allowed_paths:
            lines.append("[workspace]")
            paths_str = ", ".join(f'"{p}"' for p in self.allowed_paths)
            lines.append(f"allowed_paths = [{paths_str}]")
            lines.append("")

        self.toml_path.write_text("\n".join(lines) + "\n")

    def detected_providers(self) -> list[str]:
        result = []
        for name in _ALL_PROVIDER_NAMES:
            if self._detect_env_key(name):
                result.append(name)
        return result

    def add_allowed_path(self, path: str) -> None:
        if path not in self.allowed_paths:
            self.allowed_paths.append(path)

    def is_path_allowed(self, path: str) -> bool:
        try:
            Path(path).resolve().relative_to(self.workspace.resolve())
            return True
        except ValueError:
            pass
        return any(path.startswith(ap) for ap in self.allowed_paths)
