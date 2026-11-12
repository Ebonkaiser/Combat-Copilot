"""Content sync embeds in batches instead of one API call per document.

Offline (no API key, no network): the injected HashingEmbedding records the size
of every embedding batch it is asked for, i.e. one entry per embedding API call
the real GoogleGenAIEmbedding would have made.
"""
from unittest.mock import MagicMock

import pytest

from support import RULES_DIR, HashingEmbedding

BATCH_SIZE = 10  # llama-index's default embed_batch_size


@pytest.fixture
def embedder():
    return HashingEmbedding()


@pytest.fixture
def kb(make_kb, embedder):
    kb = make_kb(embed_model=embedder)
    # Spy on (but still run) the batched insert; fail loudly if the old per-document path is used.
    kb.index.insert_nodes = MagicMock(wraps=kb.index.insert_nodes)
    kb.index.insert = MagicMock()
    return kb


def write_docs(directory, count):
    directory.mkdir()
    for i in range(count):
        (directory / f"doc_{i:02d}.md").write_text(
            f"# Doc {i}\n\nUnique body number {i} about topic{i}.\n", encoding="utf-8"
        )


def test_sync_batches_into_a_single_insert_nodes_call(kb):
    result = kb.sync_rules(str(RULES_DIR))

    assert result.added == 9  # len(data/rules/**/*.md)
    kb.index.insert_nodes.assert_called_once()
    kb.index.insert.assert_not_called()  # proves the old per-document path is unused
    inserted_nodes = kb.index.insert_nodes.call_args.args[0]
    assert len(inserted_nodes) >= result.added


def test_embedding_calls_are_ceil_n_over_batch_size_not_one_per_document(make_kb, embedder, tmp_path):
    write_docs(tmp_path / "bulk", 25)
    kb = make_kb(embed_model=embedder)

    kb.sync_campaign(str(tmp_path / "bulk"), "bulk-campaign")

    assert embedder.batch_sizes == [10, 10, 5]  # 3 calls, not 25
    assert max(embedder.batch_sizes) <= BATCH_SIZE


def test_rules_sync_needs_a_single_embedding_call(kb, embedder):
    kb.sync_rules(str(RULES_DIR))

    assert embedder.batch_sizes == [9]


def test_sync_applies_yaml_frontmatter_metadata_before_batching(make_kb, embedder):
    from support import FIXTURE_CAMPAIGN_ID, FIXTURE_LORE_DIR

    kb = make_kb(embed_model=embedder)
    kb.index.insert_nodes = MagicMock(wraps=kb.index.insert_nodes)

    kb.sync_campaign(str(FIXTURE_LORE_DIR), FIXTURE_CAMPAIGN_ID)

    inserted_nodes = kb.index.insert_nodes.call_args.args[0]
    assert any(n.metadata.get("faction") == "amber_quill_chancery" for n in inserted_nodes)
    assert all(n.metadata.get("campaign_id") == FIXTURE_CAMPAIGN_ID for n in inserted_nodes)
    assert all("category" in n.metadata for n in inserted_nodes)


def test_unchanged_content_makes_no_embedding_calls_and_no_insert(kb, embedder):
    kb.sync_rules(str(RULES_DIR))
    embedder.batch_sizes.clear()
    kb.index.insert_nodes.reset_mock()

    again = kb.sync_rules(str(RULES_DIR))

    assert (again.added, again.removed, again.unchanged) == (0, 0, 9)
    assert embedder.batch_sizes == []
    kb.index.insert_nodes.assert_not_called()


def test_a_nonexistent_directory_adds_nothing(kb, embedder):
    result = kb.sync_campaign("./data/does_not_exist", "some-campaign")

    assert (result.added, result.removed, result.unchanged) == (0, 0, 0)
    assert kb.count() == 0
    assert embedder.batch_sizes == []
    kb.index.insert_nodes.assert_not_called()
