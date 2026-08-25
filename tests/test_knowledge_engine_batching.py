import gc
from unittest.mock import MagicMock

import pytest

from knowledge_engine import CombatKnowledgeBase


@pytest.fixture(scope="function")
def kb_with_mocked_insert(tmp_path):
    # Real CombatKnowledgeBase (real Chroma, temp dir), but insert_nodes/
    # insert are mocked out so this never makes a real embedding API call
    # -- proves ingest_directory batches without needing GOOGLE_API_KEY.
    test_db_dir = str(tmp_path / "chroma_test_db_batch")
    kb = CombatKnowledgeBase(persist_dir=test_db_dir, collection_name="test_batch_kb")
    kb.index.insert_nodes = MagicMock()
    kb.index.insert = MagicMock()  # proves the old per-doc path is unused

    yield kb

    # Explicitly release SQLite / Chroma handles before teardown on Windows
    del kb.chroma_client, kb.chroma_collection, kb.vector_store, kb.storage_context, kb.index, kb
    gc.collect()


def test_ingest_directory_batches_into_a_single_insert_nodes_call(kb_with_mocked_insert):
    kb = kb_with_mocked_insert
    count = kb.ingest_directory("./data/rules", category="rules")

    assert count == 9  # len(data/rules/**/*.md)
    kb.index.insert_nodes.assert_called_once()
    kb.index.insert.assert_not_called()

    inserted_nodes = kb.index.insert_nodes.call_args.args[0]
    assert len(inserted_nodes) >= count
    # Not asserting the *value* is "rules": several data/rules/**/*.md files
    # have their own YAML frontmatter `category:` key, which legitimately
    # overwrites the ingest_directory(category=...) default during the
    # frontmatter merge (pre-existing behavior, unrelated to batching).
    assert all("category" in n.metadata for n in inserted_nodes)


def test_ingest_directory_applies_yaml_frontmatter_metadata_before_batching(kb_with_mocked_insert):
    kb = kb_with_mocked_insert
    kb.ingest_directory("./data/lore", category="lore")

    inserted_nodes = kb.index.insert_nodes.call_args.args[0]
    assert any(n.metadata.get("faction") == "iron_silk_bureau" for n in inserted_nodes)


def test_ingest_directory_returns_zero_for_a_nonexistent_directory(kb_with_mocked_insert):
    kb = kb_with_mocked_insert
    count = kb.ingest_directory("./data/does_not_exist", category="lore")

    assert count == 0
    kb.index.insert_nodes.assert_not_called()
