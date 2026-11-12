"""YAML frontmatter extraction (knowledge_engine.CombatKnowledgeBase.extract_yaml_frontmatter). Offline."""
import pytest

from knowledge_engine import CombatKnowledgeBase

extract = CombatKnowledgeBase.extract_yaml_frontmatter


def test_extracts_metadata_and_strips_the_block():
    metadata, body = extract("---\ncategory: npc\nfaction: amber_quill_chancery\ntags: [a, b]\n---\n\n# Title\n\nBody text.\n")

    assert metadata == {"category": "npc", "faction": "amber_quill_chancery", "tags": ["a", "b"]}
    assert body == "# Title\n\nBody text."


def test_text_without_frontmatter_is_returned_unchanged():
    text = "# Just a heading\n\nNo frontmatter here.\n"

    assert extract(text) == ({}, text)


def test_invalid_yaml_keeps_the_full_text():
    text = "---\nkey: [unclosed\n---\nBody\n"

    assert extract(text) == ({}, text)


def test_a_leading_horizontal_rule_is_not_frontmatter_and_loses_no_text():
    # Two "---" rules around an ordinary paragraph: the paragraph parses as a
    # YAML string, not a mapping, so it must not be swallowed.
    text = "---\nAn introductory paragraph.\n---\nThe rest of the document.\n"

    metadata, body = extract(text)

    assert metadata == {}
    assert "An introductory paragraph." in body
    assert "The rest of the document." in body


def test_an_empty_frontmatter_block_is_dropped():
    assert extract("---\n\n---\nBody\n") == ({}, "Body")


@pytest.mark.parametrize("closing", ["---", "---   "])
def test_a_closing_rule_at_the_end_of_the_file_still_counts(closing):
    metadata, body = extract(f"---\ntitle: Only frontmatter\n{closing}")

    assert metadata == {"title": "Only frontmatter"}
    assert body == ""
