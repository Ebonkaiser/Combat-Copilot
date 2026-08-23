#!/bin/sh
set -e

# /tmp is world-writable (sticky bit), so the non-root user can create these
# at startup without needing them pre-chowned at build time.
mkdir -p /tmp/nginx/client_body /tmp/nginx/proxy /tmp/nginx/fastcgi /tmp/nginx/uwsgi /tmp/nginx/scgi

uvicorn server:app --host 127.0.0.1 --port 8000 &

exec nginx -g 'daemon off;'
