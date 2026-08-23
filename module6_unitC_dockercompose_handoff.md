# Module 6 — Unit C Handoff: docker-compose Orchestration

**Project:** AI Combat Copilot & GM Assistant
**Status:** Modules 1–5 complete. Unit A (backend Dockerfile) and Unit B (frontend Dockerfile) handoffs already produced. This doc covers Unit C only: `docker-compose.yml`.

## Task

Write `docker-compose.yml` orchestrating the backend and frontend images from Units A and B. No compose syntax has been written yet — this doc is the spec.

## Decisions locked in during planning

**Services**
- Two services: `backend` and `frontend`. **No separate service for ChromaDB** — it runs file-backed (`PersistentClient`) inside the backend process, per the existing `knowledge_engine.py`; it only needs a persistent volume, not its own container.

**Networking — critical correction to Unit B's build-time URL**
- Compose's service-name DNS resolution (e.g. a backend service reachable at a hostname matching its service name) only works **container-to-container**. The Angular frontend's API calls happen in the **user's browser**, which is not part of the Docker network and cannot resolve compose service names.
- Therefore: the backend address baked into the frontend's JS bundle (Unit B) **must be the externally-exposed host:port** (whatever the backend service's port mapping resolves to from outside the Docker network) — **not** the internal service name. Get the port mapping decided here first, then confirm it matches what was passed as the frontend's build argument in Unit B.
- **Open item for Claude Code:** confirm the frontend build argument value matches the actual externally-mapped backend port defined in this compose file. These two decisions (Unit B's build arg, Unit C's port mapping) must agree or the browser will fail to reach the backend despite everything looking "healthy."

**Volumes**
- Mount a persistent location for the backend's ChromaDB directory so restarting the stack does not force re-ingestion of `data/lore/` and `data/rules/`. Either a Docker-managed named volume (more portable) or a host bind mount (easier manual inspection/backup) is acceptable — pick one deliberately, not by default.
- **Known gap to resolve or explicitly accept, not silently skip:** `server.py`'s `active_encounters` is currently an in-memory Python dict — there is no file being written for combat/encounter state today, despite the original README's "state is auto-saved, refresh loses zero data" invariant. A volume cannot persist something that was never being written to disk. Before finalizing this compose file, make an explicit call:
  - **(a) Accept the limitation for now** — document clearly that a container restart currently loses in-progress encounters, or
  - **(b) Wire up persistence first** — `create_combat_engine`'s `checkpointer` parameter already exists as a placeholder (currently always passed as `None`); implementing a real checkpointer (e.g. backed by SQLite) would be the prerequisite fix, with its own file then needing a volume mount alongside ChromaDB's.
  This decision should be made and stated before writing the compose file, not discovered later.

**Secrets**
- `GOOGLE_API_KEY` is injected into the **backend service only** via an env-file reference pointing at a gitignored `.env` — never written directly into the compose file.
- **Distinguish two different mechanisms that share a filename by convention:** a `.env` file sitting next to the compose file is auto-loaded by Compose for **substituting variables into the compose file's own syntax** (e.g. parameterizing an image tag) — this is different from a service's explicit env-file directive, which is what actually injects key/value pairs into that container's running environment. Don't conflate the two; be deliberate about which mechanism is being used for the API key.
- Frontend service needs no secrets at all, consistent with Unit B's build-time bake-in decision.

**Start ordering**
- A start-order dependency (backend before frontend) is reasonable but should not be treated as a readiness guarantee — it only guarantees the backend container has *started*, not that `uvicorn` inside it is actually accepting requests. This matters less here than in a typical service-with-a-database setup, since the frontend doesn't need the backend ready at its own startup (it just serves static files immediately) — it only needs the backend reachable later, when a user triggers a damage event. True readiness gating would require a health-check endpoint, which does not exist yet (flagged as a Unit D-adjacent open item, not solved here).

**Explicitly deferred, not decided in this pass**
- Single compose file vs. a base-plus-dev-override split (for hot-reload local development) — a workflow preference, not a correctness requirement. Revisit if local dev iteration on the containerized stack becomes painful.

## Definition of done / acceptance checklist

- [ ] Loading the frontend in a browser and triggering a damage event successfully reaches the backend — the real end-to-end test, not just confirming both containers report as running.
- [ ] Stopping and restarting the stack does **not** re-trigger full ChromaDB ingestion (confirms the volume mount is correctly targeting the persistent-client path used in `knowledge_engine.py`).
- [ ] An explicit, documented decision exists regarding the encounter-state persistence gap (accepted limitation, or checkpointer implemented) — not silently absent.
- [ ] `GOOGLE_API_KEY` does not appear as a literal value anywhere in `docker-compose.yml`.
- [ ] The frontend service definition contains no secret references at all.
- [ ] The backend's externally-mapped port matches the address baked into the frontend build in Unit B.

## Explicitly out of scope for this handoff

- CI pipeline steps, deployment target, health-check endpoint implementation — Unit D.
- Backend Dockerfile internals — Unit A (already handed off).
- Frontend Dockerfile internals, including the build-time API URL argument itself — Unit B (already handed off; this doc only reconciles it against the port mapping decided here).
