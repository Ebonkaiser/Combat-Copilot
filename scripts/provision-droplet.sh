#!/bin/sh
# One-time Droplet bootstrap (module6_droplet_provisioning_handoff.md).
#
# Run this from YOUR machine, not on the Droplet -- it drives everything
# over SSH/SCP. It automates steps 2-4 of the handoff's bootstrap sequence
# (GHCR login, placing docker-compose.yml + .env, first manual start).
# Step 1 (Droplet exists, Docker present) and the Cloud Firewall/SSH-key
# attachment are console actions this script cannot do for you -- see the
# provisioning checklist for those.
#
# PREREQUISITE ORDERING, not obvious from the handoff alone: the very first
# run of this script needs an image to already exist in GHCR to pull. That
# image is only published by Unit D's CI pipeline (job: build-and-push),
# which only runs on a push to main. So the real first-time order is:
#   1. Create the Droplet, attach the deploy public key (see checklist).
#   2. Push this repo to GitHub with the four Unit D secrets configured.
#   3. Wait for the CI run on main to finish (publishes the first image).
#   4. THEN run this script.
# Running it before step 3 will fail cleanly at `docker compose pull`
# with a clear "no such image" error, not silently.
#
# Usage:
#   DROPLET_HOST=1.2.3.4 DROPLET_USER=root GHCR_USERNAME=<github-username> \
#     GHCR_IMAGE=ghcr.io/<owner>/<repo> ./scripts/provision-droplet.sh
# GHCR_IMAGE must exactly match the lowercased owner/repo path Unit D's CI
# computed and pushed to (ci-cd.yml's "Compute lowercased image name" step)
# -- e.g. if your repo is github.com/DevinH/combat-copilot, that's
# ghcr.io/devinh/combat-copilot (all lowercase).
# You'll be prompted for the GHCR personal access token (package:read scope)
# interactively -- it's piped straight into `docker login` over SSH via
# stdin, never passed as a CLI argument or stored anywhere.

set -eu

: "${DROPLET_HOST:?Set DROPLET_HOST to the Droplet's IP or hostname}"
: "${DROPLET_USER:?Set DROPLET_USER (the marketplace image's default user, commonly root)}"
: "${GHCR_USERNAME:?Set GHCR_USERNAME to your GitHub username}"
: "${GHCR_IMAGE:?Set GHCR_IMAGE to ghcr.io/<owner>/<repo>, all lowercase -- must match what Unit D's CI pushed to}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

DEPLOY_KEY="${DEPLOY_KEY:-$HOME/.ssh/combat_copilot_deploy}"
REMOTE_DIR="${REMOTE_DIR:-combat-copilot}"
SSH="ssh -i $DEPLOY_KEY $DROPLET_USER@$DROPLET_HOST"
SCP="scp -i $DEPLOY_KEY"

if [ ! -f docker-compose.yml ] || [ ! -f .env ]; then
  echo "Run this from the repo root -- docker-compose.yml and .env must both be present locally." >&2
  exit 1
fi

echo "==> Confirming Docker is present on the Droplet"
$SSH "docker --version && docker compose version"

echo "==> Creating $REMOTE_DIR/ on the Droplet"
$SSH "mkdir -p $REMOTE_DIR"

echo "==> Copying docker-compose.yml and .env"
$SCP docker-compose.yml .env "$DROPLET_USER@$DROPLET_HOST:$REMOTE_DIR/"

# Compose auto-loads a .env sitting next to docker-compose.yml for variable
# substitution (${IMAGE_NAME}/${IMAGE_TAG} in the image: line) -- writing
# these here, not just exporting them for this one SSH session, means any
# FUTURE manual `docker compose` command on the Droplet also resolves the
# right image, not just this first run.
echo "==> Persisting IMAGE_NAME/IMAGE_TAG into the Droplet's .env"
$SSH "printf '\nIMAGE_NAME=%s\nIMAGE_TAG=%s\n' '$GHCR_IMAGE' '$IMAGE_TAG' >> $REMOTE_DIR/.env"

echo "==> GHCR login on the Droplet (personal access token, package:read scope)"
printf "GHCR token: " >&2
stty -echo 2>/dev/null || true
read -r GHCR_TOKEN
stty echo 2>/dev/null || true
echo >&2
echo "$GHCR_TOKEN" | $SSH "docker login ghcr.io -u $GHCR_USERNAME --password-stdin"
unset GHCR_TOKEN

echo "==> First manual start (pulling $GHCR_IMAGE:$IMAGE_TAG)"
$SSH "cd $REMOTE_DIR && docker compose pull && docker compose up -d"

echo "==> Sanity check from inside the Droplet"
$SSH "curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://localhost:8080/ || echo 'No response yet -- check: ssh in and run docker compose logs'"

echo "==> Done. Confirm it's reachable from a browser at http://$DROPLET_HOST:8080/ (or through your firewall's allowed port) before considering this verified."
