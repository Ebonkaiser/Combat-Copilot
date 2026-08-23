import gc
import pytest
from knowledge_engine import CombatKnowledgeBase


@pytest.fixture(scope="function")
def temp_kb(tmp_path):
    # Use isolated unique temporary path managed per test run
    test_db_dir = str(tmp_path / "chroma_test_db")

    kb = CombatKnowledgeBase(persist_dir=test_db_dir, collection_name="test_lore")
    
    # Ingest test datasets
    kb.ingest_directory("./data/lore", category="lore")
    kb.ingest_directory("./data/rules", category="rules")
    
    yield kb

    # Explicitly release SQLite / Chroma handles before teardown on Windows
    del kb.chroma_client
    del kb.chroma_collection
    del kb.vector_store
    del kb.storage_context
    del kb.index
    del kb
    gc.collect()


def test_retrieval_with_faction_filter(temp_kb):
    query = "vulnerabilities and behaviors"
    result = temp_kb.retrieve_context(query=query, faction="Iron Silk", top_k=1)
    
    assert len(result) > 0
    assert "Iron Silk" in result
    assert "lacquered silk armor" in result


def test_retrieval_general_rules(temp_kb):
    query = "What does the incapacitated condition do?"
    result = temp_kb.retrieve_context(query=query, top_k=1)
    
    assert len(result) > 0
    assert "Incapacitated" in result