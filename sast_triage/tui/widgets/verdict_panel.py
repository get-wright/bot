from __future__ import annotations

from typing import TYPE_CHECKING

from textual.containers import VerticalScroll
from textual.widgets import Static

if TYPE_CHECKING:
    from sast_triage.models import TriageVerdict

_VERDICT_LABELS = {
    "true_positive": "TRUE POSITIVE",
    "false_positive": "FALSE POSITIVE",
    "needs_review": "NEEDS REVIEW",
}

_VERDICT_CLASSES = {
    "true_positive": "verdict-tp",
    "false_positive": "verdict-fp",
    "needs_review": "verdict-nr",
}


class VerdictPanel(VerticalScroll):
    """Displays verdict banner + reasoning + evidence."""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._banner = Static("", id="verdict-banner")
        self._details = Static("", id="verdict-reasoning")

    def compose(self):
        yield self._banner
        yield self._details

    def show_verdict(self, verdict: TriageVerdict) -> None:
        banner_text, details_text = self.format_verdict(verdict)
        self._banner.update(banner_text)
        self._banner.remove_class("verdict-tp", "verdict-fp", "verdict-nr")
        self._banner.add_class(_VERDICT_CLASSES.get(verdict.verdict, "verdict-nr"))
        self._details.update(details_text)

    def clear_verdict(self) -> None:
        self._banner.update("")
        self._banner.remove_class("verdict-tp", "verdict-fp", "verdict-nr")
        self._details.update("")

    @staticmethod
    def format_verdict(verdict: TriageVerdict) -> tuple[str, str]:
        label = _VERDICT_LABELS.get(verdict.verdict, verdict.verdict.upper())
        confidence_pct = f"{verdict.confidence:.0%}"
        banner = f"  {label}    {confidence_pct}"

        parts = []
        if verdict.reasoning and verdict.reasoning.strip():
            parts.append("Reasoning")
            parts.append(verdict.reasoning.strip())
            parts.append("")

        if verdict.key_evidence:
            parts.append("Key Evidence")
            for ev in verdict.key_evidence:
                parts.append(f"  • {ev}")
            parts.append("")

        if verdict.suggested_fix:
            parts.append("Suggested Fix")
            parts.append(verdict.suggested_fix)

        if not parts:
            parts.append("No reasoning provided by model.")

        details = "\n".join(parts)
        return banner, details
