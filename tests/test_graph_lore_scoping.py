"""The LangGraph retrieve_lore node and compiled graph carry campaign_id through.

Offline (no API key, no network): HashingEmbedding for retrieval and a fake chat
model for narration. The live-model version of the owner-mode run is
test_combat_graph.py.
"""
import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel

from combat_graph import create_combat_engine, retrieve_lore_node
from support import (
    ALL_SENTINELS,
    FIXTURE_CAMPAIGN_ID,
    FIXTURE_LORE_DIR,
    RULES_DIR,
    SENTINEL,
    SENTINEL_NO_FACTION,
    SENTINEL_OTHER_FACTION,
)

NO_CAMPAIGN_KEY = object()  # the state has no "campaign_id" key at all


@pytest.fixture
def kb(make_kb):
    kb = make_kb()
    kb.sync_rules(str(RULES_DIR))
    kb.sync_campaign(str(FIXTURE_LORE_DIR), FIXTURE_CAMPAIGN_ID)
    return kb


def make_state(campaign_id=FIXTURE_CAMPAIGN_ID, faction="iron_silk_bureau", name="Iron Silk Guard", condition=None):
    state = {
        "encounter_id": "enc_test",
        "round": 1,
        "active_turn_index": 0,
        "combatants": [
            {
                "id": "enemy_1", "name": name, "type": "enemy", "armor_class": 13,
                "max_hp": 20, "current_hp": 15, "conditions": [], "tactical_tags": ["Defensive"],
                "resources": {}, "faction": faction, "initiative": 0, "weapon_equipped": "Unarmed",
            }
        ],
        "last_event": {
            "target_id": "enemy_1",
            "damage_entries": [{"amount": 5, "damage_type": "Fire"}],
            "condition_name": condition,
            "condition_action": "add" if condition else None,
        },
        "gm_notes": "",
        "retrieved_lore": "",
        "streamed_narration": "",
    }
    if campaign_id is not NO_CAMPAIGN_KEY:
        state["campaign_id"] = campaign_id
    return state


def lore_and_rules(retrieved: str) -> tuple[str, str]:
    lore_part, rules_part = retrieved.split("--- RULES ---")
    return lore_part.removeprefix("--- LORE ---").strip(), rules_part.strip()


# ------------------------------------------------------------------ the node

@pytest.mark.parametrize("campaign_id", [None, NO_CAMPAIGN_KEY], ids=["campaign_id=None", "no campaign_id key"])
def test_anonymous_state_gets_rules_but_never_campaign_lore(kb, campaign_id):
    retrieved = retrieve_lore_node(make_state(campaign_id=campaign_id), kb)["retrieved_lore"]

    lore, rules = lore_and_rules(retrieved)
    assert lore == ""
    assert rules != ""
    assert not any(s in retrieved for s in ALL_SENTINELS)


def test_a_campaign_gets_its_faction_lore_and_the_rules(kb):
    retrieved = retrieve_lore_node(make_state(), kb)["retrieved_lore"]

    lore, rules = lore_and_rules(retrieved)
    assert "Iron Silk" in lore
    assert SENTINEL in lore
    assert SENTINEL_OTHER_FACTION not in retrieved  # the faction filter still applies
    assert rules != ""


def test_the_faction_filter_still_selects_the_targets_faction(kb):
    state = make_state(faction="cloud_tread_syndicate", name="Fixture Informant")

    lore, _ = lore_and_rules(retrieve_lore_node(state, kb)["retrieved_lore"])

    assert SENTINEL_OTHER_FACTION in lore
    assert SENTINEL not in lore


def test_without_a_faction_the_whole_campaign_is_searched(kb):
    state = make_state(faction=None, name="foggy harbor smugglers")

    lore, _ = lore_and_rules(retrieve_lore_node(state, kb)["retrieved_lore"])

    assert SENTINEL_NO_FACTION in lore


def test_a_campaign_that_was_never_synced_yields_no_lore_rather_than_an_error(kb):
    lore, rules = lore_and_rules(retrieve_lore_node(make_state(campaign_id="not-synced"), kb)["retrieved_lore"])

    assert lore == ""
    assert rules != ""


@pytest.mark.parametrize("bad_campaign_id", ["srd", "Bad Id"])
def test_a_reserved_or_malformed_campaign_id_fails_closed(kb, bad_campaign_id):
    # Never answered with rules-as-lore or an unscoped search: it is an error.
    with pytest.raises(ValueError):
        retrieve_lore_node(make_state(campaign_id=bad_campaign_id), kb)


def test_an_empty_campaign_id_is_treated_as_no_campaign(kb):
    retrieved = retrieve_lore_node(make_state(campaign_id=""), kb)["retrieved_lore"]

    assert lore_and_rules(retrieved)[0] == ""
    assert not any(s in retrieved for s in ALL_SENTINELS)


# ------------------------------------------------------- the compiled graph

def run_graph(kb, state):
    engine = create_combat_engine(kb=kb, llm=FakeListChatModel(responses=["The fake narration."]))
    return engine.invoke(state)


def test_the_compiled_graph_passes_campaign_id_to_retrieval(kb):
    final = run_graph(kb, make_state(campaign_id=FIXTURE_CAMPAIGN_ID))

    assert final["combatants"][0]["current_hp"] == 10  # deterministic mutation still happens
    assert final["streamed_narration"] == "The fake narration."  # not the LLM-failure fallback
    assert SENTINEL in final["retrieved_lore"]


def test_the_compiled_graph_keeps_anonymous_runs_free_of_campaign_lore(kb):
    final = run_graph(kb, make_state(campaign_id=None))

    assert final["combatants"][0]["current_hp"] == 10
    assert final["streamed_narration"] == "The fake narration."
    assert not any(s in final["retrieved_lore"] for s in ALL_SENTINELS)
    assert lore_and_rules(final["retrieved_lore"])[1] != ""  # rules still flow
