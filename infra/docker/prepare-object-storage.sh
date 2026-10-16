#!/bin/sh
# From Render's Shell on the API service, once: creates the private R2 buckets and their CORS rules for the portal.
set -eu
. /app/infra/docker/database-addresses.sh
cd /app/apps/api
exec node dist-tools/scripts/prepare-object-storage.js
