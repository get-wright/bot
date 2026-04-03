from __future__ import annotations

from typing import TYPE_CHECKING

from textual.widgets import DataTable

if TYPE_CHECKING:
    from sast_triage.models import SemgrepFinding


class FindingsTable(DataTable):
    """DataTable with row-level cursor and manual multi-selection."""

    def __init__(self, **kwargs) -> None:
        super().__init__(cursor_type="row", zebra_stripes=True, **kwargs)
        self._findings: list[SemgrepFinding] = []
        self._selected_indices: set[int] = set()
        self._classifications: dict[str, str] = {}

    @property
    def selected_findings(self) -> list[SemgrepFinding]:
        return [self._findings[i] for i in sorted(self._selected_indices)]

    @property
    def findings(self) -> list[SemgrepFinding]:
        return list(self._findings)

    def load_findings(
        self,
        findings: list[SemgrepFinding],
        classifications: dict[str, str],
    ) -> None:
        self._findings = list(findings)
        self._classifications = classifications
        self._selected_indices.clear()
        self.clear()

        if not self.columns:
            self.add_columns("", "SEV", "Rule ID", "Path", "Type")

        for i, f in enumerate(findings):
            sev = f.extra.severity.upper()
            if len(sev) > 4:
                sev = sev[:4]
            rule_short = f.check_id.rsplit(".", 1)[-1] if "." in f.check_id else f.check_id
            path_line = f"{f.path}:{f.start.line}"
            cls = classifications.get(f.check_id, "patt")
            if cls == "pattern":
                cls = "patt"
            self.add_row(" ", sev, rule_short, path_line, cls, key=str(i))

    def toggle_row(self, index: int) -> None:
        if index < 0 or index >= len(self._findings):
            return
        if index in self._selected_indices:
            self._selected_indices.discard(index)
            self.update_cell_at((index, 0), " ")
        else:
            self._selected_indices.add(index)
            self.update_cell_at((index, 0), "●")

    def select_all(self) -> None:
        for i in range(len(self._findings)):
            self._selected_indices.add(i)
            self.update_cell_at((i, 0), "●")

    def clear_selection(self) -> None:
        for i in self._selected_indices:
            self.update_cell_at((i, 0), " ")
        self._selected_indices.clear()

    def finding_at(self, index: int) -> SemgrepFinding | None:
        if 0 <= index < len(self._findings):
            return self._findings[index]
        return None
