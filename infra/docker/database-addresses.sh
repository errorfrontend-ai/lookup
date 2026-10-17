# Sourced by the API image's scripts on Render. Render gives the database's private address with its admin login
# (DATABASE_ADMIN_URL); this builds each role's address from it, on the database's public host (the private host plus
# DATABASE_HOST_SUFFIX) so the connection is encrypted: production refuses an unencrypted one, and Render's private
# addresses offer no TLS. Passwords are URL-encoded. Locally nothing is set, and apps/api/.env is used as it is.
if [ -n "${DATABASE_ADMIN_URL:-}" ]; then
  # Captured first, so the calling script (set -e) stops if the address cannot be read, rather than running on without it.
  database_addresses=$(node -e '
    const admin = new URL(process.env.DATABASE_ADMIN_URL);
    const base = `${admin.hostname}${process.env.DATABASE_HOST_SUFFIX ?? ""}:${admin.port || 5432}${admin.pathname}`;
    const login = (user, password) => `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base}`;
    const addresses = {
      DATABASE_URL: login("lookup_api", process.env.LOOKUP_API_DATABASE_PASSWORD ?? ""),
      ADMIN_DATABASE_URL: login("lookup_admin_api", process.env.LOOKUP_ADMIN_API_DATABASE_PASSWORD ?? ""),
      DATABASE_SETUP_URL: login(decodeURIComponent(admin.username), decodeURIComponent(admin.password)),
    };
    // encodeURIComponent leaves no quote, dollar, backtick or backslash, so double quotes hold each value safely.
    for (const [name, value] of Object.entries(addresses)) console.log(`export ${name}=${JSON.stringify(value)}`);
  ')
  eval "$database_addresses"
  unset database_addresses
fi
