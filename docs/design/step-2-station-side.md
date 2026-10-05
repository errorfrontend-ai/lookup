# Step 2 — Station side (basic): build spec

Scope (approved plan, thin slice, Step 2): a station user signs in to the portal, uploads an ad for
one of the station's clients, sets its buttons and schedule, and publishes it. Fingerprinting (the
ad moving from Processing to Ready) is Step 3, so in Step 2 a verified upload leaves the ad in
`PROCESSING`.

Research behind the decisions (sources cited there): `c:\tmp\lookup-workflows\step-2-research.md`,
with object storage, sign-in and action cards each researched on 4 October 2026. Every rule in
[conventions.md](../conventions.md) and every "Next" row of [security-baseline.md](../security-baseline.md)
applies.

## Decisions

| # | Decision | Why |
|---|---|---|
| S2-D1 | **Local object storage is versitygw v1.8.0** (Apache-2.0, 30 MB image), standing in for Cloudflare R2. | MinIO's community images can no longer be pulled (Docker Hub and Quay both refuse since September 2026), and the last free build has an unpatched unauthenticated-write CVE (CVE-2026-40344). versitygw validates SigV4 presigned URLs and per-bucket CORS, so tests exercise the real security properties. Fallback: Garage v2.4.1. |
| S2-D2 | **Uploads go straight from the browser to storage through a presigned PUT whose signature binds Content-Type and Content-Length**; the server then checks size with HEAD and the first bytes with a ranged GET before accepting. | R2 has no POST policy, so size limits must be in the PUT signature. The AWS SDK only signs Content-Type when it is listed in `signableHeaders`, and its default checksum behaviour breaks presigned PUTs unless `requestChecksumCalculation: 'WHEN_REQUIRED'` is set. |
| S2-D3 | **Session = a 15-minute access JWT (HS256, `jose` 6.2.12) that points to a server-side session row checked on every request, plus a rotating 256-bit refresh token stored as SHA-256**. Reusing an old refresh token revokes the whole session (30-second grace for lost responses). Refresh slides 7 days, inside a 30-day absolute session limit. | Satisfies the baseline (15 min / 7 days / rotation / reuse detection / revocation) and ASVS 5.0 7.4.1: sign-out, password change and disabling a user take effect on the next request, not 15 minutes later. |
| S2-D4 | **Passwords are verified inside Postgres.** The API asks a SECURITY DEFINER function for the hash's settings (algorithm, parameters, salt — never the hash itself), computes argon2id, and passes the result to a sign-in function that compares and records the outcome. The API role loses `UPDATE (password_hash)`. | Closes a hole found in Step 1: the API role could overwrite any user's hash, because it sets `app.current_user_id` itself. Now no function creates a session without proof of the password. |
| S2-D5 | **Password policy (NIST SP 800-63B rev 4):** 15–128 Unicode code points after NFC normalisation, no composition rules, no expiry, paste allowed; refused if on a bundled blocklist (SecLists, MIT) or containing context words (lookup, the station name, the user's name or email). Rejections name the reason (`too_short`, `too_long`, `too_common`, `contains_personal_details`). | NIST requires 15 characters for single-factor passwords, a blocklist, and telling the user why. |
| S2-D6 | **argon2id via `argon2` 0.45.1 with m=19456 KiB, t=2, p=1** (OWASP setting), at most 2 concurrent hashes per instance (wait at most 2 s, then 503). | The package defaults (64 MiB, p=4) would exhaust a 512 MB Render Starter instance under a burst of sign-ins. |
| S2-D7 | **Throttling never locks the real user out:** per-address and per-account limits in Valkey that refuse when Valkey is down, plus a trusted-device cookie (OWASP device-cookie pattern) so failures from an attacker don't block a browser the user already signed in from. A database backstop slows an account to one attempt per minute after 20 straight failures, even if Valkey or the API is compromised. | Baseline: "rate-limited per address and per account, refusing when the counter store is down"; OWASP warns that plain lockout is a denial-of-service weapon. NIST's hard disable after 100 failures arrives with self-service password reset (phase 5a). |
| S2-D8 | **The action-card contract is written once in zod 4.6.5 in a new `packages/contracts` workspace**, used directly by the API and the portal. A script emits a JSON Schema (draft 2020-12) for the Flutter app, and a test fails if the committed file drifts. `ajv` is only a dev-time cross-check, not a runtime dependency. | The API already validates everything with zod through `ZodValidationPipe`; a second validator would mean two error shapes. (Changes the plan's "validated by ajv".) |
| S2-D9 | **Card rules:** 1–6 actions; types `LINK` (canonical https only: no IP address, localhost, port or `user@`; international domains as punycode; known URL shorteners refused), `CALL` and `WHATSAPP` (any E.164 number; +260 numbers must have 9 digits after the code), `MAP` (latitude/longitude, not 0,0, optional place name); labels 1–32 characters, no line breaks, control or bidirectional-override characters; WhatsApp prefilled text ≤ 500. Every action carries a stable UUID so "taps per button" survives edits. | Plan G10 and the mobile chapter's guardrails. Shorteners hide the real destination, which matters for scam protection (G15). |
| S2-D10 | **Station-scoped routes carry the station in the path:** `/api/v1/stations/{stationId}/...`. A guard confirms the signed-in user is a member of that station (else **404**, never 403, so ids can't be probed), sets the station and role in the request context, and refuses writes from ANALYST (403) and ad work for a station that isn't ACTIVE (403 `STATION_NOT_ACTIVE`). | A user can belong to several stations; the access token deliberately carries no station. |
| S2-D11 | **In development the portal (Vite, port 5180) proxies `/api` to the API (port 3100)**, so cookies are first-party and `__Host-` cookies work on localhost without branching by environment. **In production the portal and API must be same-site subdomains of one domain** (e.g. `portal.<domain>`, `api.<domain>`). | Two `*.onrender.com` hosts are cross-site (public suffix), and Safari blocks cross-site cookies. The domain itself is needed before the first deploy, not for Step 2. |
| S2-D12 | **Ingest is not enqueued in Step 2.** `complete` verifies the upload and sets `PROCESSING`; Step 3 adds the queue producer, the worker, and a re-queue for ads already waiting. | A job carries a short-lived download URL; enqueueing before any worker exists would only produce expired jobs. |
| S2-D13 | **Publishing needs a verified upload, a card and a schedule**; it is allowed while the ad is still `PROCESSING` (it starts matching once Ready). | The upload wireframe says "You can carry on setting up the buttons". |
| S2-D14 | **The portal plays an ad back through a 5-minute presigned GET** (the wireframes show Play buttons on the list, the upload step and the detail page). Bucket CORS therefore allows `GET` as well as `PUT`. | Wireframes AdsDesktop, AdsMobile, NewAdUpload, AdDetail. |
| S2-D15 | Portal stack: React 19.3.0, Vite 8.3.2, @vitejs/plugin-react 6.1.1, Tailwind 4.3.3 (+ @tailwindcss/vite), **react-router 7.18.4** (the maintained 7.x line chosen in the plan), @tanstack/react-query 5.104.1, vitest 5.0.3 with **jsdom 29.1.1** (30.x needs Node ≥ 24.15; this machine has 24.13.1), @testing-library/react 16.3.3, user-event 14.6.7, jest-dom 7.0.1, @playwright/test 1.63.0 (Chromium only). Fonts self-hosted (Public Sans, Bricolage Grotesque), not loaded from Google. | Versions checked against npm on 4–5 October 2026. Self-hosting avoids a third-party request on every portal load. |

**Needed from the user before the first deploy (not blocking Step 2):** the production domain (S2-D11),
and whether R2 stays a `weur` location hint (plan D2) or becomes an EU-jurisdiction bucket.

## Database: migration `1791100000000-StationPortal`

All new functions are `SECURITY DEFINER`, owned by `lookup_schema_owner`, with
`SET search_path = pg_catalog, app, pg_temp` (the `app` schema must be present for citext's `=`
operator, otherwise email lookups silently become case-sensitive), and `EXECUTE` granted only to
`lookup_api` in the same transaction. Failed sign-ins never raise (that would roll back the failure
counter).

1. **Fix from Step 1:** `create_recognition_event_partitions` gets `search_path = pg_catalog, pg_temp`
   (`pg_temp` listed last explicitly).
2. **Portal users:** `REVOKE UPDATE (password_hash) ON app.portal_users FROM lookup_api`. New columns
   (no grants): `consecutive_failed_sign_in_count integer NOT NULL DEFAULT 0`,
   `last_failed_sign_in_at timestamptz`, `password_changed_at timestamptz`.
3. **`app.portal_sessions`** (one row per sign-in = the refresh-token family): `id`, `portal_user_id`
   (cascade, indexed), `started_at`, `expires_at` (started + 30 days), `last_refreshed_at`, `revoked_at`,
   `revocation_reason` (`SIGNED_OUT`, `REFRESH_TOKEN_REUSED`, `PASSWORD_CHANGED`, `ACCOUNT_DISABLED`,
   `SESSION_LIMIT_REACHED`), `sign_in_request_id`. Row-level security on, no policy, no grants.
4. **`app.refresh_tokens`:** `token_family_id` becomes `portal_session_id` (foreign key to
   `portal_sessions`, cascade; index `refresh_tokens_portal_session_index`); add `used_at` and
   `successor_count smallint NOT NULL DEFAULT 0`.
5. **Functions:**
   - `find_password_hash_settings(submitted_email)` → the PHC prefix (`$argon2id$v=19$m=…,t=…,p=…$<salt>`)
     for an ACTIVE user, else NULL. Never the hash itself.
   - `sign_in_portal_user(submitted_email, computed_password_hash, new_refresh_token_hash, replacement_password_hash, request_id)`
     → `(outcome, portal_user_id, portal_session_id, refresh_token_expires_at)`; outcomes `SIGNED_IN`,
     `INVALID_CREDENTIALS`, `THROTTLED`. Locks the user row, compares SHA-256 of both hashes, counts
     failures (backstop: after 20 straight failures, one comparison per 60 s), writes audit rows, keeps at
     most 10 active sessions per user (oldest revoked as `SESSION_LIMIT_REACHED`), applies a re-hash
     when parameters changed.
   - `rotate_portal_refresh_token(presented_token_hash, new_refresh_token_hash, request_id)` → `ROTATED`,
     `INVALID` or `REUSE_DETECTED` (revokes the session as `REFRESH_TOKEN_REUSED` and audits). A token
     used ≤ 30 s ago with fewer than 3 successors may rotate again (lost response, two tabs).
   - `end_portal_session(presented_token_hash, request_id)` — idempotent sign-out.
   - `find_active_portal_session(portal_session_id)` → `portal_user_id` for a live session of an ACTIVE user.
   - `change_portal_user_password(portal_session_id, computed_current_password_hash, new_password_hash, new_refresh_token_hash, request_id)`
     — same comparison and throttle; revokes every session of the user as `PASSWORD_CHANGED`, starts a
     fresh one for the caller, audits.
   - `delete_expired_portal_sessions()` — for the later cleanup job.
6. **Ads upload columns:** `upload_content_type`, `upload_size_bytes`, `upload_original_file_name`
   (display only, ≤ 255), `upload_expires_at`, `upload_entity_tag`, `uploaded_at`. Insert/update column
   grants for `lookup_api` extended to exactly these (still never `audio_asset_id`,
   `duration_milliseconds`, `processing_error_code`).
7. **Ad status guard** (trigger `ads_guard_status_transition`): when the acting role is `lookup_api`, only
   these transitions are allowed: AWAITING_UPLOAD → AWAITING_UPLOAD (new upload attempt), PROCESSING or
   FAILED; FAILED → AWAITING_UPLOAD. READY and NEEDS_REVIEW are set only by the ingest worker's function
   (Step 3).
8. **Campaign columns** used by Step 2 already exist (`active_period`, `time_window_grace_period`,
   `engagement_limit`, `action_card_id`, `status`).

## API (all under `/api/v1`)

Authentication — `features/authentication/`:

| Method and path | Input (zod, strict) | Result | Rate limits | Notes |
|---|---|---|---|---|
| `POST /auth/sign-in` | `{ email, password }` | 200 + `Set-Cookie` access, refresh, trusted-device; body `{ user: { id, fullName, email }, stations: [{ id, name, frequencyLabel, role, status }] }` | 20/min per address; 100 failures/h per address; 10 failures/15 min per account (untrusted) or per trusted device; refuse when Valkey is down | One argon2 computation on every path (dummy salt for unknown emails); identical 401 `INVALID_CREDENTIALS` for unknown email, wrong password or disabled account; Origin required even without cookies (login CSRF). |
| `POST /auth/refresh` | refresh cookie | 204 + new cookies | 30/min per address | Reuse → 401 and both cookies cleared. |
| `POST /auth/sign-out` | refresh cookie | 204, cookies cleared | — | Idempotent. |
| `POST /auth/change-password` | `{ currentPassword, newPassword }` | 204 + fresh cookies | 5/15 min per user | Policy reasons returned as field codes; all other sessions end. |
| `GET /auth/me` | access cookie | `{ user, stations }` | baseline | Portal start-up. |

Cookies: `__Host-lookup-access-token` (Max-Age 900), `__Host-lookup-refresh-token` (Max-Age = seconds to
its expiry, ≤ 604 800), `__Host-lookup-trusted-device` (1 year). All `Secure; HttpOnly; SameSite=Strict;
Path=/`, no Domain. Tokens never appear in bodies, URLs or logs.

Every authenticated request: verify the JWT (`HS256`, issuer `lookup-api`, audience `lookup-portal`,
10 s clock tolerance) → `find_active_portal_session(sid)` → user id into the request context.
`AUTHENTICATION_SECRET` (≥ 32 random bytes, base64url) is required configuration; subkeys for signing,
device cookies and hashing identifiers in logs and rate-limit keys are derived with HKDF-SHA-256.

Station-scoped — guard per S2-D10:

| Method and path | Roles | Purpose |
|---|---|---|
| `GET /stations/{stationId}` | all | Station profile (name, frequency, time zone, status). |
| `GET /stations/{stationId}/clients` | all | Clients, alphabetical. |
| `POST /stations/{stationId}/clients` | owner, manager | `{ name }` (1–80 characters; duplicate name → 409). |
| `GET /stations/{stationId}/ads?cursor=` | all | Newest-updated first, 20 per page, cursor pagination; each row: title, client, status, duration, campaign status (Draft / Scheduled / Live now / Paused / Ended computed in the station's time zone), schedule summary, dates. |
| `POST /stations/{stationId}/ads` | owner, manager | `{ clientId, title (1–120), upload: { fileName, contentType: audio/mpeg|audio/wav|audio/mp4, sizeBytes: 1…20 MiB } }` → `{ adId, upload: { method: 'PUT', url, headers, expiresAt } }`. Key `ad-uploads/<stationId>/<adId>/<attemptId>`; URL valid 10 min. |
| `POST /stations/{stationId}/ads/{adId}/upload-url` | owner, manager | Fresh upload attempt (retry / replace a failed upload). |
| `POST /stations/{stationId}/ads/{adId}/complete` | owner, manager | HEAD: exact size and type; ranged GET (first 64 bytes, If-Match the ETag): MP3 (`ID3` or frame sync), WAV (`RIFF`…`WAVE`), M4A (`ftyp` with an allowed brand). Mismatch → object deleted, ad `FAILED` with a code, 400 `UPLOAD_REJECTED`. Success → `PROCESSING`. Idempotent. |
| `GET /stations/{stationId}/ads/{adId}` | all | Detail incl. latest card, schedule, upload facts. |
| `GET /stations/{stationId}/ads/{adId}/playback-url` | all | 5-minute presigned GET. |
| `PUT /stations/{stationId}/ads/{adId}/card` | owner, manager | Body = action card (contract); inserts a new immutable version. |
| `PUT /stations/{stationId}/ads/{adId}/schedule` | owner, manager | `{ startsOn, endsOn (station-local dates, end ≥ start), timeWindows: [{ daysOfWeek: [1–7], localStartTime: 'HH:MM', localEndTime: 'HH:MM' }] (1–21 windows, start ≠ end), gracePeriodMinutes: 0|5|10|20, engagementLimit?: positive integer }` → creates or replaces the ad's draft campaign. |
| `POST /stations/{stationId}/ads/{adId}/publish` | owner, manager | Needs upload verified, a card and a schedule (else 409 `AD_NOT_READY_TO_PUBLISH` with the missing parts as field codes); sets the campaign `ACTIVE` with the latest card version; overlapping live campaign → 409. |

Every write writes an `audit_events` row (action, entity type and id, changes without secrets,
request id) in the same transaction. Errors use the catalogue; new codes: `INVALID_CREDENTIALS` (401),
`STATION_NOT_ACTIVE` (403), `UPLOAD_REJECTED` (400), `AD_NOT_READY_TO_PUBLISH` (409). The validation
pipe also relays a fixed allow-list of our own reason codes (password policy, card rules).

## Scripts and infrastructure

- `infra/docker-compose.yml` gains `object-storage` (versitygw, 127.0.0.1:59000, named volume, health check).
- `npm run object-storage:prepare` creates the private bucket `lookup-ad-uploads` if missing and sets CORS
  (`PUT`, `GET` from the portal origin; header `Content-Type`; expose `ETag`).
- `npm run database:seed` creates "Station A · 98.1 FM" (ACTIVE), its owner (email and password from
  `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD`, policy-checked) and two clients. Refuses to run when
  `NODE_ENV=production`.
- New configuration: `AUTHENTICATION_SECRET`, `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_PUBLIC_ENDPOINT`,
  `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_ACCESS_KEY_ID`, `OBJECT_STORAGE_SECRET_ACCESS_KEY`,
  `OBJECT_STORAGE_AD_UPLOADS_BUCKET`. Presigned URLs, tokens and password fields are added to log redaction.

## Portal (`apps/portal`)

Structure: `src/app` (router, query client, shell), `src/api` (one fetch client: credentials included,
request id on every call, one refresh-and-retry on 401 under a Web Lock, error envelope parsed into
plain messages with the request id shown), `src/features/<feature>` (`sign-in`, `ads-list`, `new-ad`,
`ad-detail`), `src/components` (buttons, inputs, badges, phone preview), `src/design` (tokens from
`packages/design-tokens/tokens.json` as CSS variables and the Tailwind theme).

Screens, following the wireframes (`AdsDesktop`, `AdsMobile`, `NewAdUpload`, `NewAdButtons`,
`NewAdSchedule`, `NewAdScheduleMobile`, `AdDetail`):

- **Sign in** — email, password (show/hide, paste allowed, `autocomplete`), plain error with request id.
- **Shell** — sidebar at ≥ lg (station name and frequency, nav, user, sign out); top bar with a drawer below.
- **Ads list** — table at ≥ md, cards below; client avatar, title, length, file status badge, campaign
  badge, schedule summary, dates, Play (loads audio only when tapped); Upload ad button; empty state,
  skeleton rows, error state with request id; status refresh every 5 s with backoff while any row is
  processing. (Tabs, filters, search, sort and bulk actions are phase 5b.)
- **New ad wizard** — steps Client → Audio → Buttons → Schedule → Review; draft saved at each step
  (the ad exists from the Audio step); sticky bottom action bar on phones.
  - Audio: MP3/WAV/M4A, ≤ 20 MB, 5 s – 2 min hint; progress bar (XMLHttpRequest upload progress), retry,
    "Uploaded → Preparing it for recognition… → Ready for listeners".
  - Buttons: up to 6 actions of the four types; Zambian phone input normalised (0977 123 456 →
    +260977123456) and shown for confirmation; live phone preview rendered from the same contract at
    320 px and 411 px; desktop side-by-side, phones Edit / Preview tabs.
  - Schedule: start and end dates, station time zone shown; desktop weekly hour grid, phones day chips
    and time pickers; grace period (None / 5 / 10 / 20 min); optional tap limit.
  - Review: summary and Publish.
- **Ad detail** — overview (player, status, card preview), buttons, schedule; polling while processing.

Accessibility: real buttons/links/labels, 44 px targets, visible focus, 4.5:1 contrast, colour never
the only signal, works at 320 px.

## Tests (nothing skipped; `|| true` never)

- **contracts:** every valid/invalid fixture through zod (asserting paths and codes), the emitted JSON
  Schema equals the committed file, ajv agrees on every structural fixture, phone normalisation and
  action-URI fixtures.
- **database:** the API cannot read or write password hashes, sessions or refresh tokens; only
  `lookup_api` executes the new functions; every SECURITY DEFINER function has the pinned search path;
  the settings function never returns the hash; case-insensitive email; rotation outcomes (normal, grace,
  fourth branch, reuse after 31 s revokes, expiry, disabled user); failure backstop; ad status guard.
- **API e2e:** exact Set-Cookie attributes; identical responses for unknown email and wrong password;
  identical 429s for real and fake accounts; a trusted device is not blocked; 503 when Valkey is down;
  an old access cookie is refused right after sign-out, password change or disabling; reuse kills both
  cookies; cross-site Origin gets 403 on sign-in and refresh; password policy edges (14/15, 128/129 code
  points, NFC forms, blocklisted, personal details); argon2 parameters in the stored hash; station B gets
  404 on every one of station A's ids; ANALYST writes get 403; upload round trip against versitygw
  (correct PUT 200; larger, smaller or different type 403; expired 403; wrong first bytes → FAILED and
  object deleted); CORS preflight for the bucket; card with a `javascript:` link or bad phone → 400 with
  the field path; schedule validation; publish preconditions; audit rows for every write; leak and log
  capture suites over every new route.
- **portal (vitest + Testing Library):** API client refresh-once logic and error parsing, sign-in form,
  phone normaliser in the form, card preview renders the reader rules, schedule grid to time windows,
  upload progress and retry.
- **Playwright (Chromium) at 375 px and 1280 px:** sign in → new ad (client, upload a real small MP3,
  buttons, schedule) → publish → the ad appears in the list as Processing with its campaign badge;
  wrong password shows the plain error; signing out returns to Sign in.

## Order of work (each increment ends green)

1. `packages/contracts`: action-card schema, fixtures, emitted JSON Schema, phone normaliser, tests.
2. Migration `StationPortal` + database tests.
3. Authentication feature + tests.
4. Station guard, station profile, clients, audit helper + tests.
5. Object storage (compose, prepare script, storage module) + ads endpoints + upload tests.
6. Cards, schedule, publish + tests; seed script.
7. Portal scaffold, design tokens, API client, shell, sign in.
8. Ads list and ad detail.
9. New ad wizard.
10. Playwright journeys.
11. Gate: requirements checklist for S2 ticked with evidence, review, security baseline rows updated, commit, push.

## Downloads (metered)

versitygw image 30 MB; npm packages for the API (AWS SDK, argon2, jose) about 3 MB; password blocklist
0.8 MB (8.8 MB only if the smaller list has too few long entries); portal packages (React, Vite, Tailwind,
router, query, testing libraries, jsdom, fonts) roughly 60–80 MB; Playwright Chromium about 150 MB.
Total roughly 250 MB, within the approved plan's estimate for the slice.
