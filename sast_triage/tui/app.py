from __future__ import annotations

from pathlib import Path

from textual.app import App

from sast_triage.tui.screens.trust import TrustScreen


class SastTriageApp(App):
    """Interactive TUI for sast-triage."""

    TITLE = "sast-triage"
    CSS_PATH = "tui.tcss"
    BINDINGS = [("ctrl+q", "quit", "Quit")]

    def __init__(self, workspace: Path | None = None) -> None:
        super().__init__()
        self._workspace = Path(workspace or Path.cwd()).resolve()
        self.project_config = None

    def on_mount(self) -> None:
        self.push_screen(TrustScreen(workspace=self._workspace))
