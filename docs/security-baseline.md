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
| Refresh tokens and recognition idempotency keys are out of the API role's reach; only narrow SECURITY DEFINER functions touch them | migrations (`recognition.claim_recognition`, `finish_recognition`) | `database-privileges.test.ts`, `station-isolation-matrix.test.ts`, `portal-sessions-database.test.ts`, `engine-hookup-database.test.ts` | Built |
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
| Anonymous listener routes: registrations limited per address (60 an hour) and recognitions per address (300 a minute), counted before the body is read; at most 32 recognitions at once per API instance, reading the clip included (503 at once past it); a clip must arrive within 20 seconds (400); the listener routes' general per-address ceiling (600 a minute) sits above these, so one carrier address can serve many listeners while one sender with many installs cannot fill the queue or hold the API's memory | `features/listener-installs/`, `features/recognition/recognition.service.ts`, `read-recognize-request.ts`, `common/rate-limiting/` | `listener-installs.test.ts`, `recognize-route.test.ts` | Built |
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
| Listener app: an anonymous install registers once (only a keyed hash of its id is stored) and gets a 30-day install token, its own HS256 key; every listener route needs it (401 `INSTALL_TOKEN_INVALID` before any other work); recognitions are limited per install (6 a minute, 60 a day); a listener token opens no portal route, whether sent as a bearer token or as the portal's session cookie. Installs cost nothing to make, so until the app sends an integrity verdict (Step 4) the per-install limits keep listeners fair to each other but are not an abuse control: the per-address limits in §2 are | `common/listener-authentication/`, `features/listener-installs/`, `features/recognition/` | `listener-installs.test.ts`, `recognize-route.test.ts`, `startup-checks.test.ts` | Built |

## 4. Uploads and audio

| Control | Where | Proven by | Status |
|---|---|---|---|
| Uploads go straight to a private bucket through 10-minute presigned URLs, with size and type fixed in the signature; object keys are generated by the server | `features/ads/ads.service.ts`, `object-storage.ts` | `ads-and-uploads.test.ts` | Built |
| Uploaded audio is checked by its first bytes (not its name or declared type) and its size before it is accepted; refused files are deleted | `audio-file-signatures.ts`, `ads.service.ts` | `ads-and-uploads.test.ts` | Built |
| Storage failures answer with the generic envelope; bucket names and keys never reach a caller | `ads.service.ts` | `step-two-route-failures.test.ts` | Built |
| The portal sends the file from the browser straight to the signed address with only the signed `Content-Type` header and no cookies; the bucket accepts cross-origin `PUT` with that header from the portal's origin only (design S2-D32) | `apps/portal/src/features/new-ad/send-file-to-storage.ts`; bucket CORS rule | `ad-upload-store.test.ts`, `apps/portal/e2e/new-ad-journey.spec.ts` (real upload in Chrome) | Built (local storage); production bucket at first deploy |
| The worker holds no storage credentials: each ingest job carries a 30-minute download URL signed for the internal endpoint; a worker given any storage setting refuses to start | `infrastructure/job-queues/ingest-queue.ts`, `services/fingerprinter/workers/settings.py` | `services/fingerprinter/tests/test_workers.py`, `fingerprint-workers.test.ts` | Built |
| Audio decoding runs with size caps (clips: 256 KiB, 16 s decoded; ads: 20 MiB, 121 s) and a decode deadline checked frame by frame (clips 1 s, ads 30 s), in pool processes that are abandoned and replaced at a hard cap on the whole task (clips 2.5 s, ads 45 s); the clip body is limited while it is read (413), checked by its first bytes (415), kept in memory only, never written to disk by the API or the workers, stored or logged, and removed from Valkey with its job, including when the API stops waiting for a job no worker took. While a job exists its clip is in Valkey's memory and in its append-only file, which keeps it until Valkey next rewrites that file (deploy check 5) | `features/recognition/read-recognize-request.ts`, `clip-checks.ts`; `services/fingerprinter/workers/engine_pool.py`, `engine_process.py` | `recognize-route.test.ts`, `fingerprint-workers.test.ts`, `services/fingerprinter/tests/test_workers.py`, `test_engine_rules.py` | Built |

## 5. What listeners see

| Control | Where | Proven by | Status |
|---|---|---|---|
| Action cards validated against one shared schema: no unknown fields, links https only and never shorteners, phone numbers in E.164, at most 6 actions, labels at most 32 characters | `packages/contracts` | `packages/contracts/test/action-card-schema.test.ts`, `action-card-fixtures.test.ts` | Built |
| The app builds call, WhatsApp and map links itself from validated fields, so a card can never carry `javascript:` or another scheme; a button opens only `tel:`, `https://wa.me/`, Google Maps directions or a canonical https link, in an external app, never a web view | `packages/contracts/src/action-card/action-uris.ts` (rules); `apps/mobile/lib/features/result/domain/action_uri_builder.dart`, `canonical_https_link.dart`, `result/data/action_launcher.dart` | `packages/contracts/test/` (rules); `apps/mobile/test/`: `action_uri_builder_test.dart`, `canonical_https_link_test.dart`, `result_screen_test.dart`, `action_launcher_test.dart` | Built |
| The portal turns what a station types into the card's own forms before saving and refuses what the card refuses, each with a plain reason: `http://`, link shorteners, a login in an address, number addresses, ports, spaces, `javascript:` and other schemes; locations from a pasted Google Maps link or coordinates, never 0, 0; the card's contract rules check the result, and the API checks again. Links the portal itself shows ("Try it", "Check on Google Maps") are built only from the checked values. Typed text never reaches a problem message (design S2-D30, S2-D31, S2-D34) | `apps/portal/src/features/ad-buttons/` | `read-web-address.test.ts`, `parse-map-location.test.ts`, `validate-button-drafts.test.ts`, `buttons-step.test.tsx` (mutation-checked) | Built |
| Only an ACTIVE station ever answers a listener: a station pending verification or review, rejected or suspended never has its cards shown | `recognition.find_stations_for_audio` (migration EngineHookup) | `engine-hookup-database.test.ts`, `recognize-route.test.ts` | Built |
| New stations go live only after super-admin approval; "Report this" on every card | — | — | Planned (phase 5a) |

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
| Client crashes (portal, listener app) reach the developers: reported to the API, scrubbed, rate-limited, logged with the request id. The portal's crash screen says the team was told only once the API accepted the report, and never shows the error itself | `features/client-errors/`, `apps/portal/src/app/error-reporting.ts`, `apps/portal/src/app/something-went-wrong-page.tsx` | `client-errors.test.ts`, `reference-codes.test.ts`, `apps/portal/src/app/error-reporting.test.ts`, `apps/portal/src/app/error-boundary.test.tsx`, `apps/portal/src/app/portal-routes.test.tsx`; the app: `apps/mobile/test/`: `client_error_reporter_test.dart`, `global_error_handlers_test.dart`, `isolate_error_listener_test.dart`, `personal_data_scrubber_test.dart`, `widget_test.dart`, and the emulator run (`apps/mobile/tool/run_emulator_tests.py`) | Built (portal and app) |
| The audit trail names what changed (field paths, previous versions), never personal values | `features/action-cards/action-card-changes.ts`, `features/campaigns/` | `cards-schedules-publishing.test.ts`, `action-card-changes.test.ts` | Built |
| Zambia Data Protection Act 2021: registration, privacy notice, cross-border transfer advice | — | — | Planned (phase 8) |

## 8. Background jobs

| Control | Where | Proven by | Status |
|---|---|---|---|
| Jobs carry the request id into worker logs (structlog JSON, with the stack on errors); a failed job's reason is a code only, never exception text, and the API turns it into a catalogue error (an unknown code is a plain 500) | `services/fingerprinter/workers/queue_runner.py`, `job_failure.py`; `infrastructure/job-queues/recognize-queue.ts` | `services/fingerprinter/tests/test_workers.py`, `recognize-route.test.ts`, `fingerprint-workers.test.ts` | Built |
| Jobs carry a deadline (a recognize job past it is dropped undecoded); recognize jobs are tried once and removed when done or failed; ingest jobs are removed after their last try, with their download URL | `infrastructure/job-queues/` | `recognize-route.test.ts`, `fingerprint-workers.test.ts` | Built |
| The ingest sweep re-adds an ad that waited with no job at most once every 15 minutes and at most 50 a run, with a fresh short-lived download address, and logs an error for an ad that keeps failing; ads that keep failing never crowd out the rest | `features/ads/ingest-sweep.ts` | `ingest-sweep.test.ts` | Built |
| The fingerprint worker can reach only the `fingerprints` schema and one status function (`fingerprints.record_ad_ingest_result`), and cannot read or change station data | migrations | `station-isolation-matrix.test.ts`, `engine-hookup-database.test.ts`, `services/fingerprinter/tests/test_ingest_store.py` | Built |
| Recognition reads across stations only through `recognition.find_stations_for_audio`, which returns what a listener may see (station, client, title, card) and never limits, counters or other internals; answers are checked against the shared response contract before they leave | migrations; `features/recognition/recognition.service.ts` | `engine-hookup-database.test.ts`, `recognize-route.test.ts`, `packages/contracts/test/recognition-schemas.test.ts` | Built |
| Admission control: a circuit breaker, the queue depth, the workers' heartbeat and the number of recognitions in progress on the instance refuse clips at once with 503 and Retry-After, naming no queue, worker or store | `features/recognition/recognition.service.ts`, `recognition-breaker.ts`, `infrastructure/job-queues/recognize-queue.ts` | `recognize-route.test.ts`, `recognition-rules.test.ts`, `fingerprint-workers.test.ts` | Built |

## 9. Infrastructure and supply chain

| Control | Where | Proven by | Status |
|---|---|---|---|
| Local Postgres, Valkey and object storage listen on 127.0.0.1 only; Valkey requires a password | `infra/docker-compose.yml` | review | Built |
| Exact dependency versions and a committed lockfile; no script swallows a failing exit code | `package.json` files | `source-scan.test.ts` | Built |
| Continuous integration runs every test suite with no skips or bypasses, plus dependency audits and secret scanning | — | — | Planned (after the slice) |
| Private networking between services on Render; TLS on every public endpoint | — | — | Planned (deploy) |

## 10. The listener app (`apps/mobile`)

| Control | Where | Proven by | Status |
|---|---|---|---|
| https only outside development, enforced in Dart (Dart's HTTP client cannot be relied on to obey Android's settings): the API client refuses anything else and follows no redirects; images load only over https, redirects included; Android allows cleartext only in the development flavour, only to the emulator's host and the device itself, and trusts only the system's certificate authorities | `lib/core/network/api_client.dart`, `lib/features/result/data/https_image_provider.dart`, `android/app/src/*/res/xml/network_security_config.xml` | `api_client_test.dart`, `https_image_provider_test.dart`, `android_project_test.dart`; the emulator run's production build given an http address | Built |
| The app refuses to start on an unsafe configuration: a missing or malformed address, http outside development, development-only flags in staging or production, a flavour that differs from the build's, or staging and production without a support number | `lib/core/configuration/`, `lib/app/bootstrap.dart` | `app_configuration_test.dart`, `widget_test.dart` | Built |
| The install token is stored app-private, never backed up or moved to a new phone, sent only to the recognize route, and never put in a crash report or a log line | `lib/core/listener_install/`, `lib/core/network/api_client.dart`, the Android manifest and `data_extraction_rules.xml` | `listener_install_repository_test.dart`, `listener_install_store_test.dart`, `api_client_test.dart`, `client_error_reporter_test.dart`, `android_project_test.dart` | Built |
| The microphone is used only after a tap on Identify and the app's own explainer; recording never runs in the background (hiding the app cancels it); the clip file is deleted as soon as it is read, leftovers are swept, and the clip is kept in memory only while it is being sent, is waiting on Busy, or can be sent again; no other permission is asked for (Android: `INTERNET` and `RECORD_AUDIO` only; iOS: the microphone only) | `lib/features/identify/`, the Android manifest, `ios/Podfile`, `ios/Runner/Info.plist` | `recognition_flow_test.dart`, `clip_recorder_test.dart`, `permission_screen_test.dart`, `android_project_test.dart`, `ios_project_test.dart`; the emulator run | Built |
| Recording leaves other audio playing: no audio focus on Android, mixing with others on iOS, never a Bluetooth headset's microphone on iOS (design S4-D34) | `lib/features/identify/data/clip_recorder.dart` | `clip_recorder_test.dart` | Built |
| Nothing technical reaches the screen: no exception text, stack or server message; a reference code only for a request id the API echoed or a crash report it accepted; details only in a development build with its flag | `lib/features/identify/presentation/`, `lib/features/identify/domain/send_policy.dart` | `error_screen_test.dart`, `recognition_flow_test.dart`, the screens' no-technical-text checks, `source_scan_test.dart` | Built |
| The device log gets nothing outside development builds with the verbose flag, and never personal data | `lib/core/error_reporting/development_log.dart` | `development_log_test.dart`, `source_scan_test.dart` (no `print`) | Built |
| Device integrity (Play Integrity, App Attest) as a soft signal at registration | — | — | Planned (hardening, P8; the user's choice, 8 October 2026) |

## Checks to make at first deploy

1. Render allows `CREATE ROLE` for the setup user (otherwise fall back as described in
   [ADR-002](adr/ADR-002-database-roles-and-row-level-security.md)).
2. The number of proxy hops in front of the API, so `TRUSTED_PROXY_COUNT` is exact.
3. TLS on the internal database connection (`DATABASE_TLS_MODE`), and authentication on the Key Value store.
4. The R2 bucket for ad uploads allows cross-origin `PUT` with a `Content-Type` header from the portal's production origin, and from no other origin (design S2-D32); without it every upload from the portal fails.
5. The Key Value store rewrites its append-only file regularly (automatic rewrite on, or a scheduled
   `BGREWRITEAOF`), so listener clips from finished recognize jobs do not stay on its disk; and it runs
   with `noeviction`, so a job is never dropped silently.
