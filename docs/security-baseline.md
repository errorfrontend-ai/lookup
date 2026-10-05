# Security baseline

Security is built into every layer from the first commit, not added later. This page lists each
control, where it lives, and the test that proves it. A step of the build is not done until its
new tables, endpoints and jobs meet this baseline and the matching tests pass.

Status: **Built** (in the code and proven by the named test) · **Planned** (the step named).
Test files are in `apps/api/test/` unless another folder is given.

## 1. Database

| Control | Where | Proven by | Status |
|---|---|---|---|
| Separate roles per service: `lookup_api`, `lookup_admin_api`, `lookup_fingerprint_worker`; none is a superuser, can bypass row-level security or create roles or databases; `lookup_schema_owner` owns everything and cannot log in; service roles own nothing | `scripts/create-database-roles.ts` | `database-catalogue.test.ts`, `startup-checks.test.ts` | Built |
| The API refuses to start as a superuser, a role that bypasses row-level security, or a table owner | `infrastructure/database/database-role-check.ts` | `startup-checks.test.ts` | Built |
| Row-level security on every station-owned table, with `USING` and `WITH CHECK`; station context is per transaction and missing context shows nothing and inserts nothing | Foundation migration, `station-scoped-transaction.ts` | `station-isolation.test.ts`, `station-isolation-matrix.test.ts`, `database-catalogue.test.ts` | Built |
| Composite foreign keys `(id, station_id)`, so no row can point at another station's rows, even where row-level security is bypassed | Foundation and AdCardsAndSchedules migrations | `station-isolation-matrix.test.ts` | Built |
| Column-level privileges: the API cannot read password hashes, change platform roles, account status or a station's name, frequency or approval status, or link an ad to an audio asset | migrations | `database-privileges.test.ts`, `station-isolation-matrix.test.ts` | Built |
| The super-admin role reads every station through explicit policies, changes only statuses on users, ads, campaigns and installs, and never reads password hashes | migrations | `station-isolation-matrix.test.ts`, `database-catalogue.test.ts` | Built |
| The fingerprint worker can use only the `fingerprints` schema; neither API role has any privilege there | migrations | `station-isolation-matrix.test.ts`, `database-catalogue.test.ts` | Built |
| Append-only audit trail for every login role; action cards are immutable versions | migrations | `database-privileges.test.ts`, `station-isolation-matrix.test.ts` | Built |
| Refresh tokens and recognition idempotency keys are out of the API role's reach; only narrow SECURITY DEFINER functions touch them | migrations | `database-privileges.test.ts`, `station-isolation-matrix.test.ts`, `portal-sessions-database.test.ts` | Built (recognition functions: step 3) |
| Nothing for PUBLIC: no connect, no temporary tables, no `public` schema, no function execution unless granted | `create-database-roles.ts`, migration default privileges | `database-privileges.test.ts` | Built |
| Server-side statement, lock-wait and idle-transaction timeouts and a fixed search path per role | `create-database-roles.ts` | `database-catalogue.test.ts`, `database-privileges.test.ts` | Built |
| Partitions are reachable only through the parent table and its policies; future months are created at start-up and daily | Foundation migration, `recognition-event-partitions.ts` | `database-scaling.test.ts` | Built |
| Encrypted database connection required in production, for the API and the migration script alike | `config/app-config.ts`, `data-source-options.ts` | `startup-checks.test.ts`, `source-scan.test.ts` | Built |
| Migrations run as a separate pre-deploy step under the schema owner; the API never changes the schema and no service role can create anything | `scripts/run-migrations.ts` | `database-catalogue.test.ts`, `source-scan.test.ts` | Built |
| Every SECURITY DEFINER function pins `search_path` (`pg_catalog` first, `pg_temp` last) and returns only the columns its caller needs | migrations | `database-privileges.test.ts`, `portal-sessions-database.test.ts` | Built |
| Point-in-time recovery, tested restore | Render | restore drill | Planned (phase 8) |

## 2. Requests (HTTP)

| Control | Where | Proven by | Status |
|---|---|---|---|
| Request id on every response and log line; hostile ids replaced | `common/http/assign-request-id.ts` | `health-and-request-ids.test.ts` | Built |
| One error envelope `{ error: { code, message, request_id, fields? } }` (shared contract `ErrorEnvelope`); no exception text, SQL, paths or stacks ever reach a caller, on any route and for any kind of failure; full detail logged privately under the request id | `common/errors/`, `packages/contracts` | `error-responses.test.ts`, `step-two-route-failures.test.ts`, `health-when-database-is-down.test.ts`, `source-scan.test.ts` | Built |
| Security headers (HSTS, content security policy, no sniffing, frame options), no framework header, responses never cached | `configure-http-application.ts` | `request-security.test.ts` | Built |
| Cross-origin access only for exact allowed origins; https only in production | `configure-http-application.ts`, `app-config.ts` | `request-security.test.ts`, `startup-checks.test.ts` | Built |
| Cross-site request forgery: a cookie-carrying write must come from an allowed origin; sign-in routes always need one (login CSRF) | `common/http/reject-cross-site-cookie-requests.ts` | `request-security.test.ts`, `authentication.test.ts` | Built |
| Rate limits: a baseline per client address on every URL, stricter limits per route; counters shared across instances; sign-in refuses when the counter store is down, session refresh keeps working (design S2-D17) | `common/rate-limiting/` | `request-security.test.ts`, `authentication-when-key-value-store-is-down.test.ts` | Built |
| Input validation with strict schemas; unknown fields rejected; errors name fields and reasons, never values | `common/validation/zod-validation.pipe.ts` | `request-security.test.ts`, `action-card-fixtures.test.ts` | Built |
| Body size limit (100 KB JSON); parser failures answered in the envelope | `configure-http-application.ts`, `map-body-parser-errors.ts` | `error-responses.test.ts` | Built |
| Slow-client protection: header, request and keep-alive timeouts | `configure-http-application.ts` | `request-security.test.ts` | Built |
| Client address taken from exactly `TRUSTED_PROXY_COUNT` proxies | `app-config.ts` | deploy check | Built (verify on Render) |

## 3. Sign-in and sessions

| Control | Where | Proven by | Status |
|---|---|---|---|
| Passwords hashed with argon2id (19 MiB, 2 passes); 15–128 characters after NFC; common, breached-list and personal-detail passwords refused (bundled list, no outside call) | `password-hasher.ts`, `password-policy.ts` | `authentication.test.ts` | Built |
| Sign-in reads the password hash through one SECURITY DEFINER function; the same answer and one argon2 computation for an unknown email, a wrong password or a disabled account | `authentication.service.ts`, StationPortal migration | `authentication.test.ts`, `portal-sessions-database.test.ts` | Built |
| Sign-in rate-limited per address and per account, with a trusted-device cookie so an attacker cannot lock the owner out; refuses when the counter store is down; a database backstop after 20 failures | `authentication-rate-limits.ts`, StationPortal migration | `authentication.test.ts`, `authentication-when-key-value-store-is-down.test.ts`, `portal-sessions-database.test.ts` | Built |
| Short-lived access cookie (15 min) pointing at a session row checked on every request, and a refresh cookie (7 days sliding, 30 days at most): `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` prefix | `session-cookies.ts`, `signed-in.guard.ts` | `authentication.test.ts` | Built |
| Refresh tokens stored only as hashes, rotated on every use; a token presented again after its 30-second grace (design S2-D3) revokes the whole session | StationPortal migration | `authentication.test.ts`, `portal-sessions-database.test.ts` | Built |
| Sign-out and password change revoke sessions at once; every sign-in, refresh, sign-out, reuse and password change goes to the audit trail | StationPortal and DatabaseHardening migrations | `authentication.test.ts`, `portal-sessions-database.test.ts` | Built |
| Role checks per station (owner, manager, analyst) on top of row-level security; another station's ids answer 404; a station that is not active cannot change content | `features/stations/station-access.guard.ts` | `stations-and-clients.test.ts`, `ads-and-uploads.test.ts`, `cards-schedules-publishing.test.ts` | Built |
| Two-factor sign-in (TOTP) for super admins | — | — | Planned (phase 5a) |
| Listener app: install token issued at registration; per-install rate limits | — | — | Planned (step 3) |

## 4. Uploads and audio

| Control | Where | Proven by | Status |
|---|---|---|---|
| Uploads go straight to a private bucket through 10-minute presigned URLs, with size and type fixed in the signature; object keys are generated by the server | `features/ads/ads.service.ts`, `object-storage.ts` | `ads-and-uploads.test.ts` | Built |
| Uploaded audio is checked by its first bytes (not its name or declared type) and its size before it is accepted; refused files are deleted | `audio-file-signatures.ts`, `ads.service.ts` | `ads-and-uploads.test.ts` | Built |
| Storage failures answer with the generic envelope; bucket names and keys never reach a caller | `ads.service.ts` | `step-two-route-failures.test.ts` | Built |
| The worker holds no storage credentials: each job carries a short-lived download URL | — | — | Planned (step 3) |
| Audio decoding runs with time and size caps; listener clips are deleted after matching and never logged | — | — | Planned (step 3) |

## 5. What listeners see

| Control | Where | Proven by | Status |
|---|---|---|---|
| Action cards validated against one shared schema: no unknown fields, links https only and never shorteners, phone numbers in E.164, at most 6 actions, labels at most 32 characters | `packages/contracts` | `packages/contracts/test/action-card-schema.test.ts`, `action-card-fixtures.test.ts` | Built |
| The app builds call, WhatsApp and map links itself from validated fields, so a card can never carry `javascript:` or another scheme | `packages/contracts/src/action-card/action-uris.ts` (rules); listener app | `packages/contracts/test/` (rules) | Built (rules); Planned (app, step 4) |
| New stations go live only after super-admin approval; a suspended station's cards are never shown; "Report this" on every card | — | — | Planned (phase 5a) |

## 6. Secrets and configuration

| Control | Where | Proven by | Status |
|---|---|---|---|
| Configuration validated at start-up; the API refuses to start on missing or unsafe values and never prints a value; a start-up failure is one structured log line | `config/app-config.ts`, `process-failures.ts` | `startup-checks.test.ts`, `process-failures.test.ts` | Built |
| `.env` files are git-ignored; production secrets live in the hosting provider's environment settings | `.gitignore` | review | Built |
| The database setup URL is used only by the setup scripts, never given to the running API | `scripts/database-setup-config.ts` | review | Built |
| Separate keys for separate jobs, derived from one secret (HKDF): access-token signing, trusted-device cookies, identifier hashing | `common/security/derived-keys.ts` | `authentication.test.ts` | Built |
| Secret rotation runbook | — | — | Planned (phase 8) |

## 7. Logs and privacy

| Control | Where | Proven by | Status |
|---|---|---|---|
| Structured JSON logs to stdout with stack traces, tagged with the request id, from requests and from process failures | `infrastructure/logging/`, `process-failures.ts` | `error-responses.test.ts`, `process-failures.test.ts` | Built |
| Errors are logged without the values they carried: database parameters, driver detail and quoted input are dropped; emails, phone numbers and tokens in messages are masked | `serialize-error-for-log.ts` | `log-privacy.test.ts` | Built |
| Passwords, tokens, cookies, emails, phone numbers and audio are redacted; request bodies and query strings logged only behind `LOG_REQUEST_DETAILS` | `logging.module.ts` | `log-privacy.test.ts`, `log-request-details.test.ts` | Built |
| People identified in logs only by keyed hashes: every line of a signed-in request carries `actor`, never the id or email | `signed-in.guard.ts`, `derived-keys.ts` | `log-privacy.test.ts` | Built |
| Client crashes (portal, listener app) reach the developers: reported to the API, scrubbed, rate-limited, logged with the request id | `features/client-errors/`, `apps/portal/src/app/error-reporting.ts` | `client-errors.test.ts`, `apps/portal/src/app/error-reporting.test.ts` | Built (portal); Planned (app, step 4) |
| The audit trail names what changed (field paths, previous versions), never personal values | `features/action-cards/action-card-changes.ts`, `features/campaigns/` | `cards-schedules-publishing.test.ts`, `action-card-changes.test.ts` | Built |
| Zambia Data Protection Act 2021: registration, privacy notice, cross-border transfer advice | — | — | Planned (phase 8) |

## 8. Background jobs

| Control | Where | Proven by | Status |
|---|---|---|---|
| Jobs carry the request id into worker logs; failures return a code, never exception text | — | — | Planned (step 3) |
| Jobs carry a deadline; finished jobs and their audio are removed from the queue store | — | — | Planned (step 3) |
| The fingerprint worker can reach only the `fingerprints` schema and one status function | migrations | `station-isolation-matrix.test.ts` | Built (grants); Planned (function, step 3) |

## 9. Infrastructure and supply chain

| Control | Where | Proven by | Status |
|---|---|---|---|
| Local Postgres, Valkey and object storage listen on 127.0.0.1 only; Valkey requires a password | `infra/docker-compose.yml` | review | Built |
| Exact dependency versions and a committed lockfile; no script swallows a failing exit code | `package.json` files | `source-scan.test.ts` | Built |
| Continuous integration runs every test suite with no skips or bypasses, plus dependency audits and secret scanning | — | — | Planned (after the slice) |
| Private networking between services on Render; TLS on every public endpoint | — | — | Planned (deploy) |

## Checks to make at first deploy

1. Render allows `CREATE ROLE` for the setup user (otherwise fall back as described in
   [ADR-002](adr/ADR-002-database-roles-and-row-level-security.md)).
2. The number of proxy hops in front of the API, so `TRUSTED_PROXY_COUNT` is exact.
3. TLS on the internal database connection (`DATABASE_TLS_MODE`), and authentication on the Key Value store.
