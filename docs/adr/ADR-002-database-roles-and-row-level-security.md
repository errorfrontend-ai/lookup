# ADR-002: Database roles and row-level security

- **Status:** Accepted (built in Step 1, extended in Step 2)
- **Date:** 4 October 2026, updated 5 October 2026
- **Deciders:** the project owner, with the build plan (master plan "Roles and RLS", gaps G2 and G3)

## Context

Look Up keeps every radio station's clients, ads, buttons, schedules and listener statistics in one
Postgres database. A station must never see or change another station's data, even if the API has a
bug, such as a query that forgets its `WHERE station_id = …`. At the same time, recognising a clip
has to search fingerprints across *all* stations' ads, and a super admin has to review every station.

Facts about Postgres that shape the design:

- A table's owner bypasses row-level security, and so do foreign-key and unique checks.
- Row-level security with no policy denies everything.
- `BYPASSRLS` can be granted only by a superuser, which a managed host (Render) will not give us.
- Function permissions are checked when a function runs, against the role running it.

## Decision

1. **Four roles, one job each.**
   - `lookup_schema_owner` owns every schema, table and function and **cannot log in**. Migrations
     run as it through a separate setup login whose migration connection starts with `role=lookup_schema_owner`.
   - `lookup_api` (the portal and listener API), `lookup_admin_api` (super-admin endpoints) and
     `lookup_fingerprint_worker` (the Python workers) can log in. None is a superuser, none can
     bypass row-level security, create roles or databases, and none owns anything.
   - Each login role has a fixed search path and server-side statement, lock-wait and
     idle-transaction timeouts, so a runaway query is stopped even if the application forgets to.
2. **Row-level security on every station-owned table**, with `USING` and `WITH CHECK` both
   `station_id = app.current_station_id()`. The station (and user) for a request are set with
   `set_config(…, true)` inside one transaction by `StationScopedTransaction`, the only way feature
   code reaches the database. Unset context means no rows and no inserts (fail closed). The setting
   lasts only for its transaction, so pooled connections and a transaction-mode pooler are safe.
3. **Composite foreign keys `(id, station_id)`** between station-owned tables, because foreign-key
   checks bypass row-level security: a row can point only at rows of its own station.
4. **The super-admin role sees all stations through explicit policies** (`<table>_admin_full_access`,
   `USING (true)` for `lookup_admin_api` only) and may change only statuses, never password hashes.
5. **Fingerprints are global and out of the API's reach.** The `fingerprints` schema is used only by
   the worker role. Matching across stations goes through narrow `SECURITY DEFINER` functions that
   return only public card data (Step 3). Every `SECURITY DEFINER` function pins
   `search_path = pg_catalog, …, pg_temp` and returns only the columns its caller needs.
6. **Column-level grants** keep the API from reading password hashes, changing platform roles,
   account status or a station's name, frequency or approval, or linking an ad to an audio asset.
   Sign-in, refresh and password changes run inside `SECURITY DEFINER` functions.
7. **The API refuses to start** if its role is a superuser, can bypass row-level security, or owns
   a table.

## Consequences

- Isolation holds even when application code is wrong; the tests talk to Postgres as each role.
- Every new station-owned table needs its policies, grants and composite keys in its migration; the
  catalogue test fails if row-level security is missing or a station policy is absent.
- Writes that cross stations (recognition, admin decisions) need deliberate `SECURITY DEFINER`
  functions or the admin role; there is no "service account" that sees everything.
- Roles must be creatable at deploy time (see the fallback below).

## Fallback if Render does not allow `CREATE ROLE`

Checked at first deploy (security baseline, "Checks to make at first deploy"). If the managed
database's admin user cannot create roles:

1. Run the API as the one available login, with every table set to `FORCE ROW LEVEL SECURITY` so
   the owner is also bound by the policies, and keep the start-up check strict about superuser and
   `BYPASSRLS`.
2. Replace the cross-station `SECURITY DEFINER` functions' privilege boundary with a denormalised,
   read-only "published cards" projection that recognition reads.
3. Record the change as an update to this ADR before deploying.

## How it is proven

| Rule | Test |
|---|---|
| Roles, owners, settings, schemas, policies, foreign-key indexes, constraint names | `apps/api/test/database-catalogue.test.ts` |
| Station A sees none of B's rows in every table and cannot write them; `WITH CHECK`; no-context inserts; composite keys; pooled connections | `apps/api/test/station-isolation.test.ts`, `apps/api/test/station-isolation-matrix.test.ts` |
| Column grants, append-only audit, PUBLIC locked out, function search paths and result columns | `apps/api/test/database-privileges.test.ts`, `apps/api/test/portal-sessions-database.test.ts` |
| Admin and worker roles do exactly their jobs | `apps/api/test/station-isolation-matrix.test.ts` |
| The API refuses to start with a dangerous role | `apps/api/test/startup-checks.test.ts` |
| Feature code uses only `StationScopedTransaction` | `apps/api/test/source-scan.test.ts` |
