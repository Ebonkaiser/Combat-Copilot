import pytest

from knowledge_engine import CombatKnowledgeBase
from support import HashingEmbedding, release_kb


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
