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
| Who | any visitor | someone who proved they are the owner (an authenticator-app code, or an emailed one) |
| Rules | public SRD rules | public SRD rules |
| Campaign lore | **never** | the selected campaign's lore only |
| Campaign switcher | not shown | yes: a campaign starts an *empty* encounter; its characters are a dropdown in **Add Combatant** (each once per encounter), never added automatically |
| Adding combatants | any named combatant | in a campaign, players come only from that dropdown; custom enemies/NPCs need a name. Nobody unnamed ("Unknown") is ever added |
| Encounters | public by id, idle ones are cleaned up (2 h, 200 max) | campaign encounters are private to the owner |

The mode is decided by the server on every request; the UI only mirrors it. Owner sign-in is passwordless: a 6-digit code -- from your authenticator app, or emailed -- is traded for a signed, HttpOnly, `SameSite=Strict` session cookie (7 days).

## Owner sign-in

The server picks the method from its configuration: set `OWNER_TOTP_SECRET` to use an **authenticator app** (recommended), or leave it out to use **emailed codes** (see *Email* under Deployment notes).

### Authenticator app

Nothing is sent anywhere, so no email provider and no DNS are involved.

1. On your own computer, make a secret and add it to your authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden, ...):

   ```bash
   python scripts/totp_setup.py --email you@example.com
   ```

   It shows a setup key (and a QR code if you `pip install qrcode`), asks for the 6-digit code your app then shows -- proof it works -- and only then prints the lines for the server. Save the setup key in your password manager.
2. Put the three printed lines (`OWNER_EMAILS`, `OWNER_TOTP_SECRET`, `SESSION_SECRET`) in the Droplet's `.env` and run `docker compose up -d` in that folder. This mode allows exactly one address in `OWNER_EMAILS`, and the sign-in form asks only for the code.
3. Sign in, over HTTPS, with the 6-digit code the app shows.

What the server does with it:

* It accepts the current 30-second code and one either side (clock drift), and each code only once, so a code seen over your shoulder is already useless.
* After 5 wrong codes in a row it locks sign-in for 15 minutes, then 30, 60, ... up to 24 hours if it keeps happening. A correct code resets it. The lock is for the whole server, not per visitor, so a guesser cannot spread attempts over many addresses; the flip side is that anyone can keep you locked out. `docker compose restart` clears it.
* The Droplet's clock must be right (check `timedatectl`): codes are computed from the time.

Lost phone: add the saved setup key to the new phone. No saved key: run `scripts/totp_setup.py` again, replace `OWNER_TOTP_SECRET` on the server and `docker compose up -d`.

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
| `OWNER_TOTP_SECRET` | sign in with an authenticator app (base32 key from `scripts/totp_setup.py`; exactly one address in `OWNER_EMAILS`). When set, the `EMAIL_*` settings are not used |
| `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` | emailed sign-in codes, used only without `OWNER_TOTP_SECRET` (Resend over HTTPS; `console` only in development) |
| `ALLOWED_ORIGINS` | cross-site origins allowed (empty in production: same-origin only) |
| `CAMPAIGNS_DIR` | where campaign folders live (default `./data/campaigns`) |

Owner mode stays off unless `OWNER_EMAILS`, a valid `SESSION_SECRET` and either a valid `OWNER_TOTP_SECRET` or a working email provider are all configured; the server logs why it is off (never including a secret).

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

Or with the authenticator-app form (one step, just the code; "Fill code (dev)" fills the code that would sign in right now):

```bash
ENV=development OWNER_EMAILS=owner@example.test \
SESSION_SECRET="$(python -c 'import secrets; print(secrets.token_urlsafe(48))')" \
OWNER_TOTP_SECRET="$(python -c 'import totp; print(totp.generate_secret())')" \
python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

## Tests

```bash
python -m pytest tests --ignore=tests/test_combat_graph.py --ignore=tests/test_knowledge_engine.py   # fast, offline, no key
python -m pytest tests/test_combat_graph.py tests/test_knowledge_engine.py tests/test_evals.py       # live tier: needs GOOGLE_API_KEY
cd frontend && npm test -- --watch=false --browsers=ChromeHeadlessCI                                 # Angular unit tests
cd frontend && npx playwright test                                                                    # e2e + axe contrast, offline AI
```

The end-to-end run starts its own isolated stacks -- one per sign-in method, on their own ports (4210/8010 emailed code, 4211/8011 authenticator app), with `FAKE_AI=1`, a throwaway database and the synthetic fixture campaign -- and needs no API key. The authenticator spec computes its codes with Node's crypto, independently of the server's Python. The tests use `tests/fixtures/campaigns/test-campaign/`, never real campaign content.

## Deployment notes

* **Single uvicorn worker.** Pending sign-in codes, rate-limit counters, the authenticator lockout and the last-used authenticator code live in process memory, so the entrypoint runs exactly one worker. Move that state to SQLite or Redis before ever raising it.
* **nginx must forward the original `Host` and the client address** (it does -- see `nginx.conf`): the backend's CSRF check compares a browser's `Origin` to the host it was addressed to, and its sign-in rate limits are per client address.
* **Enable owner mode only behind TLS.** Session cookies are `Secure`; sign-in over plain http would not work and must not be attempted over an untrusted network. The Droplet is plain http until TLS is set up.
* **Email (only if you do not use an authenticator app):** DigitalOcean blocks SMTP, so codes go out through Resend's HTTPS API. Verify a sending (sub)domain with Resend, create a *send-only* API key, and put it only in the Droplet's `.env`.
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
├── auth.py              # owner sign-in: codes, sessions, rate limits, lockout, Origin (CSRF) check
├── totp.py              # RFC 6238 authenticator-app codes (standard library only)
├── email_sender.py      # emailed sign-in code delivery (Resend / console)
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
└── scripts/             # provision-droplet.sh; totp_setup.py (authenticator enrolment, run on your computer)
```
