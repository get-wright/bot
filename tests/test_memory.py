import pytest
from sast_triage.memory.store import MemoryStore
from sast_triage.models import TriageRecord


@pytest.fixture
def memory(tmp_path):
    db_path = str(tmp_path / "test_memory.db")
    store = MemoryStore(db_path=db_path)
    yield store
    store.close()


def _make_record(fingerprint="fp1", check_id="rule.test", verdict="true_positive", confidence=0.9):
    return TriageRecord(
        fingerprint=fingerprint,
        check_id=check_id,
        path="src/app.py",
        verdict=verdict,
        confidence=confidence,
        reasoning="Test reasoning",
        created_at="2025-01-01T00:00:00+00:00",
        updated_at="2025-01-01T00:00:00+00:00",
    )


class TestMemoryStore:
    def test_store_and_lookup(self, memory):
        record = _make_record()
        memory.store(record)
        result = memory.lookup("fp1")
        assert result is not None
        assert result.verdict == "true_positive"
        assert result.confidence == 0.9

    def test_lookup_not_found(self, memory):
        assert memory.lookup("nonexistent") is None

    def test_lookup_by_rule(self, memory):
        memory.store(_make_record("fp1", "rule.a", "true_positive"))
        memory.store(_make_record("fp2", "rule.a", "false_positive"))
        memory.store(_make_record("fp3", "rule.b", "true_positive"))
        results = memory.lookup_by_rule("rule.a")
        assert len(results) == 2
        assert all(r.check_id == "rule.a" for r in results)

    def test_lookup_by_rule_limit(self, memory):
        for i in range(5):
            memory.store(_make_record(f"fp{i}", "rule.x"))
        results = memory.lookup_by_rule("rule.x", limit=3)
        assert len(results) == 3

    def test_upsert(self, memory):
        memory.store(_make_record("fp1", verdict="true_positive"))
        memory.store(_make_record("fp1", verdict="false_positive"))
        result = memory.lookup("fp1")
        assert result.verdict == "false_positive"

    def test_add_feedback(self, memory):
        memory.store(_make_record())
        success = memory.add_feedback("fp1", "Actually safe due to WAF")
        assert success
        result = memory.lookup("fp1")
        assert result.feedback == "Actually safe due to WAF"

    def test_add_feedback_missing(self, memory):
        assert memory.add_feedback("nonexistent", "feedback") is False

    def test_get_hints_exact_match(self, memory):
        memory.store(_make_record())
        hints = memory.get_hints("rule.test", "fp1")
        assert any("Previously triaged" in h for h in hints)

    def test_get_hints_rule_stats(self, memory):
        memory.store(_make_record("fp1", "rule.x", "true_positive"))
        memory.store(_make_record("fp2", "rule.x", "false_positive"))
        memory.store(_make_record("fp3", "rule.x", "true_positive"))
        hints = memory.get_hints("rule.x", "nonexistent")
        assert any("3 previous findings" in h for h in hints)

    def test_context_manager(self, tmp_path):
        db_path = str(tmp_path / "ctx_test.db")
        with MemoryStore(db_path=db_path) as m:
            m.store(_make_record())
            assert m.lookup("fp1") is not None
