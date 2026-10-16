#!/bin/sh
# From Render's Shell on the API service:
#   SUPER_ADMIN_EMAIL=… SUPER_ADMIN_FULL_NAME=… SUPER_ADMIN_PASSWORD=… sh /app/infra/docker/create-super-admin.sh
# (add --reset-two-factor, with SUPER_ADMIN_EMAIL only, for a new second factor). Prints the authenticator address once.
set -eu
. /app/infra/docker/database-addresses.sh
cd /app/apps/api
exec node dist-tools/scripts/create-super-admin.js "$@"
