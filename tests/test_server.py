import time
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import server
from persistence import StateStore


@pytest.fixture(autouse=True)
def isolated_state_store(monkeypatch, tmp_path):
    # server.py's lifespan constructs StateStore() with the real default
    # path (./state_db/combat_state.db) -- redirect it to a temp file so
    # these tests never touch the actual project database.
    db_path = str(tmp_path / "test_state.db")
    monkeypatch.setattr(server, "StateStore", lambda: StateStore(db_path))


def _fake_load_success(store):
    return {"kb": MagicMock(), "llm": MagicMock(), "combat_engine": MagicMock()}


def _fake_load_failure(store):
    raise RuntimeError("simulated startup failure")


def _hang_then_succeed(store):
    # Deterministic "not ready yet" window for tests that assert on
    # pre-readiness behavior, instead of racing the background task.
    time.sleep(1.0)
    return _fake_load_success(store)


def _wait_for(predicate, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def test_health_transitions_from_starting_to_ok(monkeypatch):
    monkeypatch.setattr(server, "_load_knowledge_and_engine", _fake_load_success)
    with TestClient(server.app) as client:
        assert _wait_for(lambda: client.get("/health").json()["status"] == "ok")


def test_health_reports_error_on_startup_failure(monkeypatch):
    monkeypatch.setattr(server, "_load_knowledge_and_engine", _fake_load_failure)
    with TestClient(server.app) as client:
        assert _wait_for(lambda: client.get("/health").json()["status"] == "error")
        resp = client.get("/health")
        assert resp.status_code == 503


def test_encounters_crud_works_before_kb_is_ready(monkeypatch):
    # store is constructed synchronously in lifespan, independent of the
    # (still-hanging here) KB/engine load -- CRUD must not wait on it.
    monkeypatch.setattr(server, "_load_knowledge_and_engine", _hang_then_succeed)
    with TestClient(server.app) as client:
        resp = client.post("/encounters", json={
            "encounter_id": "enc_1", "round": 1, "active_turn_index": 0, "combatants": []
        })
        assert resp.status_code == 200


def test_damage_stream_returns_503_before_ready(monkeypatch):
    monkeypatch.setattr(server, "_load_knowledge_and_engine", _hang_then_succeed)
    with TestClient(server.app) as client:
        resp = client.post("/encounters/enc_1/damage/stream", json={
            "target_id": "x", "damage_amount": 1, "damage_type": "Slashing", "applied_conditions": []
        })
        assert resp.status_code == 503
