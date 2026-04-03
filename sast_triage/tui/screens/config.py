from __future__ import annotations

from pathlib import Path

from textual.app import ComposeResult
from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Button, Footer, Header, Input, Label, Select, Static

from sast_triage.llm.client import Provider
from sast_triage.tui.config import ProjectConfig

_PROVIDER_OPTIONS = [
    ("OpenAI (chat) — gpt-4o", Provider.OPENAI.value),
    ("OpenAI (reasoning) — o3-mini, o4-mini", Provider.OPENAI_REASONING.value),
    ("Anthropic — claude via compat endpoint", Provider.ANTHROPIC.value),
    ("OpenAI-compatible — OpenRouter/Ollama", Provider.OPENAI_COMPATIBLE.value),
]


class ConfigScreen(Screen):
    BINDINGS = [
        ("escape", "back", "Back"),
    ]

    def __init__(self, workspace: Path) -> None:
        super().__init__()
        self._workspace = workspace
        self._config = ProjectConfig(workspace=workspace)

    def compose(self) -> ComposeResult:
        yield Header()
        with Vertical(id="config-container"):
            yield Static("Provider Configuration", classes="config-section-title")
            yield Static("")

            # Detected providers
            detected = self._config.detected_providers()
            for pname in ("openai", "openai-reasoning", "anthropic", "openai-compatible"):
                if pname in detected or pname.split("-")[0] in [d.split("-")[0] for d in detected]:
                    yield Static(f"  \u25cf {pname}", classes="config-status-ok")
                else:
                    yield Static(f"  \u25cb {pname} (no API key)", classes="config-status-missing")
            yield Static("")

            yield Label("Provider", classes="config-label")
            yield Select(
                _PROVIDER_OPTIONS,
                value=self._config.provider_name,
                id="provider-select",
            )

            yield Label("Model", classes="config-label")
            yield Input(
                value=self._config.model,
                placeholder="e.g., o3-mini, gpt-4o, qwen/qwq-32b",
                id="model-input",
            )

            yield Label("Base URL (optional)", classes="config-label")
            yield Input(
                value=self._config.base_url or "",
                placeholder="https://openrouter.ai/api/v1",
                id="base-url-input",
            )

            yield Label("API Key (optional — overrides env var)", classes="config-label")
            yield Input(
                value="",
                placeholder="Leave empty to use environment variable",
                password=True,
                id="api-key-input",
            )

            yield Label("Reasoning Effort", classes="config-label")
            yield Select(
                [("Low", "low"), ("Medium", "medium"), ("High", "high")],
                value=self._config.reasoning_effort,
                id="effort-select",
            )

            yield Static("")
            yield Button("Connect", variant="primary", id="connect-btn")

        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "connect-btn":
            self._apply_config()

    def _apply_config(self) -> None:
        provider_select = self.query_one("#provider-select", Select)
        model_input = self.query_one("#model-input", Input)
        base_url_input = self.query_one("#base-url-input", Input)
        api_key_input = self.query_one("#api-key-input", Input)
        effort_select = self.query_one("#effort-select", Select)

        self._config.provider_name = str(provider_select.value)
        self._config.model = model_input.value.strip()
        self._config.base_url = base_url_input.value.strip() or None
        self._config.reasoning_effort = str(effort_select.value)

        if api_key_input.value.strip():
            self._config.api_key = api_key_input.value.strip()
            self.notify(
                "API key will be stored in plaintext in .sast-triage.toml",
                title="Security notice",
                severity="warning",
                timeout=8,
            )

        self._config.save()

        # Store config on app for other screens to access
        self.app.project_config = self._config

        from sast_triage.tui.screens.main import MainScreen
        self.app.switch_screen(MainScreen(workspace=self._workspace, config=self._config))

    def action_back(self) -> None:
        from sast_triage.tui.screens.trust import TrustScreen
        self.app.switch_screen(TrustScreen(workspace=self._workspace))
