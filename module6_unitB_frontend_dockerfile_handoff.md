# Module 6 — Unit B Handoff: Frontend Dockerfile

**Project:** AI Combat Copilot & GM Assistant
**Stack (frontend):** Angular (standalone components), served as a compiled static SPA
**Status:** Modules 1–5 complete. Module 6 in progress — Unit A (backend Dockerfile) handoff already produced. This doc covers Unit B only: the frontend Dockerfile.

## Task

Write `frontend/Dockerfile` as a **multi-stage build**: a Node-based build stage that runs `ng build`, and a static-serving stage (nginx) that contains only the compiled output. No Dockerfile syntax has been written yet — this doc is the spec.

## Decisions locked in during planning

**Build shape**
- Stage 1 (`build`): Node base image; installs dependencies via the **clean-install** variant of the package manager (the one that installs strictly from the lockfile and fails if `package.json`/lockfile are out of sync — not the regular install command, which can silently modify the lockfile). Runs the Angular build, producing a `dist/` output folder.
- Stage 2 (`serve`): nginx base image. Copies **only** the `dist/` output from Stage 1 — nothing else crosses over (no `node_modules`, no Angular CLI, no `.ts` source, no lockfile). Final image contains zero Node.

**Base images**
- Build stage: pin a specific Node version matching what this Angular version's `package.json` actually requires — check the existing `package.json`'s engine constraints rather than assuming a version.
- Serve stage: an **Alpine-based nginx image is fine here** (unlike the backend's Python image) — nginx is a self-contained compiled binary with no glibc/wheel-compatibility concerns, so Alpine's smaller footprint is a genuine win in this stage specifically, not a risk.

**nginx configuration (must be authored and copied into the serve stage)**
- Must implement **SPA fallback routing**: any request path that doesn't match a real static file must fall back to serving `index.html`, so Angular's client-side router can take over. Without this, refreshing or directly navigating to any non-root route (e.g. a deep link into an encounter view) returns a 404 from nginx before Angular ever loads.
- Serve on the container's internal port 80 (standard). Whatever gets exposed externally is a docker-compose decision (Unit C), not this stage's concern.

**Backend API URL — build-time bake-in (deliberate choice, not an oversight)**
- Angular compiles to static JS; there is no running process in the final container that can read an environment variable at request time the way `server.py` can. Whatever backend address the app uses gets embedded into the compiled JS bundle **at `ng build` time**.
- For this project's scale (one frontend build feeding one specific backend deployment), the decision is: **bake the backend's address in at build time**, passed into the build stage as a build-time argument. This is *not* the same mechanism as the backend's `GOOGLE_API_KEY` (which must never be baked in) — the backend address is not a secret, so baking it in at build time is the correct and simpler choice here. Runtime-injected config (a small JS/JSON file generated at container startup) was considered and explicitly rejected for this pass as unnecessary complexity for a single-environment deployment.
- **Open item for Claude Code:** update `CombatService`'s hardcoded `http://localhost:8000` to read from Angular's build-time environment configuration instead, so the build-time argument actually has somewhere to flow into.

## What goes in the final (serve-stage) image

- Include: the compiled `dist/` output, the authored nginx config (with SPA fallback).
- Exclude: `node_modules`, Angular CLI, `.ts`/`.html`/`.scss` source files, `package.json`/lockfile, any test spec files.

## Definition of done / acceptance checklist

- [ ] Final image has no Node installed (checking for a Node binary inside the container should come back empty).
- [ ] Final image is dramatically smaller than the build stage (rough sanity check that nothing extra crossed over).
- [ ] Loading the app at a **non-root route directly** (not just navigating there client-side) works — confirms the nginx SPA fallback is correctly configured.
- [ ] Inspecting the compiled JS bundle shows the intended backend address baked in — confirms the build-time argument actually flowed through to `CombatService`.
- [ ] nginx serves on port 80 inside the container.
- [ ] Rebuilding after only a source (`.ts`) change reuses the cached dependency-install layer, not a full `npm` reinstall — confirms stage/COPY ordering is correct (same caching principle as Unit A).

## Explicitly out of scope for this handoff

- What host port the frontend gets mapped to, and how it reaches the backend container by service name rather than `localhost` — Unit C (docker-compose networking).
- CI pipeline steps that build this image — Unit D.
- Backend Dockerfile — Unit A (already handed off separately).
