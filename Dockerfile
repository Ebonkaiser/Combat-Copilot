# Single-container image: Angular HUD (static, served by nginx) + FastAPI
# backend (uvicorn), same origin, same container. nginx reverse-proxies
# /api/ to the backend over localhost -- see nginx.conf and entrypoint.sh.
#
# Build from the repo root:
#   docker build -t combat-copilot .

# ---- Stage 1: frontend-build ----
FROM node:22.23.2-bookworm-slim AS frontend-build

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ .
RUN npm run build

# ---- Stage 2: backend-deps ----
FROM python:3.12.6-slim-bookworm AS backend-deps

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ---- Stage 3: runtime ----
FROM python:3.12.6-slim-bookworm AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        nginx \
    && rm -rf /var/lib/apt/lists/*

COPY --from=backend-deps /install /usr/local

# Backend source (same exclusions as the original backend-only image: no
# tests/, eval_harness.py, .env, or chroma_db/ -- the latter is generated
# output that belongs in a volume, not the image).
COPY schemas.py state_engine.py knowledge_engine.py combat_graph.py server.py resilience.py persistence.py ./
COPY data/lore/ ./data/lore/
COPY data/rules/ ./data/rules/

# Compiled frontend + nginx config.
COPY --from=frontend-build /app/dist/frontend/browser /usr/share/nginx/html
COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Pre-create the volume mount points owned by appuser: a named volume's
# first mount copies whatever ownership already exists at that path in the
# image, otherwise Docker defaults it to root, which appuser can't write to.
RUN useradd --create-home --shell /usr/sbin/nologin appuser \
    && mkdir -p /app/chroma_db /app/state_db \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

# --start-period gives the container time for knowledge-base ingestion
# before failing healthchecks count against --retries. Uses python3
# (already in this image) via loopback -- no curl/wget dependency added.
# Goes through nginx (not uvicorn directly) so it also validates nginx is
# actually proxying, not just that uvicorn is up.
HEALTHCHECK --interval=5s --timeout=3s --start-period=90s --retries=3 \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3).status == 200 else 1)"

CMD ["/entrypoint.sh"]
