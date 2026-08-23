import pytest
from dotenv import load_dotenv
from langchain_google_genai import ChatGoogleGenerativeAI

from schemas import CombatGraphState, DamageType
from knowledge_engine import CombatKnowledgeBase
from combat_graph import create_combat_engine

load_dotenv()


@pytest.fixture(scope="module")
def combat_engine(tmp_path_factory):
    test_db = str(tmp_path_factory.mktemp("graph_chroma"))
    kb = CombatKnowledgeBase(persist_dir=test_db, collection_name="test_graph_kb")
    kb.ingest_directory("./data/lore", category="lore")
    kb.ingest_directory("./data/rules", category="rules")
    
    llm = ChatGoogleGenerativeAI(model="gemini-3.6-flash", streaming=True)
    return create_combat_engine(kb=kb, llm=llm)


def test_combat_graph_execution(combat_engine):
    initial_state: CombatGraphState = {
        "encounter_id": "test_enc_01",
        "round": 1,
        "active_turn_index": 0,
        "combatants": [
            {
                "id": "enemy_1",
                "name": "Iron Silk Guard",
                "type": "enemy",
                "armor_class": 13,
                "max_hp": 20,
                "current_hp": 15,
                "conditions": [],
                "tactical_tags": ["Defensive"],
                "resources": {},
                "faction": "Iron Silk"
            }
        ],
        "last_event": {
            "target_id": "enemy_1",
            "damage_amount": 15,
            "damage_type": DamageType.SLASHING.value,
            "applied_conditions": ["Bleed"]
        },
        "retrieved_lore": "",
        "streamed_narration": ""
    }

    final_state = combat_engine.invoke(initial_state)

    # 1. Verify deterministic state mutation
    target = final_state["combatants"][0]
    assert target["current_hp"] == 0
    assert "Incapacitated" in target["conditions"]
    assert "Bleed" in target["conditions"]

    # 2. Verify LlamaIndex retrieved context
    assert len(final_state["retrieved_lore"]) > 0
    assert "Iron Silk" in final_state["retrieved_lore"]

    # 3. Verify narration output generated
    assert len(final_state["streamed_narration"]) > 0