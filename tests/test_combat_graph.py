"""Live tier: the combat graph end to end with the real Gemini model (needs GOOGLE_API_KEY).

Uses the synthetic fixture campaign. The offline version of these checks (fake
chat model, no key) is test_graph_lore_scoping.py.
"""
import pytest
from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI

from schemas import CombatGraphState, DamageType
from knowledge_engine import CombatKnowledgeBase
from combat_graph import create_combat_engine
from support import FIXTURE_CAMPAIGN_ID, FIXTURE_LORE_DIR, RULES_DIR, SENTINEL, release_kb

load_dotenv()


@pytest.fixture(scope="module")
def combat_engine(tmp_path_factory):
    test_db = str(tmp_path_factory.mktemp("graph_chroma"))
    kb = CombatKnowledgeBase(persist_dir=test_db, collection_name="test_graph_kb")
    kb.sync_campaign(str(FIXTURE_LORE_DIR), FIXTURE_CAMPAIGN_ID)
    kb.sync_rules(str(RULES_DIR))

    llm = ChatGoogleGenerativeAI(model="gemini-3.6-flash", streaming=True)
    yield create_combat_engine(kb=kb, llm=llm)

    release_kb(kb)


def test_combat_graph_execution(combat_engine):
    initial_state: CombatGraphState = {
        "encounter_id": "test_enc_01",
        "round": 1,
        "active_turn_index": 0,
        "combatants": [
            {
                "id": "enemy_1",
                "name": "Amber Quill Guard",
                "type": "enemy",
                "armor_class": 13,
                "max_hp": 20,
                "current_hp": 15,
                "conditions": [],
                "tactical_tags": ["Defensive"],
                "resources": {},
                # Must match the lore corpus's faction slug convention
                # (the fixture campaign's lore/factions/*.md), not the
                # human-readable name -- metadata filtering is an exact match.
                "faction": "amber_quill_chancery"
            }
        ],
        "last_event": {
            "target_id": "enemy_1",
            "damage_entries": [{"amount": 15, "damage_type": DamageType.SLASHING.value}],
            "condition_name": "Bleed",
            "condition_action": "add"
        },
        "gm_notes": "The guard is fighting on a crumbling rope bridge over a ravine.",
        # Owner mode: lore is only retrieved for an explicit campaign.
        "campaign_id": FIXTURE_CAMPAIGN_ID,
        "retrieved_lore": "",
        "streamed_narration": ""
    }

    final_state = combat_engine.invoke(initial_state)

    # 1. Verify deterministic state mutation
    target = final_state["combatants"][0]
    assert target["current_hp"] == 0
    assert "Incapacitated" in target["conditions"]
    assert "Bleed" in target["conditions"]

    # 2. Verify LlamaIndex retrieved context (campaign lore + public rules)
    assert len(final_state["retrieved_lore"]) > 0
    assert "Amber Quill" in final_state["retrieved_lore"]
    assert SENTINEL in final_state["retrieved_lore"]

    # 3. Verify narration output generated
    assert len(final_state["streamed_narration"]) > 0
