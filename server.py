import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Dict
from dotenv import load_dotenv

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse
from langchain_google_genai import ChatGoogleGenerativeAI

from schemas import EncounterState, DamageEvent, Combatant, EquipWeaponRequest
from auth import (
    OriginCheckMiddleware,
    cors_origins_from_env,
    create_auth_service,
    router as auth_router,
)
from campaigns import Campaign, load_campaigns
from knowledge_engine import CombatKnowledgeBase
from combat_graph import create_combat_engine
from persistence import StateStore
from state_engine import CombatStateEngine

load_dotenv()


def _configure_logging() -> None:
    """uvicorn configures only its own loggers, so without this the app's INFO lines -- which
    campaigns were synced, whether owner login is on and, if not, why -- never reach the
    container logs. Only the app's logger is touched: chromadb, httpx and friends stay quiet."""
    app_logger = logging.getLogger("combat_copilot")
    if app_logger.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s:     [%(name)s] %(message)s"))
    app_logger.addHandler(handler)
    app_logger.setLevel(logging.INFO)


_configure_logging()
logger = logging.getLogger("combat_copilot.server")

# Public SRD rules ship in the image. Campaign lore does NOT: it is private
# content mounted at CAMPAIGNS_DIR (see campaigns.py).
RULES_DIR = "./data/rules"


def _sync_knowledge(kb: CombatKnowledgeBase, campaigns: Dict[str, Campaign], rules_dir: str = RULES_DIR) -> None:
    """Brings the vector store in line with the files on disk: the SRD rules,
    then each loaded campaign's lore. Content that is already stored and
    unchanged costs no embedding calls; campaigns no longer on disk are purged."""
    if os.path.isdir(rules_dir):
        logger.info("SRD rules synced: %s", kb.sync_rules(rules_dir))
    else:
        # Loud, but not fatal: the app still works, just without rule text.
        # (Not purged either -- a missing directory here means a broken image or
        # working directory, not an intentional removal.)
        logger.error("Rules directory %s not found; SRD rules may be unavailable.", rules_dir)

    for campaign in campaigns.values():
        logger.info("Campaign %r lore synced: %s", campaign.id, kb.sync_campaign(str(campaign.lore_dir), campaign.id))

    purged = kb.purge_campaigns_except(campaigns.keys())
    if purged:
        logger.info("Purged stored content of campaigns no longer on disk: %s", ", ".join(purged))


def _fake_ai_enabled() -> bool:
    """FAKE_AI=1 swaps Gemini for an offline echo narrator and hashing embeddings, so CI and
    local end-to-end runs need no API key. Honoured only when ENV is development or test:
    in production the switch is ignored (and the modules behind it are not even in the image)."""
    if os.environ.get("FAKE_AI") != "1":
        return False
    env = (os.environ.get("ENV") or "production").strip().lower()
    if env not in ("development", "test"):
        logger.error("FAKE_AI=1 is ignored: it is only honoured when ENV is development or test.")
        return False
    return True


def _load_knowledge_and_engine(store: StateStore) -> dict:
    """Heavy, network-bound init: campaign registry, KB construction, content
    sync (batched, see knowledge_engine.py), LLM + combat engine.
    Run via asyncio.to_thread so it never blocks the event loop -- that's
    what lets /health keep responding while this is in flight."""
    campaigns = load_campaigns()
    chroma_dir = os.environ.get("CHROMA_DIR") or "./chroma_db"

    if _fake_ai_enabled():
        from fake_ai import EchoChatModel, HashingEmbedding  # dev/test only; not shipped in the image

        logger.warning("FAKE_AI=1: using the offline echo narrator and hashing embeddings.")
        # Its own collection: hashing vectors must never mix with real Gemini embeddings.
        kb = CombatKnowledgeBase(
            persist_dir=chroma_dir, collection_name="ttrpg_knowledge_fake_v2", embed_model=HashingEmbedding()
        )
        llm = EchoChatModel()
    else:
        kb = CombatKnowledgeBase(persist_dir=chroma_dir)
        # Temperature raised above the provider default (and explicit, rather than implicit)
        # for narration variety -- phrasing should never repeat itself, while the strict
        # no-invented-numbers rule is enforced by instruction + deterministic state, not sampling.
        llm = ChatGoogleGenerativeAI(model="gemini-3.6-flash", streaming=True, temperature=1.0)

    _sync_knowledge(kb, campaigns)
    combat_engine = create_combat_engine(kb=kb, llm=llm)
    return {"kb": kb, "llm": llm, "combat_engine": combat_engine, "campaigns": campaigns}


async def _run_startup(app: FastAPI) -> None:
    try:
        result = await asyncio.to_thread(_load_knowledge_and_engine, app.state.store)
        app.state.kb = result["kb"]
        app.state.llm = result["llm"]
        app.state.combat_engine = result["combat_engine"]
        app.state.campaigns = result.get("campaigns", {})
        app.state.ready = True
        logger.info("Backend startup complete: knowledge base and combat engine ready.")
    except Exception:
        # A fire-and-forget asyncio.create_task's exception is otherwise
        # only surfaced (if at all) as a lazy "Task exception was never
        # retrieved" warning on GC -- log it explicitly so a startup
        # failure is actually visible in container logs.
        logger.exception("Backend startup failed")
        app.state.startup_error = "Backend failed to start. Check server logs."


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Cheap, synchronous, no network -- CRUD routes work immediately
    # regardless of knowledge-base readiness.
    app.state.store = StateStore()
    # Config + in-memory sign-in state only: cheap, no network.
    app.state.auth = create_auth_service()
    app.state.kb = None
    app.state.llm = None
    app.state.combat_engine = None
    app.state.campaigns = {}
    app.state.ready = False
    app.state.startup_error = None

    # Deliberately NOT awaited before yield: uvicorn awaits lifespan
    # startup before it binds the listening socket, so awaiting the heavy
    # init here would just move the blocking, not remove it. Firing it as
    # a background task lets uvicorn bind immediately and serve /health
    # while ingestion is still running.
    startup_task = asyncio.create_task(_run_startup(app))

    yield

    if not startup_task.done():
        startup_task.cancel()
    app.state.auth.close()


app = FastAPI(title="AI Combat Copilot Engine", lifespan=lifespan)

# Added first => runs inside CORS: a foreign-Origin POST/PUT/DELETE is refused (403).
app.add_middleware(OriginCheckMiddleware)

# Sessions are cookies, so a wildcard origin would let any website act as the
# owner. Cross-site access is limited to ALLOWED_ORIGINS; in production that is
# empty (same-origin only: nginx serves the app and /api from one origin).
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins_from_env(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Accept"],
)

app.include_router(auth_router)


@app.get("/health")
async def health(request: Request):
    state = request.app.state
    if state.startup_error:
        return JSONResponse(status_code=503, content={"status": "error", "detail": state.startup_error})
    if not state.ready:
        return JSONResponse(status_code=503, content={"status": "starting"})
    return {"status": "ok"}


def _require_ready(request: Request):
    """Dependency for routes that need the combat engine -- everything
    else (encounter CRUD) is independent of knowledge-base readiness."""
    state = request.app.state
    if state.startup_error:
        raise HTTPException(status_code=503, detail="Backend failed to start. Check server logs.")
    if not state.ready:
        raise HTTPException(status_code=503, detail="Backend is still starting up (loading knowledge base). Try again shortly.")
    return state


@app.post("/encounters", response_model=EncounterState)
async def create_encounter(encounter: EncounterState, request: Request):
    """Registers a new encounter."""
    request.app.state.store.save_encounter(encounter)
    return encounter


@app.get("/encounters/{encounter_id}", response_model=EncounterState)
async def get_encounter(encounter_id: str, request: Request):
    """Retrieves an active encounter."""
    encounter = request.app.state.store.get_encounter(encounter_id)
    if not encounter:
        raise HTTPException(status_code=404, detail="Encounter not found")
    return encounter


@app.put("/encounters/{encounter_id}", response_model=EncounterState)
async def update_encounter(encounter_id: str, updated_state: EncounterState, request: Request):
    """Updates an active encounter state."""
    store = request.app.state.store
    if store.get_encounter(encounter_id) is None:
        raise HTTPException(status_code=404, detail="Encounter not found")
    store.save_encounter(updated_state)
    return updated_state


@app.put("/encounters/{encounter_id}/combatants/{combatant_id}/equipment", response_model=EncounterState)
async def equip_weapon(encounter_id: str, combatant_id: str, payload: EquipWeaponRequest, request: Request):
    """Deterministically sets a combatant's equipped weapon (state CRUD, no LLM involved)."""
    store = request.app.state.store
    encounter = store.get_encounter(encounter_id)
    if not encounter:
        raise HTTPException(status_code=404, detail="Encounter not found")

    CombatStateEngine.update_equipment(encounter, combatant_id, payload.weapon_name)
    store.save_encounter(encounter)
    return encounter


@app.post("/encounters/{encounter_id}/damage/stream")
async def apply_damage_and_stream(encounter_id: str, event: DamageEvent, state=Depends(_require_ready)):
    """
    Executes LangGraph mutation and streams token events via SSE.
    """
    store = state.store
    combat_engine = state.combat_engine

    encounter = store.get_encounter(encounter_id)
    if not encounter:
        raise HTTPException(status_code=404, detail="Encounter not found")

    graph_input = {
        "encounter_id": encounter_id,
        "round": encounter.round,
        "active_turn_index": encounter.active_turn_index,
        "combatants": [c.model_dump() for c in encounter.combatants],
        "last_event": event.model_dump(),
        "gm_notes": encounter.gm_notes,
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