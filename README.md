# AI Combat Copilot & GM Assistant

An interactive, deterministic combat copilot and narrative assistant for tabletop RPGs. The system decouples state management (HP, turns, conditions) from generative LLM text, using **LangGraph** for deterministic workflow orchestration and **LlamaIndex** for metadata-filtered RAG over campaign lore and rules.

---

## Architecture

* **Frontend:** Angular combat HUD (sepia, WCAG-AA design tokens) with real-time SSE streaming.
* **Orchestration & state (LangGraph):** deterministic HP mutations, turn cycles, condition lifecycles, and narrative chaining -- no probabilistic math errors.
* **Knowledge layer (LlamaIndex + ChromaDB):** public SRD rules plus per-campaign private lore, every chunk tagged with the campaign it belongs to and every query filtered by it.
* **Inference layer:** LCEL streaming pipeline for narration and GM tactical advisories via Gemini.
* **One container:** nginx serves the compiled app and reverse-proxies `/api/` to uvicorn (FastAPI) on localhost, so browser and API share one origin.

## Two modes

| | **Anonymous** (default) | **Owner** |
|---|---|---|
| Who | any visitor | someone who proved control of an allowlisted email address |
| Rules | public SRD rules | public SRD rules |
| Campaign lore | **never** | the selected campaign's lore only |
| Campaign switcher | not shown | yes: a campaign starts an *empty* encounter; its characters are a dropdown in **Add Combatant** (each once per encounter), never added automatically |
| Adding combatants | any named combatant | in a campaign, players come only from that dropdown; custom enemies/NPCs need a name. Nobody unnamed ("Unknown") is ever added |
| Encounters | public by id, idle ones are cleaned up (2 h, 200 max) | campaign encounters are private to the owner |

The mode is decided by the server on every request; the UI only mirrors it. Owner sign-in is passwordless: an emailed 6-digit code (10 minutes, single use, 5 attempts) is traded for a signed, HttpOnly, `SameSite=Strict` session cookie (7 days).

## Campaign content (private)

Campaign lore and rosters are **not in git and not in the Docker image** -- this repo and its image are public. Each campaign is a folder under `data/campaigns/` (locally) or `./campaigns/` next to `docker-compose.yml` (Droplet, bind-mounted read-only):

```text
data/campaigns/<slug>/            slug: [a-z0-9-]+, must equal the id below ("srd" is reserved)
├── campaign.yaml                 id, name, description
├── roster.yaml                   the campaign's characters: a pick-list for Add Combatant (validated against the Combatant model)
└── lore/**/*.md                  markdown with optional YAML frontmatter (faction, title, tags, ...)
```

```yaml
# campaign.yaml                    # roster.yaml
id: light-and-magic                combatants:
name: Light and Magic                - id: npc_guard
description: Short line for the        name: Amber Quill Guard
  switcher                             type: enemy
                                       armor_class: 13
                                       max_hp: 20
                                       current_hp: 20
                                       faction: amber_quill_chancery   # a lore faction slug (exact match)
```

Lore is synced into the vector store at startup by content hash: unchanged files cost nothing, edited files are re-embedded, deleted files are removed. A bad campaign folder is logged and skipped; the others still load. Restart the backend (or container) after editing.

## Configuration

Copy `.env.example` to `.env` and fill it in (never commit `.env`). Key settings:

| Variable | Purpose |
|---|---|
| `GOOGLE_API_KEY` | Gemini (narration + embeddings) |
| `ENV` | `production` (default) \| `development` \| `test`. `development` is for your own machine only |
| `OWNER_EMAILS`, `SESSION_SECRET` | enable owner mode (allowlist; >= 32 random bytes) |
| `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` | how sign-in codes are delivered (Resend over HTTPS; `console` only in development) |
| `ALLOWED_ORIGINS` | cross-site origins allowed (empty in production: same-origin only) |
| `CAMPAIGNS_DIR` | where campaign folders live (default `./data/campaigns`) |

Owner mode stays off unless `OWNER_EMAILS`, a valid `SESSION_SECRET` and a working email provider are all configured; the server logs why it is off.

## Running locally

```bash
pip install -r requirements.txt
python -m uvicorn server:app --host 127.0.0.1 --port 8000      # needs GOOGLE_API_KEY in .env
cd frontend && npm ci && npx ng serve                           # http://localhost:4200, /api proxied to :8000
```

To try owner mode locally, pass the settings on the command line instead of putting them in `.env` (the sign-in code is then logged, and the login dialog offers a "Fill code (dev)" button):

```bash
ENV=development OWNER_EMAILS=owner@example.test \
SESSION_SECRET="$(python -c 'import secrets; print(secrets.token_urlsafe(48))')" \
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

## Tests

```bash
python -m pytest tests --ignore=tests/test_combat_graph.py --ignore=tests/test_knowledge_engine.py   # fast, offline, no key
python -m pytest tests/test_combat_graph.py tests/test_knowledge_engine.py tests/test_evals.py       # live tier: needs GOOGLE_API_KEY
cd frontend && npm test -- --watch=false --browsers=ChromeHeadlessCI                                 # Angular unit tests
cd frontend && npx playwright test                                                                    # e2e + axe contrast, offline AI
```

The end-to-end run starts its own isolated stack (own ports, `FAKE_AI=1`, throwaway database, the synthetic fixture campaign) and needs no API key. The tests use `tests/fixtures/campaigns/test-campaign/`, never real campaign content.

## Deployment notes

* **Single uvicorn worker.** Pending sign-in codes and rate-limit counters live in process memory, so the entrypoint runs exactly one worker. Move that state to SQLite or Redis before ever raising it.
* **nginx must forward the original `Host` and the client address** (it does -- see `nginx.conf`): the backend's CSRF check compares a browser's `Origin` to the host it was addressed to, and its sign-in rate limits are per client address.
* **Enable owner mode only behind TLS.** Session cookies are `Secure`; sign-in over plain http would not work and must not be attempted over an untrusted network. The Droplet is plain http until TLS is set up.
* **Email:** DigitalOcean blocks SMTP, so codes go out through Resend's HTTPS API. Verify a sending (sub)domain with Resend, create a *send-only* API key, and put it only in the Droplet's `.env`.
* **Sessions are stateless signed tokens**: logging out clears the cookie; changing `SESSION_SECRET` signs everyone out.
* **Campaign content on the Droplet:** the CI deploy ships the image only -- it never copies your campaigns, and it never updates the Droplet's `docker-compose.yml` (copy that over by hand when it changes, e.g. to gain the `./campaigns` mount). `scripts/provision-droplet.sh` copies local `data/campaigns/` to `~/combat-copilot/campaigns/`, but it also overwrites the Droplet's `.env`, so for later lore edits use just the copy step, then restart the container:

  ```bash
  tar -C data/campaigns -cz . | ssh -i ~/.ssh/combat_copilot_deploy root@<droplet-ip> \
    "rm -rf ~/combat-copilot/campaigns && mkdir -p ~/combat-copilot/campaigns && tar -C ~/combat-copilot/campaigns -xz && chmod -R a+rX ~/combat-copilot/campaigns && cd ~/combat-copilot && docker compose restart"
  ```

## Repository layout

```text
combat-copilot/
├── server.py            # FastAPI app: encounters, campaigns, SSE damage stream
├── auth.py              # owner sign-in: codes, sessions, rate limits, Origin (CSRF) check
├── email_sender.py      # sign-in code delivery (Resend / console)
├── campaigns.py         # campaign registry (campaign.yaml + roster.yaml validation)
├── knowledge_engine.py  # LlamaIndex + ChromaDB: content-hash sync, campaign-scoped retrieval
├── combat_graph.py      # LangGraph nodes and compilation
├── state_engine.py      # deterministic state mutations
├── persistence.py       # SQLite encounter store (+ idle/cap eviction of anonymous encounters)
├── schemas.py           # Pydantic contracts and graph state
├── fake_ai.py           # offline stand-ins for CI/e2e (never in the image)
├── data/rules/          # public SRD rules (ships in the image)
├── data/campaigns/      # PRIVATE campaign content (git-ignored, not in the image)
├── tests/               # pytest suites; tests/fixtures/campaigns/ is synthetic
├── frontend/            # Angular app, Karma specs, Playwright e2e (frontend/e2e)
├── Dockerfile, nginx.conf, entrypoint.sh, docker-compose.yml
└── scripts/provision-droplet.sh
```
