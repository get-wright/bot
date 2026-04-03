from __future__ import annotations

from textual.containers import VerticalScroll
from textual.widgets import Static


class SessionSidebar(VerticalScroll):
    """Right-docked sidebar showing session context."""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._sections: dict[str, Static] = {}

    def compose(self):
        sections = [
            "SESSION", "MEMORY",
            "SELECTED", "QUEUE", "FINISHED",
        ]
        for name in sections:
            title = Static(name, classes="sidebar-section-title")
            value = Static("", classes="sidebar-value")
            self._sections[name] = value
            yield title
            yield value

    def update_section(self, name: str, content: str) -> None:
        if name in self._sections:
            self._sections[name].update(content)

    def clear_section(self, name: str) -> None:
        if name in self._sections:
            self._sections[name].update("")

    def set_session_info(self, provider: str, model: str, effort: str = "") -> None:
        lines = f"● {provider}\n  {model}"
        if effort:
            lines += f"\n  {effort} effort"
        self.update_section("SESSION", lines)

    def set_memory_info(self, db_path: str, count: int) -> None:
        self.update_section("MEMORY", f"  {db_path}\n  {count} stored verdicts")

    def set_selected(self, rules: list[str]) -> None:
        if not rules:
            self.update_section("SELECTED", "  none")
            return
        lines = f"  {len(rules)} findings\n" + "\n".join(f"  {r}" for r in rules[:8])
        if len(rules) > 8:
            lines += f"\n  ... +{len(rules) - 8} more"
        self.update_section("SELECTED", lines)

    def set_queue(self, items: list[tuple[int, str, str]]) -> None:
        """items: list of (index, label, status) e.g. (1, 'rule-xss', '✓ FP 81%')"""
        lines = []
        for idx, label, status in items:
            # Truncate label to fit sidebar (max ~18 chars)
            short = label[:18] + "…" if len(label) > 18 else label
            if status:
                lines.append(f" {status} {idx}.{short}")
            else:
                lines.append(f"   {idx}.{short}")
        self.update_section("QUEUE", "\n".join(lines))

    def set_finished(self, results: list[tuple[int, str, str]]) -> None:
        """results: list of (index, label, verdict_status) for completed findings."""
        if not results:
            self.update_section("FINISHED", "  none yet")
            return
        lines = [f"  {len(results)} completed"]
        for idx, label, status in results:
            short = label[:18] + "…" if len(label) > 18 else label
            lines.append(f" {status} {idx}.{short}")
        self.update_section("FINISHED", "\n".join(lines))
