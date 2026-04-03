from __future__ import annotations

from typing import TYPE_CHECKING

from textual.message import Message

if TYPE_CHECKING:
    from sast_triage.models import AssembledContext, SemgrepFinding, TriageVerdict
    from sast_triage.pipeline import TriageResult


class AuditProgress(Message):
    """Posted by orchestrator to update the ThinkingLog."""

    def __init__(self, icon: str, step: str, detail: str = "") -> None:
        super().__init__()
        self.icon = icon
        self.step = step
        self.detail = detail


class SidebarUpdate(Message):
    """Posted to update sidebar trace/context info."""

    def __init__(self, section: str, content: str) -> None:
        super().__init__()
        self.section = section
        self.content = content


class VerdictReady(Message):
    """Posted when a single finding audit completes."""

    def __init__(self, result: TriageResult) -> None:
        super().__init__()
        self.result = result


class AuditQueueUpdate(Message):
    """Posted to update the queue progress in sidebar."""

    def __init__(self, current: int, total: int, label: str) -> None:
        super().__init__()
        self.current = current
        self.total = total
        self.label = label


class PermissionRequired(Message):
    """Posted when file read needs user approval (outside workspace)."""

    def __init__(self, path: str) -> None:
        super().__init__()
        self.path = path


class FindingsLoaded(Message):
    """Posted when a Semgrep JSON file is parsed and loaded."""

    def __init__(self, actionable_count: int, filtered_count: int) -> None:
        super().__init__()
        self.actionable_count = actionable_count
        self.filtered_count = filtered_count
