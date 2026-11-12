"""Live tier: retrieval quality with REAL embeddings (needs GOOGLE_API_KEY).

The campaign here is the synthetic fixture under tests/fixtures/campaigns/ -- the
owner's private campaign content is never used by tests. The offline scoping
guarantees live in test_knowledge_scoping.py; this file re-checks the important
ones against real embedding vectors.
"""
import pytest
from dotenv import load_dotenv

from knowledge_engine import CombatKnowledgeBase
from support import (
    ALL_SENTINELS,
    FIXTURE_CAMPAIGN_ID,
    FIXTURE_LORE_DIR,
    RULES_DIR,
    release_kb,
)

load_dotenv()


@pytest.fixture(scope="function")
def temp_kb(tmp_path):
    # Isolated temporary path per test run; real GoogleGenAIEmbedding.
    kb = CombatKnowledgeBase(persist_dir=str(tmp_path / "chroma_test_db"), collection_name="test_lore")
    kb.sync_campaign(str(FIXTURE_LORE_DIR), FIXTURE_CAMPAIGN_ID)
    kb.sync_rules(str(RULES_DIR))

    yield kb

    # Explicitly release SQLite / Chroma handles before teardown on Windows
    release_kb(kb)


def test_retrieval_with_faction_filter(temp_kb):
    # The faction value must be the lore corpus's slug convention (see the
    # frontmatter of tests/fixtures/campaigns/test-campaign/lore/factions/*.md),
    # e.g. "iron_silk_bureau", not "Iron Silk": the filter is an exact match.
    result = temp_kb.retrieve_context(
        query="vulnerabilities and behaviors",
        campaign_id=FIXTURE_CAMPAIGN_ID,
        faction="iron_silk_bureau",
        top_k=3,
    )

    assert len(result) > 0
    assert "Iron Silk" in result


def test_retrieval_general_rules(temp_kb):
    result = temp_kb.retrieve_context(query="What does the incapacitated condition do?", campaign_id=None, top_k=1)

    assert len(result) > 0
    assert "Incapacitated" in result


@pytest.mark.parametrize(
    "query",
    [
        "What does the Iron Silk Bureau fear?",
        "secret police guards and their weaknesses",
        "harbor smugglers and informants",
    ],
)
def test_anonymous_retrieval_excludes_campaign_lore_with_real_embeddings(temp_kb, query):
    result = temp_kb.retrieve_context(query=query, campaign_id=None, top_k=5)

    assert not any(sentinel in result for sentinel in ALL_SENTINELS)
