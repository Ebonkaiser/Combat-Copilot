# Module 6 — Droplet Provisioning Handoff (Prerequisite to Unit D)

**Project:** AI Combat Copilot & GM Assistant
**Status:** Units A (backend Dockerfile), B (frontend Dockerfile), C (docker-compose), and D (CI/CD pipeline) already handed off, all targeting a self-hosted DigitalOcean Droplet. A DigitalOcean App Platform path was briefly explored and explicitly rejected: App Platform has no persistent volumes at all (filesystem is wiped on every deploy/restart), which would have broken both the ChromaDB lore/rules index and any future encounter-state persistence. Reverting to the Droplet path means Units A–D stand exactly as already specified — this doc covers only the missing piece: **creating and provisioning the Droplet itself**, which Unit D's pipeline explicitly assumes already exists.

## Task

Create one DigitalOcean Droplet and perform its one-time bootstrap, so that Unit D's automated CI/CD pipeline has something correctly configured to deploy onto. This is primarily a console/manual task; only the bootstrap sequence itself is a candidate for scripting.

## Decisions locked in during planning

**Sizing**
- Workload is light (FastAPI + LangGraph + a ChromaDB index built from ~50 markdown files, serving one small app). Start with a modest plan (at least 1GB RAM, per DigitalOcean's own Docker-Droplet guidance) rather than over-provisioning. Droplets can be resized upward later without recreating them — treat this as a reversible decision, not a one-shot commitment.

**OS image**
- Use DigitalOcean's **Docker Marketplace 1-Click image** (Docker pre-installed on Ubuntu) rather than a plain Ubuntu image plus a manual Docker install. This collapses one of Unit D's flagged manual prerequisites ("installing Docker/docker-compose on the Droplet") to zero extra work.

**SSH key**
- Attach an SSH public key at Droplet-creation time. **This is the same credential Unit D's handoff doc already specifies as a GitHub Actions secret** — the private half of this exact key pair is what the CI/CD pipeline uses to connect. Set it up deliberately as a dedicated deploy credential, not a personal/throwaway key you'll need to swap later.

**Region**
- Low-stakes for this project's scale — pick based on proximity to you/your players. Not a correctness decision.

**Firewall**
- Use DigitalOcean's Cloud Firewall to restrict reachable ports to only what Unit C's port-mapping decision actually requires, plus SSH (22).
- **Known constraint, not a gap to try to close:** SSH cannot be meaningfully IP-restricted to "GitHub Actions only," since Actions runners don't have stable/restrictable IP ranges. The real protection here is the SSH key itself, not network-level restriction — don't spend effort trying to solve this a different way.

**One-time bootstrap sequence (must happen before Unit D's pipeline is trusted to deploy)**
1. Confirm Docker + Docker Compose are present (true by default via the marketplace image).
2. Perform a **one-time `docker login` to GHCR** on the Droplet, using a personal access token with package-read scope. Without this, Unit D's pipeline will build and push images successfully and then silently fail at the deploy step, because the Droplet was never authorized to pull them. This is the same gap already flagged in the Unit D handoff — this doc is where it actually gets resolved.
3. Place Unit C's `docker-compose.yml` and the gitignored `.env` (containing `GOOGLE_API_KEY`) onto the Droplet.
4. **Manually bring the stack up once, by hand**, before ever letting the automated pipeline touch it. This is the actual verification that steps 1–3 were done correctly.

**TLS/HTTPS — explicit gap, not silently deferred**
- Unlike the App Platform path (which handles certificates automatically), a self-managed Droplet makes TLS provisioning and renewal your responsibility — typically via Let's Encrypt, configured on whichever layer terminates traffic (likely the frontend's nginx from Unit B). Not solved in this pass; must be stated as a known open item, not silently absent.

**What's "code" here vs. what isn't**
- Droplet creation and SSH key attachment: console/CLI action, done once. Optionally scriptable later via Terraform for full infrastructure-as-code rigor — not necessary for a first pass.
- The bootstrap sequence (GHCR login, file placement, first manual start): shell commands, either typed by hand once or turned into a small reusable provisioning script with Claude Code if you expect to ever need to recreate this Droplet.

## Definition of done / acceptance checklist

- [ ] Droplet created, modestly sized, Docker confirmed present via the marketplace image.
- [ ] SSH key pair set up; private key saved as the exact GitHub Actions secret Unit D specifies.
- [ ] Cloud Firewall configured to expose only the ports Unit C's mapping requires, plus SSH.
- [ ] One-time GHCR login completed on the Droplet.
- [ ] `docker-compose.yml` and `.env` present on the server.
- [ ] Stack manually started once and confirmed reachable from a browser — not just "containers report running."
- [ ] A stated plan for TLS exists (even if "not yet implemented, tracked as follow-up") rather than being silently absent.

## Explicitly out of scope for this handoff

- Backend/frontend Dockerfile internals — Units A and B (already handed off).
- docker-compose service definitions — Unit C (already handed off).
- The automated CI/CD pipeline itself — Unit D (already handed off; this doc is its prerequisite).
- TLS/certificate implementation — flagged as an open gap, not solved here.
