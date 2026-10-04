# Security baseline

Security is built into every layer from the first commit, not added later. This page lists each
control, where it lives, and the test that proves it. A step of the build is not done until its
new tables, endpoints and jobs meet this baseline and the matching tests pass.

Status: **Built** (in the code, tested) · **Next** (step 2, sign-in and station portal) ·
**Planned** (the step named).

## 1. Database

| Control | Where | Proven by | Status |
|---|---|---|---|
| Separate roles per service: `lookup_api`, `lookup_admin_api`, `lookup_fingerprint_worker`; none is a superuser or can bypass row-level security; `lookup_schema_owner` owns everything and cannot log in | `scripts/create-database-roles.ts` | `startup-checks.test.ts` | Built |
| The API refuses to start as a superuser, a role that bypasses row-level security, or a table owner | `infrastructure/database/database-role-check.ts` | `startup-checks.test.ts` | Built |
| Row-level security on every station-owned table; station context is per transaction and missing context shows nothing | Foundation migration, `station-scoped-transaction.ts` | `station-isolation.test.ts` | Built |
| Composite foreign keys `(id, station_id)`, so no row can point at another station's rows | Foundation migration | `station-isolation.test.ts` | Built |
| Column-level privileges: the API cannot read password hashes, change platform roles, account status or a station's approval status, or link an ad to an audio asset | Foundation migration | `database-privileges.test.ts` | Built |
| Append-only audit trail; action cards are immutable versions | Foundation migration | `database-privileges.test.ts` | Built |
| Refresh tokens and recognition idempotency keys have row-level security with no policy; only narrow SECURITY DEFINER functions touch them | Foundation migration | `database-privileges.test.ts` | Built (functions: Next / step 3) |
| Nothing for PUBLIC: no connect, no temporary tables, no `public` schema, no function execution unless granted | `create-database-roles.ts`, migration default privileges | `database-privileges.test.ts` | Built |
| Server-side statement, lock-wait and idle-transaction timeouts per role | `create-database-roles.ts` | `database-privileges.test.ts` | Built |
| Partitions are reachable only through the parent table and its policies | Foundation migration | `database-scaling.test.ts` | Built |
| Encrypted database connection required in production | `config/app-config.ts` | `startup-checks.test.ts` | Built |
| Migrations run as a separate pre-deploy step under the schema owner; the API never changes the schema | `scripts/run-migrations.ts` | — | Built |
| Every SECURITY DEFINER function pins `search_path` and returns only the columns its caller needs | migrations | per-function tests | Built (one so far) |
| Point-in-time recovery, tested restore | Render | restore drill | Planned (phase 8) |

## 2. Requests (HTTP)

| Control | Where | Proven by | Status |
|---|---|---|---|
| Request id on every response and log line; hostile ids replaced | `common/http/assign-request-id.ts` | `health-and-request-ids.test.ts` | Built |
| One error envelope `{ error: { code, message, request_id } }`; no exception text, SQL, paths or stacks ever reach a caller; full detail logged privately | `common/errors/` | `error-responses.test.ts` | Built |
| Security headers (HSTS, content security policy, no sniffing, frame options), no framework header, responses never cached | `configure-http-application.ts` | `request-security.test.ts` | Built |
| Cross-origin access only for exact allowed origins; https only in production | `configure-http-application.ts`, `app-config.ts` | `request-security.test.ts`, `startup-checks.test.ts` | Built |
| Cross-site request forgery: a cookie-carrying write must come from an allowed origin | `common/http/reject-cross-site-cookie-requests.ts` | `request-security.test.ts` | Built |
| Rate limits: a baseline per client address on every URL, stricter limits per route; counters shared across instances; sensitive routes refuse when the counter store is down | `common/rate-limiting/` | `request-security.test.ts` | Built |
| Input validation with strict schemas; unknown fields rejected; errors name fields and reasons, never values | `common/validation/zod-validation.pipe.ts` | `request-security.test.ts` | Built |
| Body size limit (100 KB JSON); parser failures answered in the envelope | `configure-http-application.ts`, `map-body-parser-errors.ts` | `error-responses.test.ts` | Built |
| Slow-client protection: header, request and keep-alive timeouts | `configure-http-application.ts` | `request-security.test.ts` | Built |
| Client address taken from exactly `TRUSTED_PROXY_COUNT` proxies | `app-config.ts` | deploy check | Built (verify on Render) |

## 3. Sign-in and sessions

| Control | Status |
|---|---|
| Passwords hashed with argon2id; long passwords allowed; common and breached passwords refused (bundled list, no outside call) | Next |
| Sign-in reads the password hash through one SECURITY DEFINER function; the same answer and timing for an unknown email and a wrong password | Next |
| Sign-in and code endpoints rate-limited per address and per account, refusing when the counter store is down | Next |
| Short-lived access cookie (15 min) and a refresh cookie (7 days): `HttpOnly`, `Secure`, `SameSite`, `__Host-` prefix | Next |
| Refresh tokens stored only as hashes, rotated on every use; reuse of an old token revokes the whole token family | Next |
| Sign-out and password change revoke sessions; every sign-in and session event goes to the audit trail | Next |
| Role checks per station (owner, manager, analyst) on top of row-level security; wrong-station ids answer 404 | Next |
| Two-factor sign-in (TOTP) for super admins | Planned (phase 5a) |
| Listener app: install token issued at registration; per-install rate limits | Planned (step 3) |

## 4. Uploads and audio

| Control | Status |
|---|---|
| Uploads go straight to a private bucket through short-lived presigned URLs, with size and type fixed in the signature; object keys are generated by the server | Next |
| Uploaded audio is checked by its first bytes (not its name or declared type) and its size before processing | Next |
| The worker holds no storage credentials: each job carries a short-lived download URL | Planned (step 3) |
| Audio decoding runs with time and size caps; listener clips are deleted after matching and never logged | Planned (step 3) |

## 5. What listeners see

| Control | Status |
|---|---|
| Action cards validated against one shared schema: no unknown fields, links https only, phone numbers in E.164, at most 6 actions, labels at most 32 characters | Next |
| The app builds call, WhatsApp and map links itself from validated fields, so a card can never carry `javascript:` or another scheme | Planned (step 4) |
| New stations go live only after super-admin approval; a suspended station's cards are never shown; "Report this" on every card | Planned (phase 5a) |

## 6. Secrets and configuration

| Control | Status |
|---|---|
| Configuration validated at startup; the API refuses to start on missing or unsafe values and never prints a value | Built |
| `.env` files are git-ignored; production secrets live in the hosting provider's environment settings | Built |
| The database setup URL is used only by the setup scripts, never given to the running API | Built |
| Secret rotation runbook | Planned (phase 8) |

## 7. Logs and privacy

| Control | Status |
|---|---|
| Structured JSON logs to stdout with stack traces, tagged with the request id | Built |
| Passwords, tokens, cookies, emails, phone numbers and audio are redacted; request bodies and query strings logged only behind `LOG_REQUEST_DETAILS` | Built |
| People identified in logs only by hashed identifiers | Built (rate limiting); Next (sign-in) |
| Zambia Data Protection Act 2021: registration, privacy notice, cross-border transfer advice | Planned (phase 8) |

## 8. Background jobs

| Control | Status |
|---|---|
| Jobs carry the request id into worker logs; failures return a code, never exception text | Planned (step 3) |
| Jobs carry a deadline; finished jobs and their audio are removed from the queue store | Planned (step 3) |
| The fingerprint worker can reach only the `fingerprints` schema and one status function | Built (grants); Planned (function, step 3) |

## 9. Infrastructure and supply chain

| Control | Status |
|---|---|
| Local Postgres and Valkey listen on 127.0.0.1 only; Valkey requires a password | Built |
| Exact dependency versions and a committed lockfile | Built |
| Continuous integration runs every test suite with no skips or bypasses, plus dependency audits and secret scanning | Planned (after the slice) |
| Private networking between services on Render; TLS on every public endpoint | Planned (deploy) |

## Checks to make at first deploy

1. Render allows `CREATE ROLE` for the setup user (otherwise fall back as described in ADR-002).
2. The number of proxy hops in front of the API, so `TRUSTED_PROXY_COUNT` is exact.
3. TLS on the internal database connection (`DATABASE_TLS_MODE`), and authentication on the Key Value store.
