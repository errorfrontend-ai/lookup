#!/bin/sh
# Runs the two fingerprint workers in one Render background worker (the showcase: one service instead of two).
# On Render the worker's database address is built from the database's parts, on its public host with TLS, its
# password URL-encoded; locally FINGERPRINT_DATABASE_URL is given as it is. If either worker stops, the other is
# stopped too and the service exits, so Render starts both again.
set -eu
if [ -n "${DATABASE_HOST:-}" ]; then
  password=$(python -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$LOOKUP_FINGERPRINT_WORKER_DATABASE_PASSWORD")
  FINGERPRINT_DATABASE_URL="postgresql://lookup_fingerprint_worker:${password}@${DATABASE_HOST}${DATABASE_HOST_SUFFIX:-}:${DATABASE_PORT:-5432}/${DATABASE_NAME}?sslmode=require"
  export FINGERPRINT_DATABASE_URL
  unset LOOKUP_FINGERPRINT_WORKER_DATABASE_PASSWORD password
fi
python -m workers.ingest &
ingest=$!
python -m workers.recognize &
recognize=$!
trap 'kill -TERM "$ingest" "$recognize" 2>/dev/null || true' TERM INT
while kill -0 "$ingest" 2>/dev/null && kill -0 "$recognize" 2>/dev/null; do
  sleep 5
done
kill -TERM "$ingest" "$recognize" 2>/dev/null || true
wait || true
exit 1
