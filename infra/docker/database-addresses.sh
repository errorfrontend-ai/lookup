# Sourced by the API image's scripts on Render. Render gives the database's parts (host, port, name, admin login);
# this builds each role's address from them, on the database's public host so the connection is encrypted
# (production refuses an unencrypted one, and Render's private addresses offer no TLS). Passwords are URL-encoded.
# Locally nothing is set, and the addresses in apps/api/.env are used as they are.
if [ -n "${DATABASE_HOST:-}" ]; then
  encode() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
  database_address="${DATABASE_HOST}${DATABASE_HOST_SUFFIX:-}:${DATABASE_PORT:-5432}/${DATABASE_NAME}"
  DATABASE_URL="postgresql://lookup_api:$(encode "$LOOKUP_API_DATABASE_PASSWORD")@${database_address}"
  ADMIN_DATABASE_URL="postgresql://lookup_admin_api:$(encode "$LOOKUP_ADMIN_API_DATABASE_PASSWORD")@${database_address}"
  DATABASE_SETUP_URL="postgresql://$(encode "$DATABASE_ADMIN_USER"):$(encode "$DATABASE_ADMIN_PASSWORD")@${database_address}"
  export DATABASE_URL ADMIN_DATABASE_URL DATABASE_SETUP_URL
fi
