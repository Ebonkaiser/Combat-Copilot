# Module 6 — Unit D Handoff: CI/CD Pipeline (GitHub Actions → DigitalOcean Droplet)

**Project:** AI Combat Copilot & GM Assistant
**Status:** Modules 1–5 complete. Units A (backend Dockerfile), B (frontend Dockerfile), and C (docker-compose) already handed off. This doc covers Unit D: the CI/CD pipeline, targeting a self-hosted DigitalOcean Droplet via SSH.

## Task

Write `.github/workflows/ci-cd.yml` implementing the pipeline described below. No workflow syntax has been written yet — this doc is the spec.

## Decisions locked in during planning

**Test suite is NOT uniformly CI-safe — this must shape the pipeline's structure**
- `test_state_engine.py` (Module 1) and 13 of the 14 tests in `test_evals.py` (Module 5) require **no network access and no API key** — deterministic, stub-based.
- `test_knowledge_engine.py` (Module 2) and `test_combat_graph.py` (Module 3) **require a live `GOOGLE_API_KEY` and network access** — they instantiate real `GoogleGenAIEmbedding`/`ChatGoogleGenerativeAI` calls with no stub path. `test_evals.py`'s one live smoke test is the same category, and auto-skips without a key.
- **Decision:** the free, deterministic tests (Module 1 + Module 5 core) are the **hard gate on every push/PR** — cheap, fast, never flaky. The API-dependent tests (Module 2, Module 3, and Module 5's live smoke test) run **less frequently** — recommended: only on merges to the main branch, not on every PR — to avoid burning API quota and inheriting Gemini's uptime as a dependency of every contributor's every push. **Open item for Claude Code:** confirm this split before writing the job structure; don't default to running everything on every push without this being a deliberate choice.

**Pipeline stages**
1. Trigger on push/PR.
2. Checkout.
3. Set up **both** Python and Node environments (both halves of the stack are under test).
4. Install from the **dev dependency manifest** (includes `pytest`) — this is intentionally different from Unit A's runtime-only manifest; CI and the shipped image have different needs.
5. Run the free/deterministic test tier as a hard gate. Nothing downstream executes if this fails.
6. (On the schedule decided above) run the API-dependent test tier, using `GOOGLE_API_KEY` from GitHub Actions repository secrets.
7. Build both Docker images (Units A and B), tagged with the **exact git commit SHA** — not a floating `latest` tag alone. SHA-tagging is what makes rollback later a precise, known action.
8. Push both images to **GitHub Container Registry** (natural default — already tied to the repo's GitHub identity, no separate registry account needed for the push side).
9. **Only on merges to main** (not every PR): deploy to the DigitalOcean Droplet.

**Deploy step (DigitalOcean Droplet, SSH-based)**
- Requires an SSH private key as a GitHub Actions secret. Flag explicitly: this credential is qualitatively bigger than the others in this project — it grants access to the whole machine, not one service — treat it accordingly (e.g. a deploy-scoped key if feasible, not a personal one).
- Deploy sequence: SSH in → pull the newly built images (the specific SHA tag that just passed the test gate) → recreate the containers from that tag via the existing docker-compose setup (Unit C) → prune old/unused image layers (small Droplets have limited disk — skipping this is a slow leak toward "disk full").
- Rollback = rerun this same sequence pointed at the previous known-good SHA tag instead of the current one. No separate rollback mechanism needed beyond this, provided SHA-tagging is actually in place.

**A second registry credential is required — this is not automatic**
- The GitHub Actions job's built-in credential for pushing to GHCR is scoped to the Actions run itself. The Droplet is a separate machine and has **no automatic way to pull** from GHCR. It needs its own registry login (a personal access token with package-read scope), performed **once, manually, before the first automated deploy** — not something the pipeline sets up on every run. **Open item for Claude Code / user:** confirm this one-time Droplet-side `docker login` to GHCR has actually been done before the deploy job is expected to work; the pipeline should not silently assume it.

**What this pipeline explicitly does NOT do (one-time manual prerequisites, not automated)**
- Installing Docker/docker-compose on the Droplet.
- Placing the initial `docker-compose.yml` and the gitignored `.env` (with `GOOGLE_API_KEY`) on the Droplet.
- The one-time GHCR login on the Droplet (above).
- These are provisioning steps done once by hand before this workflow can succeed — the workflow automates *redeploys of already-provisioned infrastructure*, not initial server setup. Don't let the workflow silently assume these exist without stating that assumption.

**Known, accepted limitation**
- A single-Droplet deploy via `docker-compose down`/`up` has a brief window of downtime during redeploy. No blue-green/rolling deployment without meaningfully more infrastructure (load balancer, multiple droplets) — accepted trade-off for this project's current scale, not something this pipeline needs to solve.

**Deferred, not solved in this pass**
- Post-deploy health verification (confirming the new containers actually respond before declaring success) depends on a health-check endpoint that doesn't exist yet in `server.py`. Worth adding eventually; not blocking for this pass. Note this gap in the workflow (e.g. a comment/TODO) rather than silently omitting the check with no trace of the decision.

## Definition of done / acceptance checklist

- [ ] Free/deterministic tests (Module 1 + Module 5 core) run and gate on every push/PR.
- [ ] An explicit, deliberate schedule exists for the API-dependent tests (Module 2, 3, and Module 5's live test) — not accidentally running on every push, and not accidentally never running.
- [ ] Both images build only after the hard test gate passes.
- [ ] Both images are tagged with the commit SHA, not only `latest`.
- [ ] Deploy job only triggers on merges to main, never on PR builds.
- [ ] `GOOGLE_API_KEY` and the SSH private key are both referenced only as named GitHub Actions secrets — never literal values in the workflow file.
- [ ] Deploy sequence includes pruning old images on the Droplet.
- [ ] Workflow file or accompanying docs explicitly state the one-time manual prerequisites (Docker/compose installed, GHCR login done, `.env` present on the Droplet) rather than assuming them silently.

## Explicitly out of scope for this handoff

- Health-check endpoint implementation in `server.py` — flagged as a future improvement, not part of this pipeline.
- Initial Droplet provisioning (OS setup, firewall rules, installing Docker itself) — one-time manual work, not automated here.
- Backend/frontend Dockerfile internals — Units A and B (already handed off).
- docker-compose service definitions — Unit C (already handed off).
