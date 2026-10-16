#!/bin/sh
# Render's pre-deploy command: create or update the roles and schemas, then apply the migrations, before the new
# version starts (the API itself never changes the schema). Safe to run on every deploy.
set -eu
. /app/infra/docker/database-addresses.sh
cd /app/apps/api
node dist-tools/scripts/create-database-roles.js
node dist-tools/scripts/run-migrations.js
