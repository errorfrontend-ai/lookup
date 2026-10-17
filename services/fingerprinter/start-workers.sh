#!/bin/sh
# Runs the two fingerprint workers in one Render background worker (the showcase: one service instead of two).
# On Render the worker's database address is built from the database's parts, on its public host with TLS, its
# password URL-encoded; locally FINGERPRINT_DATABASE_URL is given as it is. If either worker stops, the other is
# stopped too and the service exits, so Render starts both again.
set -eu
if [ -n "${DATABASE_ADMIN_URL:-}" ]; then
  # Only the host and the database's name are taken from the admin's address; its login is dropped.
  FINGERPRINT_DATABASE_URL=$(python -c '
import os, urllib.parse
admin = urllib.parse.urlsplit(os.environ["DATABASE_ADMIN_URL"])
password = urllib.parse.quote(os.environ["LOOKUP_FINGERPRINT_WORKER_DATABASE_PASSWORD"], safe="")
host = admin.hostname + os.environ.get("DATABASE_HOST_SUFFIX", "")
print(f"postgresql://lookup_fingerprint_worker:{password}@{host}:{admin.port or 5432}{admin.path}?sslmode=require")
')
  export FINGERPRINT_DATABASE_URL
  unset DATABASE_ADMIN_URL LOOKUP_FINGERPRINT_WORKER_DATABASE_PASSWORD
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
