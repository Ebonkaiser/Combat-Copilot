"""Campaign API and mode enforcement (server.py): who may see which campaign, encounter and lore.

Offline. The knowledge base is real (HashingEmbedding over the fixture campaigns) and the
"LLM" is an echo model that repeats its prompt, so the narration streamed back over HTTP shows
exactly which lore the server let reach the model for a given caller.
"""
import json
import re
import shutil
import sqlite3
import threading
import time
from unittest.mock import MagicMock

import pytest

import server
from campaigns import load_campaigns
from combat_graph import create_combat_engine
from fake_ai import EchoChatModel, HashingEmbedding
from knowledge_engine import CombatKnowledgeBase
from persistence import ANONYMOUS_CAP, StateStore
from schemas import EncounterState
from support import (
    ALL_SENTINELS,
    FIXTURE_CAMPAIGN_DIR,
    FIXTURE_CAMPAIGN_ID,
    RULES_DIR,
    SENTINEL,
    SESSION_SECRET,
    owner_env,
    release_kb,
    sign_in,
)

OTHER_CAMPAIGN_ID = "alpha-camp"
OTHER_SENTINEL = "ALPHA_SENTINEL_9X2"
GUARD = {
    "id": "guard", "name": "Amber Quill Guard", "type": "enemy", "armor_class": 13,
    "max_hp": 20, "current_hp": 20, "faction": "amber_quill_chancery",
}
MISSING = {"detail": "Encounter not found"}


# ------------------------------------------------------------------- fixtures

@pytest.fixture
def campaigns_dir(tmp_path):
    """Two campaigns on disk: the fixture one, and a second with its own secret."""
    root = tmp_path / "campaigns"
    shutil.copytree(FIXTURE_CAMPAIGN_DIR, root / FIXTURE_CAMPAIGN_ID)
    other = root / OTHER_CAMPAIGN_ID
    (other / "lore").mkdir(parents=True)
    (other / "campaign.yaml").write_text(
        f"id: {OTHER_CAMPAIGN_ID}\nname: Alpha Campaign\ndescription: Second fixture.\n", encoding="utf-8"
    )
    (other / "roster.yaml").write_text(
        "combatants:\n  - {id: alpha_pc, name: Alpha Hero, type: player, armor_class: 11, max_hp: 9, current_hp: 9}\n",
        encoding="utf-8",
    )
    (other / "lore" / "alpha.md").write_text(
        f"---\nfaction: amber_quill_chancery\ntitle: Alpha\n---\n\n{OTHER_SENTINEL} amber quill chancery guards fire\n",
        encoding="utf-8",
    )
    return root


@pytest.fixture
def real_loader(tmp_path, campaigns_dir):
    """Startup with a real knowledge base over the fixture campaigns and an echo 'LLM'."""
    created = []

    def loader(store):
        kb = CombatKnowledgeBase(
            persist_dir=str(tmp_path / "api_chroma"), collection_name="api_kb", embed_model=HashingEmbedding()
        )
        created.append(kb)
        campaigns = load_campaigns(campaigns_dir)
        server._sync_knowledge(kb, campaigns, rules_dir=str(RULES_DIR))
        engine = create_combat_engine(kb=kb, llm=EchoChatModel())
        return {"kb": kb, "llm": None, "combat_engine": engine, "campaigns": campaigns}

    yield loader
    for kb in created:
        release_kb(kb)


@pytest.fixture
def gated_loader():
    """A startup that does not finish until the test ends, so 'not ready yet' is deterministic."""
    gate = threading.Event()

    def loader(store):
        gate.wait(15)
        return {"kb": MagicMock(), "llm": MagicMock(), "combat_engine": MagicMock(), "campaigns": {}}

    yield loader
    gate.set()


@pytest.fixture
def api(open_api, real_loader):
    return open_api(loader=real_loader, **owner_env())


@pytest.fixture
def owner_api(api):
    sign_in(api)
    return api


# -------------------------------------------------------------------- helpers

def create(api, **body):
    response = api.client.post("/encounters", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def create_with_guard(api, **body):
    return create(api, combatants=[GUARD], **body)


def parse_sse(text):
    events = []
    for block in re.split(r"\r?\n\r?\n", text.strip()):
        name, data = None, []
        for line in block.splitlines():
            if line.startswith("event:"):
                name = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data.append(line.split(":", 1)[1].strip())
        if name:
            events.append((name, "\n".join(data)))
    return events


def damage(api, encounter_id, target_id="guard"):
    body = {"target_id": target_id, "damage_entries": [{"amount": 5, "damage_type": "Fire"}]}
    return api.client.post(f"/encounters/{encounter_id}/damage/stream", json=body)


def narration(response) -> str:
    assert response.status_code == 200, response.text
    return "".join(json.loads(data)["token"] for name, data in parse_sse(response.text) if name == "narrative_chunk")


def stored(api, encounter_id):
    return api.client.app.state.store.get_encounter(encounter_id)


# =================================================================== /campaigns

def test_campaigns_require_the_owner(api):
    assert api.client.get("/campaigns").status_code == 401
    assert api.client.get(f"/campaigns/{FIXTURE_CAMPAIGN_ID}/roster").status_code == 401


def test_an_unknown_campaign_still_answers_401_to_anonymous_users(api):
    # No hint about which campaigns exist.
    assert api.client.get("/campaigns/no-such-campaign/roster").status_code == 401


def test_the_owner_lists_campaigns_by_name_with_nothing_else(owner_api):
    response = owner_api.client.get("/campaigns")

    assert response.status_code == 200
    assert response.json() == [
        {"id": OTHER_CAMPAIGN_ID, "name": "Alpha Campaign", "description": "Second fixture."},
        {"id": FIXTURE_CAMPAIGN_ID, "name": "Test Campaign", "description": "Synthetic fixture campaign for automated tests. Not real campaign content."},
    ]
    assert not any(s in response.text for s in (*ALL_SENTINELS, OTHER_SENTINEL))
    assert "roster" not in response.text and "fixtures" not in response.text  # no rosters, no paths


def test_the_owner_gets_a_campaign_roster(owner_api):
    response = owner_api.client.get(f"/campaigns/{FIXTURE_CAMPAIGN_ID}/roster")

    assert response.status_code == 200
    combatants = response.json()["combatants"]
    assert [c["id"] for c in combatants] == ["pc_fixture_hero", "npc_fixture_guard"]
    assert combatants[1]["faction"] == "amber_quill_chancery"
    assert combatants[1]["max_hp"] == combatants[1]["current_hp"] == 20


def test_an_unknown_campaign_roster_is_404_for_the_owner(owner_api):
    assert owner_api.client.get("/campaigns/no-such-campaign/roster").status_code == 404
    assert owner_api.client.get("/campaigns/..%2F..%2Fetc/roster").status_code == 404


def test_roster_responses_do_not_share_state_with_the_registry(owner_api):
    first = owner_api.client.get(f"/campaigns/{FIXTURE_CAMPAIGN_ID}/roster").json()
    first["combatants"][0]["name"] = "Tampered"

    second = owner_api.client.get(f"/campaigns/{FIXTURE_CAMPAIGN_ID}/roster").json()

    assert second["combatants"][0]["name"] == "Fixture Hero"


@pytest.mark.parametrize("how", ["logged out", "expired", "tampered"])
def test_campaign_routes_stop_working_when_the_session_does(owner_api, how):
    if how == "logged out":
        owner_api.client.post("/auth/logout")
    elif how == "expired":
        owner_api.clock.advance(8 * 24 * 3600)
    else:
        owner_api.client.cookies.set("cc_session", "tampered")

    assert owner_api.client.get("/campaigns").status_code == 401
    assert owner_api.client.get(f"/campaigns/{FIXTURE_CAMPAIGN_ID}/roster").status_code == 401


def test_campaign_routes_wait_for_startup_but_anonymous_users_are_refused_first(open_api, gated_loader):
    api = open_api(loader=gated_loader, ready=False, **owner_env())
    sign_in(api)

    assert api.client.get("/campaigns").status_code == 503
    api.client.post("/auth/logout")
    assert api.client.get("/campaigns").status_code == 401


# ============================================================ creating encounters

def test_an_anonymous_post_with_a_campaign_is_forbidden(api):
    response = api.client.post("/encounters", json={"campaign_id": FIXTURE_CAMPAIGN_ID})

    assert response.status_code == 403


def test_an_anonymous_post_cannot_name_an_unknown_campaign_either(api):
    assert api.client.post("/encounters", json={"campaign_id": "no-such-campaign"}).status_code == 403


def test_the_owner_creates_an_owner_scoped_campaign_encounter(owner_api):
    encounter = create(owner_api, campaign_id=FIXTURE_CAMPAIGN_ID, combatants=[GUARD])

    assert encounter["campaign_id"] == FIXTURE_CAMPAIGN_ID
    assert encounter["owner_scoped"] is True
    assert stored(owner_api, encounter["encounter_id"]).owner_scoped is True


def test_the_owner_cannot_attach_an_unknown_campaign(owner_api):
    response = owner_api.client.post("/encounters", json={"campaign_id": "no-such-campaign"})

    assert response.status_code == 404


def test_an_owner_encounter_without_a_campaign_is_an_ordinary_public_encounter(owner_api):
    encounter = create_with_guard(owner_api)

    assert encounter["campaign_id"] is None
    assert encounter["owner_scoped"] is False


def test_anonymous_encounters_are_forced_public_whatever_the_body_says(api):
    response = api.client.post("/encounters", json={"campaign_id": None, "owner_scoped": True, "combatants": []})

    assert response.status_code == 200
    assert response.json()["campaign_id"] is None
    assert response.json()["owner_scoped"] is False


def test_the_server_assigns_the_encounter_id_and_ignores_the_clients(api):
    first = create(api, encounter_id="enc_1")
    second = create(api, encounter_id="enc_1")

    assert first["encounter_id"] != "enc_1" != second["encounter_id"]
    assert re.fullmatch(r"enc_[0-9a-f]{32}", first["encounter_id"])
    assert first["encounter_id"] != second["encounter_id"]
    assert api.client.get("/encounters/enc_1").status_code == 404  # nothing was stored under the client's id


def test_an_empty_body_creates_a_default_encounter(api):
    encounter = create(api)

    assert (encounter["round"], encounter["combatants"], encounter["combat_started"]) == (1, [], False)


def test_creation_fields_round_trip(api):
    encounter = create(api, round=3, active_turn_index=1, gm_notes="fog", combat_started=True, combatants=[GUARD])

    assert (encounter["round"], encounter["active_turn_index"], encounter["gm_notes"], encounter["combat_started"]) == (3, 1, "fog", True)
    assert stored(api, encounter["encounter_id"]).combatants[0].name == "Amber Quill Guard"


# ========================================= owner-scoped encounters belong to the owner

@pytest.fixture
def scoped(owner_api):
    """An owner-scoped encounter, and the owner's session cookie to restore later."""
    encounter = create(owner_api, campaign_id=FIXTURE_CAMPAIGN_ID, combatants=[GUARD])
    return encounter["encounter_id"]


def requests_for(encounter_id):
    body = EncounterState(encounter_id=encounter_id).model_dump()
    return {
        "GET": ("get", f"/encounters/{encounter_id}", None),
        "PUT": ("put", f"/encounters/{encounter_id}", body),
        "equipment": ("put", f"/encounters/{encounter_id}/combatants/guard/equipment", {"weapon_name": "Sword"}),
        "damage stream": ("post", f"/encounters/{encounter_id}/damage/stream",
                          {"target_id": "guard", "damage_entries": [{"amount": 1, "damage_type": "Fire"}]}),
    }


@pytest.mark.parametrize("route", ["GET", "PUT", "equipment", "damage stream"])
def test_anonymous_users_get_404_for_an_owner_scoped_encounter(owner_api, scoped, route):
    method, path, body = requests_for(scoped)[route]
    owner_api.client.cookies.clear()

    response = getattr(owner_api.client, method)(path, **({"json": body} if body is not None else {}))

    assert response.status_code == 404
    assert response.json() == MISSING  # byte-for-byte what a nonexistent id answers


@pytest.mark.parametrize("route", ["GET", "PUT", "equipment", "damage stream"])
def test_the_404_for_a_private_encounter_matches_a_missing_one(owner_api, scoped, route):
    method, path, body = requests_for(scoped)[route]
    _, missing_path, _ = requests_for("enc_" + "0" * 32)[route]
    owner_api.client.cookies.clear()
    kwargs = {"json": body} if body is not None else {}
    missing_kwargs = {"json": {**body, "encounter_id": "enc_" + "0" * 32}} if route == "PUT" else kwargs

    private = getattr(owner_api.client, method)(path, **kwargs)
    missing = getattr(owner_api.client, method)(missing_path, **missing_kwargs)

    assert (private.status_code, private.text) == (missing.status_code, missing.text)


def test_the_owner_can_use_an_owner_scoped_encounter(owner_api, scoped):
    current = owner_api.client.get(f"/encounters/{scoped}")
    assert current.status_code == 200
    update = owner_api.client.put(f"/encounters/{scoped}", json={**current.json(), "round": 4})
    assert update.status_code == 200 and update.json()["round"] == 4
    equip = owner_api.client.put(f"/encounters/{scoped}/combatants/guard/equipment", json={"weapon_name": "Sword"})
    assert equip.status_code == 200


def test_an_owner_scoped_encounter_is_private_again_after_logout_or_expiry(owner_api, scoped):
    owner_api.client.post("/auth/logout")
    assert owner_api.client.get(f"/encounters/{scoped}").status_code == 404

    sign_in(owner_api)
    assert owner_api.client.get(f"/encounters/{scoped}").status_code == 200
    owner_api.clock.advance(8 * 24 * 3600)
    assert owner_api.client.get(f"/encounters/{scoped}").status_code == 404


def test_public_encounters_stay_open_to_anyone_with_the_id(owner_api):
    public = create_with_guard(owner_api)["encounter_id"]
    owner_api.client.cookies.clear()

    assert owner_api.client.get(f"/encounters/{public}").status_code == 200


# ============================================================ spoofing is pinned down

def test_put_cannot_attach_an_encounter_to_a_campaign(api):
    encounter = create_with_guard(api)
    encounter_id = encounter["encounter_id"]

    response = api.client.put(
        f"/encounters/{encounter_id}",
        json={**encounter, "campaign_id": FIXTURE_CAMPAIGN_ID, "owner_scoped": True},
    )

    assert response.status_code == 200
    assert response.json()["campaign_id"] is None and response.json()["owner_scoped"] is False
    after = stored(api, encounter_id)
    assert (after.campaign_id, after.owner_scoped) == (None, False)
    # ...and the attempt gains nothing end to end:
    assert not any(s in narration(damage(api, encounter_id)) for s in ALL_SENTINELS)


def test_put_cannot_detach_an_owner_scoped_encounter_from_its_campaign(owner_api, scoped):
    body = EncounterState(encounter_id=scoped, campaign_id=None, owner_scoped=False).model_dump()

    response = owner_api.client.put(f"/encounters/{scoped}", json=body)

    assert response.json()["campaign_id"] == FIXTURE_CAMPAIGN_ID
    assert response.json()["owner_scoped"] is True
    owner_api.client.cookies.clear()
    assert owner_api.client.get(f"/encounters/{scoped}").status_code == 404  # still private


def test_the_url_decides_which_encounter_a_put_writes(api):
    mine = create(api, gm_notes="mine")
    theirs = create(api, gm_notes="theirs")

    response = api.client.put(
        f"/encounters/{mine['encounter_id']}",
        json={**mine, "encounter_id": theirs["encounter_id"], "gm_notes": "overwritten?"},
    )

    assert response.json()["encounter_id"] == mine["encounter_id"]
    assert stored(api, mine["encounter_id"]).gm_notes == "overwritten?"
    assert stored(api, theirs["encounter_id"]).gm_notes == "theirs"


def test_put_cannot_overwrite_an_owner_scoped_encounter_through_the_body_id(owner_api, scoped):
    mine = create(owner_api, gm_notes="mine")
    owner_api.client.cookies.clear()

    response = owner_api.client.put(
        f"/encounters/{mine['encounter_id']}",
        json=EncounterState(encounter_id=scoped, gm_notes="pwned").model_dump(),
    )

    assert response.status_code == 200  # it just wrote to its own encounter
    assert stored(owner_api, scoped).gm_notes == ""
    assert stored(owner_api, mine["encounter_id"]).gm_notes == "pwned"


def test_put_cannot_create_an_encounter_under_a_chosen_id(api):
    response = api.client.put("/encounters/enc_chosen", json=EncounterState(encounter_id="enc_chosen").model_dump())

    assert response.status_code == 404
    assert api.client.get("/encounters/enc_chosen").status_code == 404


# ============================================================ end to end: which lore

def test_an_anonymous_damage_stream_never_carries_campaign_lore(api):
    encounter_id = create_with_guard(api)["encounter_id"]

    text = narration(damage(api, encounter_id))

    assert "--- LORE ---" in text and "--- RULES ---" in text  # the narration really is the model's prompt
    lore_section, rules_section = text.split("--- LORE ---")[1].split("--- RULES ---")
    assert lore_section.strip() == ""  # no lore at all for an anonymous encounter
    assert rules_section.strip() != ""  # the public rules still flow
    assert not any(s in text for s in (*ALL_SENTINELS, OTHER_SENTINEL))


def test_the_owner_encounter_streams_the_campaigns_lore_into_the_prompt(owner_api):
    encounter_id = create(owner_api, campaign_id=FIXTURE_CAMPAIGN_ID, combatants=[GUARD])["encounter_id"]

    text = narration(damage(owner_api, encounter_id))

    lore_section, rules_section = text.split("--- LORE ---")[1].split("--- RULES ---")
    assert SENTINEL in lore_section
    assert OTHER_SENTINEL not in text
    assert rules_section.strip() != ""


def test_each_campaign_gets_only_its_own_lore(owner_api):
    mine = create(owner_api, campaign_id=FIXTURE_CAMPAIGN_ID, combatants=[GUARD])["encounter_id"]
    other = create(owner_api, campaign_id=OTHER_CAMPAIGN_ID, combatants=[GUARD])["encounter_id"]

    mine_text, other_text = narration(damage(owner_api, mine)), narration(damage(owner_api, other))

    assert SENTINEL in mine_text and OTHER_SENTINEL not in mine_text
    assert OTHER_SENTINEL in other_text and SENTINEL not in other_text


def test_an_owner_encounter_without_a_campaign_gets_no_lore(owner_api):
    encounter_id = create_with_guard(owner_api)["encounter_id"]

    assert not any(s in narration(damage(owner_api, encounter_id)) for s in (*ALL_SENTINELS, OTHER_SENTINEL))


def test_the_stream_still_applies_the_state_change(owner_api):
    encounter_id = create(owner_api, campaign_id=FIXTURE_CAMPAIGN_ID, combatants=[GUARD])["encounter_id"]

    events = parse_sse(damage(owner_api, encounter_id).text)

    names = [name for name, _ in events]
    assert names[0] == "state_update" and names[-1] == "end"
    assert json.loads(events[0][1])["combatants"][0]["current_hp"] == 15
    assert stored(owner_api, encounter_id).combatants[0].current_hp == 15
    assert stored(owner_api, encounter_id).owner_scoped is True  # the save did not drop the scoping


def test_losing_the_session_mid_campaign_cuts_off_lore(owner_api):
    encounter_id = create(owner_api, campaign_id=FIXTURE_CAMPAIGN_ID, combatants=[GUARD])["encounter_id"]
    owner_api.client.post("/auth/logout")

    assert damage(owner_api, encounter_id).status_code == 404


def test_the_stream_is_503_before_startup_finishes_even_for_a_missing_encounter(open_api, gated_loader):
    api = open_api(loader=gated_loader, ready=False, **owner_env())

    assert damage(api, "enc_whatever").status_code == 503


# ===================================================================== eviction

def make_state(encounter_id, owner_scoped=False):
    return EncounterState(
        encounter_id=encounter_id,
        campaign_id=FIXTURE_CAMPAIGN_ID if owner_scoped else None,
        owner_scoped=owner_scoped,
    )


def age(store, encounter_id, hours):
    store._conn.execute(
        "UPDATE encounters SET updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now', ?) WHERE encounter_id = ?",
        (f"-{hours} hours", encounter_id),
    )
    store._conn.commit()


@pytest.fixture
def store(tmp_path):
    return StateStore(str(tmp_path / "store.db"))


def test_anonymous_encounters_idle_for_over_two_hours_are_evicted(store):
    store.save_encounter(make_state("old"))
    store.save_encounter(make_state("fresh"))
    age(store, "old", 2.5)

    assert store.evict_anonymous() == 1

    assert store.get_encounter("old") is None
    assert store.get_encounter("fresh") is not None


def test_an_encounter_just_inside_the_idle_limit_survives(store):
    store.save_encounter(make_state("recent"))
    age(store, "recent", 1.9)

    assert store.evict_anonymous() == 0


def test_a_write_counts_as_activity(store):
    store.save_encounter(make_state("busy"))
    age(store, "busy", 5)
    store.save_encounter(make_state("busy"))  # e.g. a PUT or a damage event

    assert store.evict_anonymous() == 0


def test_owner_scoped_encounters_are_never_evicted(store):
    store.save_encounter(make_state("private", owner_scoped=True))
    age(store, "private", 500)
    for i in range(5):
        store.save_encounter(make_state(f"anon{i}"))

    store.evict_anonymous(cap=1)

    assert store.get_encounter("private") is not None
    assert store.count_anonymous() == 1


def test_the_cap_keeps_the_most_recently_updated_anonymous_encounters(store):
    for i in range(4):
        store.save_encounter(make_state(f"e{i}"))
        time.sleep(0.003)
    store.save_encounter(make_state("e0"))  # touched last: now the most recent

    store.evict_anonymous(cap=2)

    survivors = {i for i in ("e0", "e1", "e2", "e3") if store.get_encounter(i)}
    assert survivors == {"e0", "e3"}


def test_the_default_cap_is_200():
    assert ANONYMOUS_CAP == 200


def test_creating_encounters_through_the_api_keeps_at_most_200_anonymous(api):
    first = create(api)["encounter_id"]
    ids = [create(api)["encounter_id"] for _ in range(ANONYMOUS_CAP + 4)]

    store = api.client.app.state.store
    assert store.count_anonymous() == ANONYMOUS_CAP
    assert store.get_encounter(first) is None  # the oldest went first
    assert store.get_encounter(ids[-1]) is not None


def test_creating_an_encounter_evicts_idle_ones(api):
    stale = create(api)["encounter_id"]
    age(api.client.app.state.store, stale, 3)

    create(api)

    assert api.client.get(f"/encounters/{stale}").status_code == 404


def test_the_owners_campaign_encounters_survive_anonymous_churn(owner_api, scoped):
    age(owner_api.client.app.state.store, scoped, 50)
    for _ in range(ANONYMOUS_CAP + 3):
        create(owner_api)

    assert owner_api.client.get(f"/encounters/{scoped}").status_code == 200


# ================================================================ schema migration

LEGACY_JSON = json.dumps({
    "encounter_id": "enc_legacy", "round": 2, "active_turn_index": 0, "combatants": [],
    "gm_notes": "from before owner mode", "combat_started": True,
})


def make_legacy_db(path):
    connection = sqlite3.connect(path)
    connection.execute(
        "CREATE TABLE encounters (encounter_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, "
        "updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
    )
    connection.execute("CREATE TABLE ingestion_state (category TEXT PRIMARY KEY, ingested_at TEXT NOT NULL DEFAULT (datetime('now')))")
    connection.execute("INSERT INTO ingestion_state (category) VALUES ('lore')")
    connection.execute("INSERT INTO encounters (encounter_id, state_json, updated_at) VALUES ('enc_legacy', ?, datetime('now'))", (LEGACY_JSON,))
    connection.execute("INSERT INTO encounters (encounter_id, state_json, updated_at) VALUES ('enc_ancient', ?, '2020-01-01 00:00:00')", (LEGACY_JSON.replace("legacy", "ancient"),))
    connection.commit()
    connection.close()


def test_an_older_database_gains_the_owner_scoped_column_and_keeps_its_rows(tmp_path):
    path = str(tmp_path / "legacy.db")
    make_legacy_db(path)

    store = StateStore(path)

    columns = {row[1] for row in store._conn.execute("PRAGMA table_info(encounters)")}
    assert "owner_scoped" in columns
    legacy = store.get_encounter("enc_legacy")
    assert (legacy.gm_notes, legacy.combat_started, legacy.campaign_id, legacy.owner_scoped) == (
        "from before owner mode", True, None, False,
    )


def test_old_rows_are_treated_as_anonymous_and_age_out_normally(tmp_path):
    path = str(tmp_path / "legacy.db")
    make_legacy_db(path)
    store = StateStore(path)

    store.evict_anonymous()

    assert store.get_encounter("enc_ancient") is None  # idle since 2020
    assert store.get_encounter("enc_legacy") is not None


def test_the_migration_is_idempotent_and_leaves_the_old_flag_table_alone(tmp_path):
    path = str(tmp_path / "legacy.db")
    make_legacy_db(path)

    StateStore(path)
    store = StateStore(path)  # opened a second time

    assert store._conn.execute("SELECT category FROM ingestion_state").fetchall() == [("lore",)]
    assert store.get_encounter("enc_legacy") is not None


def test_a_fresh_database_has_the_column_from_the_start(store):
    assert "owner_scoped" in {row[1] for row in store._conn.execute("PRAGMA table_info(encounters)")}


def test_owner_scoped_is_saved_in_the_column_that_eviction_reads(store):
    store.save_encounter(make_state("private", owner_scoped=True))
    store.save_encounter(make_state("public"))

    rows = dict(store._conn.execute("SELECT encounter_id, owner_scoped FROM encounters").fetchall())

    assert rows == {"private": 1, "public": 0}
