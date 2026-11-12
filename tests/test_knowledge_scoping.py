"""Campaign-scoped retrieval and content sync (knowledge_engine.py).

Offline: no API key, no network. HashingEmbedding makes retrieval deterministic
-- a query that names a document's distinctive words finds it -- which is all
that is needed to test *who may see which text*. Semantic quality is covered by
the live tier (test_knowledge_engine.py).
"""
import logging

import pytest

import server
from campaigns import load_campaigns
from support import (
    ALL_SENTINELS,
    FIXTURE_CAMPAIGN_ID,
    FIXTURE_CAMPAIGNS_DIR,
    FIXTURE_LORE_DIR,
    RULES_DIR,
    SENTINEL,
    SENTINEL_NO_FACTION,
    SENTINEL_OTHER_FACTION,
    HashingEmbedding,
    copy_fixture_lore,
    simulate_process_restart,
)

OTHER_SECRET = "OTHER_CAMPAIGN_SECRET_5K1"
RULES_QUERY = "incapacitated condition rules"


@pytest.fixture
def kb(make_kb):
    """SRD rules + the fixture campaign's lore, synced."""
    kb = make_kb()
    kb.sync_rules(str(RULES_DIR))
    kb.sync_campaign(str(FIXTURE_LORE_DIR), FIXTURE_CAMPAIGN_ID)
    return kb


def write_lore(directory, name, text):
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text(text, encoding="utf-8")
    return path


# ============================================================ idempotent sync

def test_restarting_the_backend_twice_does_not_change_the_collection_count(make_kb, tmp_path):
    persist = tmp_path / "chroma"
    first = make_kb(persist_dir=persist)
    first.sync_rules(str(RULES_DIR))
    first.sync_campaign(str(FIXTURE_LORE_DIR), FIXTURE_CAMPAIGN_ID)
    count_after_first_boot = first.count()
    assert count_after_first_boot > 0
    previous = first

    for _ in range(2):
        simulate_process_restart(previous)
        embedder = HashingEmbedding()
        restarted = make_kb(persist_dir=persist, embed_model=embedder)
        assert restarted.count() == count_after_first_boot  # really persisted, not an in-process cache

        rules = restarted.sync_rules(str(RULES_DIR))
        lore = restarted.sync_campaign(str(FIXTURE_LORE_DIR), FIXTURE_CAMPAIGN_ID)

        assert (rules.added, rules.removed, lore.added, lore.removed) == (0, 0, 0, 0)
        assert embedder.batch_sizes == []  # nothing was re-embedded
        assert restarted.count() == count_after_first_boot
        previous = restarted


# ======================================== anonymous mode never sees campaign lore

TARGETED_QUERIES = [
    "SENTINEL_LORE_7Q2",
    "SENTINEL_LORE_7Q2 Amber Quill Chancery",
    "Amber Quill Chancery secret police",
    "Amber Quill Chancery vulnerabilities and tactics",
    "Amber Quill guards fear open flame",
    "lacquered armor fire damage breaks their formation",
    "fixture empire secret police guards scattering",
    "Tidewater Lantern Cartel informant harbor warehouses",
    "SENTINEL_LORE_OTHER_FACTION",
    "SENTINEL_LORE_NO_FACTION foggy harbor smugglers",
    "rotting piers where smugglers meet after dark",
    "Fixture Harbor Fixture Informant Amber Quill Chancery (fixture)",
]


@pytest.mark.parametrize("query", TARGETED_QUERIES)
def test_anonymous_retrieval_never_returns_campaign_lore(kb, query):
    # Control: this query really does target the campaign lore -- an unfiltered
    # search finds a sentinel. Without this the assertions below could pass
    # vacuously on a query that never matched the lore in the first place.
    unfiltered = kb.index.as_retriever(similarity_top_k=5).retrieve(query)
    assert any(s in node.node.get_content() for node in unfiltered for s in ALL_SENTINELS), (
        f"query does not target the fixture lore: {query!r}"
    )

    for top_k in (1, 2, 5):
        for result in (
            kb.retrieve_context(query, campaign_id=None, top_k=top_k),
            kb.retrieve_rules(query, top_k=top_k),
        ):
            assert not any(s in result for s in ALL_SENTINELS)


def test_there_are_at_least_ten_distinct_targeted_queries():
    assert len(set(TARGETED_QUERIES)) >= 10


def test_a_campaign_id_returns_the_sentinel_for_a_targeted_query(kb):
    result = kb.retrieve_context("SENTINEL_LORE_7Q2 Amber Quill Chancery fear fire", campaign_id=FIXTURE_CAMPAIGN_ID)
    assert SENTINEL in result

    assert SENTINEL in kb.retrieve_campaign_lore("SENTINEL_LORE_7Q2", FIXTURE_CAMPAIGN_ID, top_k=1)


def test_retrieve_context_is_rules_first_then_lore(kb):
    query = f"{RULES_QUERY} SENTINEL_LORE_7Q2"

    rules = kb.retrieve_rules(query)
    lore = kb.retrieve_campaign_lore(query, FIXTURE_CAMPAIGN_ID)

    assert rules and lore
    assert kb.retrieve_context(query, FIXTURE_CAMPAIGN_ID) == f"{rules}\n\n{lore}"


def test_retrieve_rules_returns_the_public_rules(kb):
    assert "Incapacitated" in kb.retrieve_rules("What does the incapacitated condition do?", top_k=2)


# ======================================================================== fail-closed

@pytest.mark.parametrize("bad_campaign_id", [None, "", "srd", "Bad Id", "a/b", "../x"])
def test_lore_retrieval_requires_a_valid_campaign_id(kb, bad_campaign_id):
    with pytest.raises(ValueError):
        kb.retrieve_campaign_lore("SENTINEL_LORE_7Q2", bad_campaign_id)


def test_an_empty_campaign_id_is_an_error_not_anonymous_access(kb):
    with pytest.raises(ValueError):
        kb.retrieve_context("anything", campaign_id="")


def test_the_old_unscoped_api_is_gone(kb):
    assert not hasattr(kb, "ingest_directory")
    with pytest.raises(TypeError):
        kb.retrieve_context("anything", metadata_filters={})


def test_out_of_scope_chunks_are_dropped_even_if_the_vector_store_ignores_the_filter(kb, caplog, monkeypatch):
    # Chroma treats an empty/ignored filter as "no filter". If that ever
    # happened to a scoped query, the text must still not be returned.
    real_as_retriever = kb.index.as_retriever

    def filterless(similarity_top_k, filters=None):
        return real_as_retriever(similarity_top_k=similarity_top_k)

    monkeypatch.setattr(kb.index, "as_retriever", filterless)

    with caplog.at_level(logging.ERROR, logger="combat_copilot.knowledge"):
        result = kb.retrieve_rules("SENTINEL_LORE_7Q2 Amber Quill Chancery fire", top_k=5)

    assert not any(s in result for s in ALL_SENTINELS)
    assert "outside namespace" in caplog.text


# ===================================================================== faction filter

def test_faction_filter_narrows_lore_to_that_faction(kb):
    result = kb.retrieve_campaign_lore(
        "secrets", FIXTURE_CAMPAIGN_ID, faction="tidewater_lantern_cartel", top_k=5
    )

    assert SENTINEL_OTHER_FACTION in result
    assert SENTINEL not in result
    assert SENTINEL_NO_FACTION not in result


def test_without_a_faction_the_whole_campaign_is_searched(kb):
    result = kb.retrieve_campaign_lore("SENTINEL_LORE_NO_FACTION foggy harbor", FIXTURE_CAMPAIGN_ID, top_k=5)

    assert SENTINEL_NO_FACTION in result


def test_a_faction_with_no_lore_returns_nothing(kb):
    assert kb.retrieve_campaign_lore("anything", FIXTURE_CAMPAIGN_ID, faction="no_such_faction") == ""


# ================================================================ campaign isolation

def test_one_campaign_never_sees_another_campaigns_lore(kb, tmp_path):
    other = tmp_path / "other-lore"
    write_lore(
        other, "secret.md",
        f"---\nfaction: amber_quill_chancery\ntitle: Other\n---\n\n{OTHER_SECRET} amber quill chancery fire guards\n",
    )
    kb.sync_campaign(str(other), "other-campaign")
    query = f"{OTHER_SECRET} amber quill chancery fire guards"

    assert OTHER_SECRET in kb.retrieve_campaign_lore(query, "other-campaign")
    for faction in (None, "amber_quill_chancery"):
        assert OTHER_SECRET not in kb.retrieve_campaign_lore(query, FIXTURE_CAMPAIGN_ID, faction=faction, top_k=5)
        assert SENTINEL not in kb.retrieve_campaign_lore(query, "other-campaign", faction=faction, top_k=5)
    assert OTHER_SECRET not in kb.retrieve_context(query, campaign_id=None, top_k=5)
    assert OTHER_SECRET not in kb.retrieve_context(query, campaign_id=FIXTURE_CAMPAIGN_ID, top_k=5)


def test_frontmatter_cannot_claim_another_campaigns_namespace(make_kb, tmp_path):
    lore = copy_fixture_lore(tmp_path / "lore")
    write_lore(
        lore, "spoof.md",
        "---\ncampaign_id: srd\nsource_path: rules/core/conditions.md\ncategory: rule\ntitle: Spoof\n---\n\n"
        "SPOOFED_RULE_9Z1 incapacitated condition rules\n",
    )
    kb = make_kb()
    kb.sync_rules(str(RULES_DIR))
    kb.sync_campaign(str(lore), FIXTURE_CAMPAIGN_ID)
    query = "SPOOFED_RULE_9Z1 incapacitated condition rules"

    # Not served as a public rule...
    assert "SPOOFED_RULE_9Z1" not in kb.retrieve_rules(query, top_k=5)
    assert "SPOOFED_RULE_9Z1" not in kb.retrieve_context(query, campaign_id=None, top_k=5)
    # ...only as lore of the campaign whose folder it sits in.
    assert "SPOOFED_RULE_9Z1" in kb.retrieve_campaign_lore(query, FIXTURE_CAMPAIGN_ID, top_k=5)
    stored = kb.chroma_collection.get(where={"source_path": "spoof.md"}, include=["metadatas"])["metadatas"]
    assert [m["campaign_id"] for m in stored] == [FIXTURE_CAMPAIGN_ID]


def test_a_campaign_sync_refuses_the_rules_namespace_and_bad_ids(kb):
    for bad in ("srd", "Bad Id", "", "a/b"):
        with pytest.raises(ValueError):
            kb.sync_campaign(str(FIXTURE_LORE_DIR), bad)
    with pytest.raises(ValueError):
        kb.sync_directory(str(FIXTURE_LORE_DIR), "Bad Id")


# ============================================================ edits, removals, purge

def test_an_edited_file_is_re_synced(make_kb, tmp_path):
    lore = copy_fixture_lore(tmp_path / "lore")
    kb = make_kb()
    kb.sync_campaign(str(lore), FIXTURE_CAMPAIGN_ID)
    before = kb.count()

    harbor = lore / "locations" / "fixture_harbor.md"
    harbor.write_text(harbor.read_text(encoding="utf-8").replace(SENTINEL_NO_FACTION, "EDITED_MARKER_3C8"), encoding="utf-8")
    result = kb.sync_campaign(str(lore), FIXTURE_CAMPAIGN_ID)

    assert (result.added, result.removed, result.unchanged) == (1, 1, 2)
    assert kb.count() == before
    assert "EDITED_MARKER_3C8" in kb.retrieve_campaign_lore("EDITED_MARKER_3C8 foggy harbor", FIXTURE_CAMPAIGN_ID, top_k=5)
    assert SENTINEL_NO_FACTION not in kb.retrieve_campaign_lore("SENTINEL_LORE_NO_FACTION foggy harbor", FIXTURE_CAMPAIGN_ID, top_k=5)


def test_a_removed_file_is_purged(make_kb, tmp_path):
    lore = copy_fixture_lore(tmp_path / "lore")
    kb = make_kb()
    kb.sync_campaign(str(lore), FIXTURE_CAMPAIGN_ID)
    before = kb.count()

    (lore / "locations" / "fixture_harbor.md").unlink()
    result = kb.sync_campaign(str(lore), FIXTURE_CAMPAIGN_ID)

    assert (result.added, result.removed, result.unchanged) == (0, 1, 2)
    assert kb.count() == before - 1
    assert SENTINEL_NO_FACTION not in kb.retrieve_campaign_lore("SENTINEL_LORE_NO_FACTION foggy harbor", FIXTURE_CAMPAIGN_ID, top_k=5)


def test_a_missing_lore_directory_empties_the_campaign(kb, tmp_path):
    result = kb.sync_campaign(str(tmp_path / "gone"), FIXTURE_CAMPAIGN_ID)

    assert (result.added, result.removed, result.unchanged) == (0, 3, 0)
    assert kb.retrieve_campaign_lore("SENTINEL_LORE_7Q2", FIXTURE_CAMPAIGN_ID, top_k=5) == ""
    assert "Incapacitated" in kb.retrieve_rules(RULES_QUERY)  # rules untouched


def test_rewriting_a_file_with_identical_content_changes_nothing(make_kb, tmp_path):
    lore = copy_fixture_lore(tmp_path / "lore")
    kb = make_kb()
    kb.sync_campaign(str(lore), FIXTURE_CAMPAIGN_ID)

    harbor = lore / "locations" / "fixture_harbor.md"
    harbor.write_text(harbor.read_text(encoding="utf-8"), encoding="utf-8")  # new mtime, same bytes
    result = kb.sync_campaign(str(lore), FIXTURE_CAMPAIGN_ID)

    assert (result.added, result.removed, result.unchanged) == (0, 0, 3)


def convert_line_endings(folder, ending: bytes) -> None:
    """Rewrites every .md file under ``folder`` with ``ending``, whatever it had before. (A Windows
    checkout with autocrlf already has CRLF on disk, so replacing \\n blindly would produce \\r\\r\\n.)"""
    for path in folder.rglob("*.md"):
        path.write_bytes(path.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", ending))


def test_crlf_line_endings_do_not_change_documents_or_hide_frontmatter(make_kb, tmp_path):
    lore = copy_fixture_lore(tmp_path / "lore")
    convert_line_endings(lore, b"\n")  # a known starting point, whatever the checkout used
    kb = make_kb()
    kb.sync_campaign(str(lore), FIXTURE_CAMPAIGN_ID)

    convert_line_endings(lore, b"\r\n")  # as if the folder had been copied from a Windows checkout
    result = kb.sync_campaign(str(lore), FIXTURE_CAMPAIGN_ID)

    assert (result.added, result.removed, result.unchanged) == (0, 0, 3)
    assert SENTINEL_OTHER_FACTION in kb.retrieve_campaign_lore(
        "secrets", FIXTURE_CAMPAIGN_ID, faction="tidewater_lantern_cartel", top_k=5
    )


def test_a_utf8_bom_does_not_hide_frontmatter(make_kb, tmp_path):
    lore = tmp_path / "lore"
    lore.mkdir()
    (lore / "bom.md").write_bytes(b"\xef\xbb\xbf---\nfaction: bom_faction\ntitle: Bom\n---\n\nBOM_LORE_4D2 text\n")
    kb = make_kb()
    kb.sync_campaign(str(lore), FIXTURE_CAMPAIGN_ID)

    assert "BOM_LORE_4D2" in kb.retrieve_campaign_lore("BOM_LORE_4D2", FIXTURE_CAMPAIGN_ID, faction="bom_faction")


def test_only_visible_markdown_and_text_files_are_synced(make_kb, tmp_path):
    lore = tmp_path / "lore"
    write_lore(lore, "kept.md", "# Kept\n\nKEPT_MD_1A1 body\n")
    write_lore(lore, "kept.txt", "KEPT_TXT_1A2 body\n")
    write_lore(lore, ".hidden.md", "HIDDEN_FILE_1A3 body\n")
    write_lore(lore / ".obsidian", "workspace.md", "HIDDEN_DIR_1A4 body\n")
    write_lore(lore, "notes.pdf", "NOT_TEXT_1A5 body\n")
    write_lore(lore, "frontmatter_only.md", "---\ntitle: Nothing here\n---\n")
    write_lore(lore / "nested" / "deeper", "deep.md", "# Deep\n\nDEEP_MD_1A6 body\n")
    kb = make_kb()

    result = kb.sync_campaign(str(lore), "scan-campaign")

    assert result.added == 3  # kept.md, kept.txt, nested/deeper/deep.md
    stored = kb.chroma_collection.get(where={"campaign_id": "scan-campaign"}, include=["metadatas"])["metadatas"]
    assert sorted(m["source_path"] for m in stored) == ["kept.md", "kept.txt", "nested/deeper/deep.md"]


def test_purge_removes_campaigns_that_are_no_longer_on_disk(kb, tmp_path):
    other = tmp_path / "other-lore"
    write_lore(other, "secret.md", f"{OTHER_SECRET} amber quill chancery\n")
    kb.sync_campaign(str(other), "gone-campaign")

    assert kb.purge_campaigns_except([FIXTURE_CAMPAIGN_ID]) == ["gone-campaign"]

    assert kb.retrieve_campaign_lore(OTHER_SECRET, "gone-campaign") == ""
    assert SENTINEL in kb.retrieve_campaign_lore("SENTINEL_LORE_7Q2", FIXTURE_CAMPAIGN_ID, top_k=1)  # kept
    assert "Incapacitated" in kb.retrieve_rules(RULES_QUERY)  # rules kept
    assert kb.purge_campaigns_except([FIXTURE_CAMPAIGN_ID]) == []  # idempotent


def test_purge_never_removes_the_public_rules(kb):
    assert kb.purge_campaigns_except([]) == [FIXTURE_CAMPAIGN_ID]

    assert "Incapacitated" in kb.retrieve_rules(RULES_QUERY)
    assert kb.retrieve_campaign_lore("SENTINEL_LORE_7Q2", FIXTURE_CAMPAIGN_ID) == ""


def test_purge_also_removes_unscoped_orphans(kb):
    kb.chroma_collection.add(ids=["orphan"], embeddings=[[0.1] * 256], documents=["ORPHAN_TEXT"], metadatas=[{"k": "v"}])

    assert kb.purge_campaigns_except([FIXTURE_CAMPAIGN_ID]) == ["(unscoped)"]
    assert kb.chroma_collection.get(ids=["orphan"])["ids"] == []


# ========================================= server startup orchestration (_sync_knowledge)

def test_server_sync_loads_rules_and_every_campaign(make_kb):
    kb = make_kb()

    server._sync_knowledge(kb, load_campaigns(FIXTURE_CAMPAIGNS_DIR), rules_dir=str(RULES_DIR))

    assert "Incapacitated" in kb.retrieve_rules(RULES_QUERY)
    assert SENTINEL in kb.retrieve_campaign_lore("SENTINEL_LORE_7Q2", FIXTURE_CAMPAIGN_ID, top_k=1)


def test_server_sync_purges_a_campaign_that_was_removed_from_disk(kb):
    server._sync_knowledge(kb, {}, rules_dir=str(RULES_DIR))  # no campaigns on disk any more

    assert kb.retrieve_campaign_lore("SENTINEL_LORE_7Q2", FIXTURE_CAMPAIGN_ID) == ""
    assert "Incapacitated" in kb.retrieve_rules(RULES_QUERY)


def test_server_sync_with_a_missing_rules_directory_is_loud_but_keeps_stored_rules(kb, tmp_path, caplog):
    with caplog.at_level(logging.ERROR, logger="combat_copilot.server"):
        server._sync_knowledge(kb, load_campaigns(FIXTURE_CAMPAIGNS_DIR), rules_dir=str(tmp_path / "missing"))

    assert "Rules directory" in caplog.text
    assert "Incapacitated" in kb.retrieve_rules(RULES_QUERY)  # not purged by a broken working directory
