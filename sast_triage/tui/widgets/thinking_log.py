from __future__ import annotations

from rich.text import Text
from textual.widgets import RichLog


class ThinkingLog(RichLog):
    """Scrollable log showing audit steps in real-time."""

    def __init__(self, **kwargs) -> None:
        super().__init__(highlight=True, markup=True, **kwargs)

    def log_step(self, icon: str, message: str, detail: str = "") -> None:
        self.write(Text.from_markup(f"  {icon} [bold]{message}[/bold]"))
        if detail:
            for line in detail.strip().split("\n"):
                self.write(Text.from_markup(f"    [dim]{line}[/dim]"))
        self.write("")
