import time
from contextlib import ExitStack
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from knowledge_engine import CombatKnowledgeBase
from persistence import StateStore
from support import (
    SERVER_ENV_VARS,
    Api,
    FakeClock,
    HashingEmbedding,
    RecordingSender,
    release_kb,
)


@pytest.fixture
def make_kb(tmp_path):
    """Factory for knowledge bases backed by the offline HashingEmbedding.

    Call it again with the same ``persist_dir`` to simulate a server restart
    (a brand-new object over the data an earlier one persisted).
    """
    created = []

    def factory(persist_dir=None, embed_model=None, collection_name="test_scoping"):
        kb = CombatKnowledgeBase(
            persist_dir=str(persist_dir if persist_dir is not None else tmp_path / "chroma"),
            collection_name=collection_name,
            embed_model=embed_model if embed_model is not None else HashingEmbedding(),
        )
        created.append(kb)
        return kb

    yield factory

    for kb in created:
        release_kb(kb)


@pytest.fixture
def open_api(monkeypatch, tmp_path):
    """Starts the real FastAPI app (real lifespan, isolated state DB, no network) and returns an Api.

    ``open_api(**env)`` sets those environment variables first (everything the server reads is
    cleared beforehand, so a developer's shell or .env never leaks in). By default it swaps in a
    RecordingSender and a FakeClock (``sender=None`` keeps the real email sender), replaces the
    heavy knowledge-base startup with an instant fake (or ``loader=`` your own), and waits for
    startup to finish (``ready=False`` to skip the wait).
    """
    import server

    for name in SERVER_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    db_path = str(tmp_path / "api_state.db")
    monkeypatch.setattr(server, "StateStore", lambda: StateStore(db_path))
    stack = ExitStack()

    def fake_loader(store):
        return {"kb": MagicMock(), "llm": MagicMock(), "combat_engine": MagicMock(), "campaigns": {}}

    def open_(
        base_url="http://testserver",
        client_address=("127.0.0.1", 50000),
        sender="recording",
        loader=None,
        ready=True,
        **env,
    ):
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        monkeypatch.setattr(server, "_load_knowledge_and_engine", loader or fake_loader)
        client = stack.enter_context(TestClient(server.app, base_url=base_url, client=client_address))
        auth = client.app.state.auth
        clock = FakeClock()
        auth.clock = clock
        if sender == "recording":
            auth.sender = RecordingSender()
        if ready:
            deadline = time.time() + 15
            while client.get("/health").status_code != 200:
                assert time.time() < deadline, "backend did not become ready"
                time.sleep(0.02)
        return Api(client=client, auth=auth, sender=auth.sender, clock=clock)

    yield open_
    stack.close()
