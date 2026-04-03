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
            "SESSION", "MEMORY", "FINDINGS",
            "SELECTED", "FINDING", "TRACE", "QUEUE",
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

    def set_findings_info(self, source: str, actionable: int, filtered: int) -> None:
        self.update_section(
            "FINDINGS",
            f"  {source}\n  {actionable} actionable\n  {filtered} filtered",
        )

    def set_selected(self, rules: list[str]) -> None:
        if not rules:
            self.update_section("SELECTED", "  none")
            return
        lines = f"  {len(rules)} findings\n" + "\n".join(f"  {r}" for r in rules[:8])
        if len(rules) > 8:
            lines += f"\n  ... +{len(rules) - 8} more"
        self.update_section("SELECTED", lines)

    def set_finding_detail(
        self, rule_id: str, path: str, line: int, severity: str, classification: str
    ) -> None:
        self.update_section(
            "FINDING",
            f"  {rule_id}\n  {path}:{line}\n  {severity} · {classification}",
        )

    def set_trace_info(
        self,
        source_expr: str = "",
        source_loc: str = "",
        sink_expr: str = "",
        sink_loc: str = "",
        intermediate_count: int = 0,
    ) -> None:
        parts = []
        if source_expr:
            parts.append(f"  source:\n    {source_expr}\n    {source_loc}")
        if sink_expr:
            parts.append(f"  sink:\n    {sink_expr}\n    {sink_loc}")
        if intermediate_count:
            parts.append(f"  {intermediate_count} intermediate vars")
        self.update_section("TRACE", "\n".join(parts) if parts else "  no trace")

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
