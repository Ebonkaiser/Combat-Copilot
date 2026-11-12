"""Campaign registry (campaigns.py): validation, skipping bad folders, env config. Offline."""
import logging
from pathlib import Path

import pytest

from campaigns import (
    RULES_CAMPAIGN_ID,
    is_valid_campaign_id,
    load_campaigns,
)
from support import FIXTURE_CAMPAIGN_DIR, FIXTURE_CAMPAIGN_ID, FIXTURE_CAMPAIGNS_DIR, REPO_ROOT

GOOD_MANIFEST = "id: {slug}\nname: {name}\ndescription: A test campaign.\n"
GOOD_ROSTER = """\
combatants:
  - id: c1
    name: Hero
    type: player
    armor_class: 15
    max_hp: 20
    current_hp: 20
"""


def make_campaign(root: Path, folder: str, manifest: str | None = "default", roster: str | None = "default") -> Path:
    path = root / folder
    (path / "lore").mkdir(parents=True)
    if manifest == "default":
        manifest = GOOD_MANIFEST.format(slug=folder, name="Test")
    if manifest is not None:
        (path / "campaign.yaml").write_text(manifest, encoding="utf-8")
    if roster == "default":
        roster = GOOD_ROSTER
    if roster is not None:
        (path / "roster.yaml").write_text(roster, encoding="utf-8")
    return path


# ------------------------------------------------------------------ happy path

def test_fixture_campaign_loads():
    campaigns = load_campaigns(FIXTURE_CAMPAIGNS_DIR)

    assert set(campaigns) == {FIXTURE_CAMPAIGN_ID}
    campaign = campaigns[FIXTURE_CAMPAIGN_ID]
    assert campaign.name == "Test Campaign"
    assert [c.id for c in campaign.roster] == ["pc_fixture_hero", "npc_fixture_guard"]
    assert campaign.roster[1].faction == "amber_quill_chancery"
    assert campaign.lore_dir == FIXTURE_CAMPAIGN_DIR / "lore"
    assert campaign.lore_dir.is_dir()


def test_missing_campaigns_directory_is_not_an_error(tmp_path):
    assert load_campaigns(tmp_path / "does-not-exist") == {}


def test_empty_campaigns_directory(tmp_path):
    assert load_campaigns(tmp_path) == {}


def test_campaigns_dir_comes_from_the_environment(tmp_path, monkeypatch):
    make_campaign(tmp_path, "from-env")
    monkeypatch.setenv("CAMPAIGNS_DIR", str(tmp_path))

    assert set(load_campaigns()) == {"from-env"}


def test_roster_is_optional_and_defaults_to_empty(tmp_path, caplog):
    make_campaign(tmp_path, "lore-only", roster=None)

    with caplog.at_level(logging.WARNING, logger="combat_copilot.campaigns"):
        campaigns = load_campaigns(tmp_path)

    assert campaigns["lore-only"].roster == []
    assert "no roster.yaml" in caplog.text


def test_empty_roster_file_is_an_empty_roster(tmp_path):
    make_campaign(tmp_path, "blank-roster", roster="")

    assert load_campaigns(tmp_path)["blank-roster"].roster == []


def test_utf8_bom_in_yaml_files_is_tolerated(tmp_path):
    path = make_campaign(tmp_path, "bom-camp")
    (path / "campaign.yaml").write_bytes(b"\xef\xbb\xbf" + GOOD_MANIFEST.format(slug="bom-camp", name="Bom").encode())

    assert "bom-camp" in load_campaigns(tmp_path)


# ---------------------------------------------------- bad folders are skipped

@pytest.mark.parametrize(
    "case, manifest, roster, expected_in_log",
    [
        ("id-mismatch", "id: someone-else\nname: X\n", "default", "does not match the folder name"),
        ("bad-yaml", "id: [unclosed\nname: X\n", "default", "not valid YAML"),
        ("manifest-is-a-list", "- id\n- name\n", "default", "must be a mapping"),
        ("blank-name", "id: blank-name\nname: '   '\n", "default", "campaign.yaml is invalid"),
        ("no-name", "id: no-name\n", "default", "campaign.yaml is invalid"),
        ("bad-roster-type", "default", "combatants:\n  - id: a\n    name: A\n    type: dragon\n    armor_class: 1\n    max_hp: 1\n    current_hp: 1\n", "roster.yaml is invalid"),
        ("roster-missing-field", "default", "combatants:\n  - id: a\n    name: A\n", "roster.yaml is invalid"),
        ("roster-is-a-list", "default", "- id: a\n", "must be a mapping"),
        (
            "dup-ids",
            "default",
            "combatants:\n"
            "  - {id: a, name: A, type: player, armor_class: 1, max_hp: 1, current_hp: 1}\n"
            "  - {id: a, name: B, type: enemy, armor_class: 1, max_hp: 1, current_hp: 1}\n",
            "duplicate combatant ids: a",
        ),
        ("no-manifest", None, "default", "campaign.yaml not found"),
    ],
)
def test_bad_campaign_is_logged_and_skipped_but_good_ones_still_load(
    tmp_path, caplog, case, manifest, roster, expected_in_log
):
    make_campaign(tmp_path, "good-one")
    make_campaign(tmp_path, case, manifest=manifest, roster=roster)

    with caplog.at_level(logging.ERROR, logger="combat_copilot.campaigns"):
        campaigns = load_campaigns(tmp_path)

    assert set(campaigns) == {"good-one"}
    assert expected_in_log in caplog.text
    assert case in caplog.text


@pytest.mark.parametrize("folder", ["Upper-Case", "has space", "under_score_inside", "dots.in.name", "ünï"])
def test_folder_names_must_be_slugs(tmp_path, caplog, folder):
    make_campaign(tmp_path, "good-one")
    path = tmp_path / folder
    path.mkdir()
    (path / "campaign.yaml").write_text(GOOD_MANIFEST.format(slug=folder, name="X"), encoding="utf-8")

    with caplog.at_level(logging.ERROR, logger="combat_copilot.campaigns"):
        campaigns = load_campaigns(tmp_path)

    assert set(campaigns) == {"good-one"}
    assert "folder name must match" in caplog.text


def test_the_rules_namespace_is_reserved(tmp_path, caplog):
    # A campaign called "srd" would have its lore served to everyone as a rule.
    make_campaign(tmp_path, RULES_CAMPAIGN_ID)

    with caplog.at_level(logging.ERROR, logger="combat_copilot.campaigns"):
        assert load_campaigns(tmp_path) == {}

    assert "folder name must match" in caplog.text


def test_hidden_and_underscore_folders_are_ignored_quietly(tmp_path, caplog):
    make_campaign(tmp_path, "good-one")
    (tmp_path / ".git").mkdir()
    (tmp_path / "_scratch").mkdir()
    (tmp_path / "notes.txt").write_text("not a campaign", encoding="utf-8")

    with caplog.at_level(logging.WARNING, logger="combat_copilot.campaigns"):
        campaigns = load_campaigns(tmp_path)

    assert set(campaigns) == {"good-one"}
    assert caplog.text == ""


def test_a_validation_log_line_does_not_echo_roster_values(tmp_path, caplog):
    make_campaign(
        tmp_path,
        "leaky",
        roster="combatants:\n  - {id: a, name: SECRET_NAME_XYZ, type: dragon, armor_class: 1, max_hp: 1, current_hp: 1}\n",
    )

    with caplog.at_level(logging.ERROR, logger="combat_copilot.campaigns"):
        load_campaigns(tmp_path)

    assert "roster.yaml is invalid" in caplog.text
    assert "SECRET_NAME_XYZ" not in caplog.text


# ------------------------------------------------------------- slug validation

@pytest.mark.parametrize("value", ["light-and-magic", "a", "abc-123", "0", "-"])
def test_valid_slugs(value):
    assert is_valid_campaign_id(value)


@pytest.mark.parametrize("value", ["", "Abc", "a b", "a_b", "a/b", "../x", "abc\n", "srd", None, 5])
def test_invalid_slugs(value):
    assert not is_valid_campaign_id(value)


# --------------------------------------------- the owner's real campaign data

REAL_CAMPAIGNS_DIR = REPO_ROOT / "data" / "campaigns"


@pytest.mark.skipif(not REAL_CAMPAIGNS_DIR.is_dir(), reason="private campaign content is not checked in; only present locally")
def test_real_campaign_folders_on_this_machine_are_valid():
    """Guards the owner's own data locally (skipped in CI, where data/campaigns/ does not exist)."""
    folders = [p.name for p in REAL_CAMPAIGNS_DIR.iterdir() if p.is_dir() and not p.name.startswith((".", "_"))]
    campaigns = load_campaigns(REAL_CAMPAIGNS_DIR)

    assert set(campaigns) == set(folders), "a campaign folder failed validation -- see the logged error"
    for campaign in campaigns.values():
        assert campaign.roster, f"{campaign.id} has an empty roster"
