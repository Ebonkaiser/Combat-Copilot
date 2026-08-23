# Module 6 — Unit A Handoff: Backend Dockerfile

**Project:** AI Combat Copilot & GM Assistant
**Stack (backend):** FastAPI, LangGraph, LlamaIndex, ChromaDB, `langchain-google-genai` / `google-genai` (Gemini), `sse-starlette`
**Status:** Modules 1–5 complete (state engine, RAG knowledge base, LangGraph + SSE backend, Angular HUD, eval harness/offline resilience). Module 6 (Containerization & Deployment) in progress.
**This doc covers:** Unit A only — the backend Dockerfile. Frontend (Unit B), docker-compose (Unit C), and CI/CD (Unit D) are separate, later handoffs.

## Task

Write `backend/Dockerfile` as a **multi-stage build** (builder stage + runtime stage) implementing the decisions below. This doc is the spec — the actual Dockerfile syntax hasn't been written yet.

## Decisions locked in during planning

**Build shape**
- Two stages: `builder` (installs dependencies) and a final runtime stage.
- Copy the dependency manifest and install *before* copying application source code, so source-only changes don't invalidate the dependency-install cache layer.
- Both stages must use the **same base image identity** (not just similar) — some dependencies (ChromaDB's HNSW indexing) compile C extensions, and a mismatch between builder and runtime OS versions can cause a binary-compatibility failure at container startup that won't show up at build time.

**Base image**
- Use a **slim, Debian-based Python image** (glibc), not Alpine (musl) and not a distroless image for this first pass. Reasoning: this stack's dependencies (ChromaDB, LlamaIndex sub-packages) rely on prebuilt binary wheels built against glibc/manylinux; Alpine forces source compilation and can fail outright. Distroless is a good hardening step later, not for a first working build (no shell to debug into if something's wrong).
- Pin to a **specific, non-floating version tag** (exact Python patch version + specific Debian release name), not a loose/floating tag — reproducibility is the whole point of this exercise. Digest-pinning (exact content hash) is a further-hardening option, not required for this pass.
- **Open item for Claude Code:** confirm and choose the exact tag string (Python version to target should match whatever version the project has been developed against so far — check for an existing `.python-version` or prior `pip`/venv setup before assuming).

**Dependency management**
- Split into two manifests:
  - **Runtime manifest** (what actually ships): FastAPI, `uvicorn`, `sse-starlette`, `langgraph`, `langchain-core`, `langchain-google-genai`, `google-genai`, LlamaIndex core + `llama-index-vector-stores-chroma` + `llama-index-embeddings-google-genai`, `chromadb`, `python-dotenv`, `pydantic`.
  - **Dev manifest**: runtime manifest + `pytest` (used for local dev / CI, not the image).
- The **builder stage installs only from the runtime manifest**. `pytest` must never appear in the built image — this is the actual enforcement mechanism for keeping dev tooling out, not just a naming convention.
- **Open item for Claude Code:** dependencies have so far been installed unpinned (`pip install <package>` with no version). Before writing the Dockerfile, generate a pinned `requirements.txt` (exact versions) from the current known-working environment, and use that as the manifest that gets copied/installed. This directly avoids repeating the `google-generativeai`→`google-genai` and `gemini-1.5-flash`→`gemini-2.0-flash` breakage already hit earlier in this project.

**What goes in the runtime image (copied in after dependency install)**
- Include: `schemas.py`, `state_engine.py`, `knowledge_engine.py`, `combat_graph.py`, `server.py`, `resilience.py`, `data/lore/`, `data/rules/`.
- Exclude: `eval_harness.py` (test/dev-only, not imported by `server.py`'s runtime path), `tests/`, any `.env` file, `chroma_db/` (this is *generated output* from ingestion, not source — must not be baked into the image; it belongs in a volume, which is Unit C's concern, but the Dockerfile shouldn't `COPY` it in the first place).

**Startup command (runtime stage)**
- Must be the **production** `uvicorn` invocation, not the dev one used so far (`--reload`) — drop `--reload` entirely (it watches the filesystem and restarts on change; meaningless overhead in a fixed, already-built image).
- Must bind to `0.0.0.0`, not `127.0.0.1`/`localhost` — binding to localhost inside a container makes it unreachable from outside that same container, including from docker-compose's network or the host. This is a common silent failure (`docker ps` shows healthy, curl from outside gets nothing).
- Worker count: single worker is fine for now. Multi-worker is a later scaling knob, not needed for this pass — don't over-engineer it here.

**Secrets**
- `GOOGLE_API_KEY` must **never** appear in a Dockerfile instruction (build args or otherwise) — image layers are inspectable, and values from earlier layers persist even if a later instruction appears to remove them. It is injected at container **run time** via docker-compose's env file mechanism (Unit C), not baked in here. The Dockerfile should not reference its value at all.

**Hardening (include, but low-risk to get slightly wrong on a first pass)**
- Create and switch to a non-root user near the end of the runtime stage, before the startup command.

## Definition of done / acceptance checklist

Once `backend/Dockerfile` exists, verify:
- [ ] `docker build` succeeds without falling back to source-compiling ChromaDB or any other dependency (a sign the base image choice was wrong).
- [ ] Inspecting the built image's installed packages shows **no `pytest`** present.
- [ ] Image contains `data/lore/` and `data/rules/` but does **not** contain `tests/`, `eval_harness.py`, `.env`, or a `chroma_db/` directory.
- [ ] Running the container and hitting it from **outside** the container (not `docker exec` in) gets a response — confirms the `0.0.0.0` bind actually took effect.
- [ ] Process inside the container is not running as root (`docker exec <container> whoami` should not print `root`).
- [ ] Rebuilding after only editing a source file (not `requirements.txt`) reuses the cached dependency-install layer — confirms the COPY/install ordering is correct.

## Explicitly out of scope for this handoff

- Persistent volumes for `chroma_db/` and any SQLite state file — Unit C (docker-compose).
- Passing `GOOGLE_API_KEY` into the running container — Unit C (docker-compose env file).
- Health-check endpoint wiring, CI pipeline, deployment target — Unit D.
- Frontend Dockerfile — Unit B (separate handoff).
