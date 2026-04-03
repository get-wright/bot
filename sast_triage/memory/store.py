from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sast_triage.models import SemgrepFinding, TriageRecord


class MemoryStore:
    DEFAULT_DB_PATH = ".sast_triage/memory.db"

    def __init__(self, db_path: str | None = None):
        self.db_path = Path(db_path or self.DEFAULT_DB_PATH)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path))
        self._conn.row_factory = sqlite3.Row
        self._create_tables()

    def _create_tables(self):
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS triage_records (
                fingerprint TEXT PRIMARY KEY,
                check_id TEXT NOT NULL,
                path TEXT NOT NULL,
                verdict TEXT NOT NULL,
                confidence REAL NOT NULL,
                reasoning TEXT NOT NULL,
                feedback TEXT,
                starred INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        self._conn.commit()
        self._migrate_starred()

    def _migrate_starred(self):
        columns = {row[1] for row in self._conn.execute("PRAGMA table_info(triage_records)").fetchall()}
        if "starred" not in columns:
            self._conn.execute("ALTER TABLE triage_records ADD COLUMN starred INTEGER NOT NULL DEFAULT 0")
            self._conn.commit()

    def lookup(self, fingerprint: str) -> TriageRecord | None:
        from sast_triage.models import TriageRecord
        row = self._conn.execute(
            "SELECT * FROM triage_records WHERE fingerprint = ?", (fingerprint,)
        ).fetchone()
        if not row:
            return None
        data = dict(row)
        data["starred"] = bool(data.get("starred", 0))
        return TriageRecord(**data)

    def lookup_by_rule(self, check_id: str, limit: int = 10) -> list[TriageRecord]:
        from sast_triage.models import TriageRecord
        rows = self._conn.execute(
            "SELECT * FROM triage_records WHERE check_id = ? ORDER BY updated_at DESC LIMIT ?",
            (check_id, limit),
        ).fetchall()
        records = []
        for r in rows:
            data = dict(r)
            data["starred"] = bool(data.get("starred", 0))
            records.append(TriageRecord(**data))
        return records

    def store(self, record: TriageRecord) -> None:
        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute(
            """INSERT INTO triage_records (fingerprint, check_id, path, verdict, confidence, reasoning, feedback, starred, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(fingerprint) DO UPDATE SET
                verdict = excluded.verdict,
                confidence = excluded.confidence,
                reasoning = excluded.reasoning,
                updated_at = excluded.updated_at""",
            (record.fingerprint, record.check_id, record.path, record.verdict,
             record.confidence, record.reasoning, record.feedback,
             int(record.starred), record.created_at or now, now),
        )
        self._conn.commit()

    def set_starred(self, fingerprint: str, starred: bool) -> bool:
        now = datetime.now(timezone.utc).isoformat()
        cursor = self._conn.execute(
            "UPDATE triage_records SET starred = ?, updated_at = ? WHERE fingerprint = ?",
            (int(starred), now, fingerprint),
        )
        self._conn.commit()
        return cursor.rowcount > 0

    def list_all(self, starred_only: bool = False) -> list[TriageRecord]:
        from sast_triage.models import TriageRecord
        if starred_only:
            rows = self._conn.execute(
                "SELECT * FROM triage_records WHERE starred = 1 ORDER BY updated_at DESC"
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM triage_records ORDER BY updated_at DESC"
            ).fetchall()
        records = []
        for r in rows:
            data = dict(r)
            data["starred"] = bool(data.get("starred", 0))
            records.append(TriageRecord(**data))
        return records

    def add_feedback(self, fingerprint: str, feedback: str) -> bool:
        now = datetime.now(timezone.utc).isoformat()
        cursor = self._conn.execute(
            "UPDATE triage_records SET feedback = ?, updated_at = ? WHERE fingerprint = ?",
            (feedback, now, fingerprint),
        )
        self._conn.commit()
        return cursor.rowcount > 0

    def get_hints(self, check_id: str, fingerprint: str) -> list[str]:
        hints = []
        exact = self.lookup(fingerprint)
        if exact:
            hints.append(
                f"Previously triaged as {exact.verdict} with {exact.confidence:.0%} confidence: {exact.reasoning[:100]}"
            )
        records = self.lookup_by_rule(check_id, limit=50)
        if len(records) >= 2:
            tp_count = sum(1 for r in records if r.verdict == "true_positive")
            total = len(records)
            hints.append(
                f"{total} previous findings for rule {check_id}: {tp_count}/{total} true positives ({tp_count/total:.0%})"
            )
        return hints

    def close(self):
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
