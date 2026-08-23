import os
import json
from typing import AsyncGenerator
from dotenv import load_dotenv

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from langchain_google_genai import ChatGoogleGenerativeAI

from schemas import EncounterState, DamageEvent, Combatant
from knowledge_engine import CombatKnowledgeBase
from combat_graph import create_combat_engine
from persistence import StateStore

load_dotenv()

app = FastAPI(title="AI Combat Copilot Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Durable storage for encounter state, surviving process restarts.
store = StateStore()

# Initialize Knowledge Base & LLM
kb = CombatKnowledgeBase()
# Pre-ingest initial lore/rules, once per category ever (not on every restart).
if not store.is_category_ingested("lore"):
    kb.ingest_directory("./data/lore", category="lore")
    store.mark_category_ingested("lore")
if not store.is_category_ingested("rules"):
    kb.ingest_directory("./data/rules", category="rules")
    store.mark_category_ingested("rules")

llm = ChatGoogleGenerativeAI(
    model="gemini-3.6-flash",
    streaming=True
)

combat_engine = create_combat_engine(kb=kb, llm=llm)


@app.post("/encounters", response_model=EncounterState)
async def create_encounter(encounter: EncounterState):
    """Registers a new encounter."""
    store.save_encounter(encounter)
    return encounter


@app.get("/encounters/{encounter_id}", response_model=EncounterState)
async def get_encounter(encounter_id: str):
    """Retrieves an active encounter."""
    encounter = store.get_encounter(encounter_id)
    if not encounter:
        raise HTTPException(status_code=404, detail="Encounter not found")
    return encounter


@app.put("/encounters/{encounter_id}", response_model=EncounterState)
async def update_encounter(encounter_id: str, updated_state: EncounterState):
    """Updates an active encounter state."""
    if store.get_encounter(encounter_id) is None:
        raise HTTPException(status_code=404, detail="Encounter not found")
    store.save_encounter(updated_state)
    return updated_state


@app.post("/encounters/{encounter_id}/damage/stream")
async def apply_damage_and_stream(encounter_id: str, event: DamageEvent):
    """
    Executes LangGraph mutation and streams token events via SSE.
    """
    encounter = store.get_encounter(encounter_id)
    if not encounter:
        raise HTTPException(status_code=404, detail="Encounter not found")

    graph_input = {
        "encounter_id": encounter_id,
        "round": encounter.round,
        "active_turn_index": encounter.active_turn_index,
        "combatants": [c.model_dump() for c in encounter.combatants],
        "last_event": event.model_dump(),
        "retrieved_lore": "",
        "streamed_narration": ""
    }

    async def event_generator() -> AsyncGenerator[dict, None]:
        async for event_chunk in combat_engine.astream_events(graph_input, version="v2"):
            kind = event_chunk["event"]

            # Emit updated state immediately after mutation node finishes
            if kind == "on_chain_end" and event_chunk["name"] == "mutate_state":
                updated_state = event_chunk["data"]["output"]
                encounter.combatants = [Combatant(**c) for c in updated_state["combatants"]]
                store.save_encounter(encounter)
                yield {
                    "event": "state_update",
                    "data": json.dumps({"combatants": updated_state["combatants"]})
                }

            # Emit streaming LLM tokens
            elif kind == "on_chat_model_stream":
                chunk_content = event_chunk["data"]["chunk"].content
                if chunk_content:
                    if isinstance(chunk_content, list):
                        # Extract and concatenate text from block objects
                        token = "".join(item.get("text", "") for item in chunk_content if isinstance(item, dict) and item.get("type") == "text")
                    else:
                        token = chunk_content
                    yield {
                        "event": "narrative_chunk",
                        "data": json.dumps({"token": token})
                    }

            elif kind == "on_chain_end" and event_chunk["name"] == "LangGraph":
                yield {
                    "event": "end",
                    "data": "[DONE]"
                }

    return EventSourceResponse(event_generator())