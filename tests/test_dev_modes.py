"""FAKE_AI, CHROMA_DIR and STATE_DB_PATH: dev/test switches that must be inert in production. Offline."""
import logging
import os

import pytest

import server
from fake_ai import EchoChatModel, HashingEmbedding
from persistence import StateStore
from support import (
    FIXTURE_CAMPAIGN_ID,
    FIXTURE_CAMPAIGNS_DIR,
    SENTINEL,
    SERVER_ENV_VARS,
    release_kb,
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in (*SERVER_ENV_VARS, "CHROMA_DIR", "STATE_DB_PATH"):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize(
    "env, expected",
    [("development", True), ("test", True), ("Development ", True), ("production", False), (None, False), ("staging", False), ("", False)],
)
def test_fake_ai_is_honoured_only_in_development_or_test(monkeypatch, env, expected):
    monkeypatch.setenv("FAKE_AI", "1")
    if env is not None:
        monkeypatch.setenv("ENV", env)

    assert server._fake_ai_enabled() is expected


def test_fake_ai_in_production_is_refused_loudly(monkeypatch, caplog):
    monkeypatch.setenv("FAKE_AI", "1")
    monkeypatch.setenv("ENV", "production")

    with caplog.at_level(logging.ERROR, logger="combat_copilot.server"):
        assert server._fake_ai_enabled() is False

    assert "FAKE_AI=1 is ignored" in caplog.text


@pytest.mark.parametrize("value", [None, "", "0", "true", "yes", "11"])
def test_fake_ai_needs_exactly_1(monkeypatch, value):
    monkeypatch.setenv("ENV", "development")
    if value is not None:
        monkeypatch.setenv("FAKE_AI", value)

    assert server._fake_ai_enabled() is False


def test_the_fake_startup_builds_an_offline_engine_over_its_own_collection(monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_AI", "1")
    monkeypatch.setenv("ENV", "test")
    monkeypatch.setenv("CHROMA_DIR", str(tmp_path / "chroma"))
    monkeypatch.setenv("CAMPAIGNS_DIR", str(FIXTURE_CAMPAIGNS_DIR))
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)  # proves nothing here needs one

    result = server._load_knowledge_and_engine(StateStore(str(tmp_path / "state.db")))
    kb = result["kb"]
    try:
        assert isinstance(result["llm"], EchoChatModel)
        assert isinstance(kb.embed_model, HashingEmbedding)
        assert kb.collection_name == "ttrpg_knowledge_fake_v2"  # never mixed with real Gemini vectors
        assert kb.persist_dir == str(tmp_path / "chroma")
        assert set(result["campaigns"]) == {FIXTURE_CAMPAIGN_ID}
        assert SENTINEL in kb.retrieve_campaign_lore("SENTINEL_LORE_7Q2", FIXTURE_CAMPAIGN_ID, top_k=1)
        assert "Incapacitated" in kb.retrieve_rules("incapacitated condition")
    finally:
        release_kb(kb)


def test_state_db_path_comes_from_the_environment(monkeypatch, tmp_path):
    target = tmp_path / "nested" / "dir" / "e2e.db"
    monkeypatch.setenv("STATE_DB_PATH", str(target))

    StateStore()

    assert target.exists()


def test_an_explicit_db_path_wins_over_the_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("STATE_DB_PATH", str(tmp_path / "from_env.db"))

    StateStore(str(tmp_path / "explicit.db"))

    assert (tmp_path / "explicit.db").exists()
    assert not (tmp_path / "from_env.db").exists()


def test_without_the_variable_the_default_path_is_the_documented_one():
    from persistence import DEFAULT_DB_PATH

    assert DEFAULT_DB_PATH == "./state_db/combat_state.db"
    assert "STATE_DB_PATH" not in os.environ


def test_the_apps_info_logs_reach_the_container_logs():
    # uvicorn configures only its own loggers; without a handler on "combat_copilot" the INFO lines
    # about what was synced and whether owner login is on would never be shown.
    import logging

    app_logger = logging.getLogger("combat_copilot")

    assert app_logger.handlers
    assert app_logger.getEffectiveLevel() <= logging.INFO
    assert logging.getLogger("combat_copilot.knowledge").isEnabledFor(logging.INFO)
    assert not logging.getLogger("chromadb").isEnabledFor(logging.INFO)  # third parties stay quiet
