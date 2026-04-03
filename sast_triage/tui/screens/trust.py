from __future__ import annotations

from pathlib import Path

from textual.app import ComposeResult
from textual.containers import Center, Vertical
from textual.screen import Screen
from textual.widgets import Footer, Label, Static


class TrustScreen(Screen):
    BINDINGS = [
        ("y", "accept", "Yes — trust this folder"),
        ("n", "reject", "No — exit"),
    ]

    def __init__(self, workspace: Path) -> None:
        super().__init__()
        self._workspace = workspace

    def compose(self) -> ComposeResult:
        with Center():
            with Vertical(id="trust-container"):
                yield Static("sast-triage", classes="app-title")
                yield Static("")
                yield Static("Do you trust the files in this folder?")
                yield Static("")
                yield Label(str(self._workspace), id="trust-path")
        yield Footer()

    def action_accept(self) -> None:
        from sast_triage.tui.screens.config import ConfigScreen
        self.app.switch_screen(ConfigScreen(workspace=self._workspace))

    def action_reject(self) -> None:
        self.app.exit()
