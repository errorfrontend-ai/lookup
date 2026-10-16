#!/bin/sh
# Starts the API (with the portal). It is given only its own two database addresses: the database admin's login and
# the other roles' passwords, which Render passes to the whole service for the pre-deploy step, are removed first.
set -eu
. /app/infra/docker/database-addresses.sh
unset DATABASE_SETUP_URL DATABASE_ADMIN_USER DATABASE_ADMIN_PASSWORD
unset LOOKUP_API_DATABASE_PASSWORD LOOKUP_ADMIN_API_DATABASE_PASSWORD LOOKUP_FINGERPRINT_WORKER_DATABASE_PASSWORD
cd /app/apps/api
exec node dist/main.js
