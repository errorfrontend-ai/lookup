# Step 5a — Registration and admin: design

*Decided 10 October 2026, with the user's answers in §11. This file decides how phase 5a is built; the
build follows it, and a decision that changes during the build is changed here first.*

**Scope.** Plan phase 5a ("Registration & admin"):
- **Station sign-up.** A four-step self sign-up that saves as it goes ("Your account", "Verify", "Station details", "Licence"), with an SMS one-time code, an email link, a human check, and the logo and licence uploads.
- **Application status.** Edit and resubmit, and changes to an approved station waiting for review (O2).
- **The super-admin console.** Two-factor sign-in, the applications queue, Stations, "Audio to check", System health, and "Find by reference code".
- **Team.** Invitations and removing members.
- **Notifications.** SMS and email sent through a queue.

**Requirements.** Every `P5A-` item in `docs/requirements/checklist-4-portal-registration-dashboards.md` — **187 items** — is mapped in §10. Bound by:
- the conflicts 1–23 and gaps 1–21 of that file;
- `docs/conventions.md`;
- `docs/security-baseline.md`;
- the error, logging and test rules in the user's CLAUDE.md.

**Sources read.**
- The checklist part 4: how to read it, conflicts, the whole P5A section, gaps 1–21.
- The approved plan:
  - D6, G7, G15, G16;
  - §Station registration & dashboards A–B and the Team part of C;
  - §E Notifications;
  - the data model rows for stations, portal_users, invitations, `fp.asset_overlaps` and audit_events;
  - the roles and RLS sketch;
  - §Mobile D;
  - Cross-cutting;
  - Phases rows 1 and 5a;
  - O2, O5, O6, O16.
- The wireframes in `c:\tmp\lookup-workflows\wireframes\`: SignupAccount, SignupVerify, SignupStation, SignupLicence, AppStatus, AdminQueue. Their wording below is copied from them.
- The built code:
  - authentication (sign-in, sessions, password policy, the guards);
  - the station-access guard;
  - the rate limiter;
  - the error catalogue and filter;
  - logging and redaction;
  - the audit trail;
  - object storage;
  - job queues;
  - the key-value store;
  - configuration;
  - the seven migrations;
  - the contracts (`stations/`, `authentication/`, `phone-numbers/`, `errors/reference-code.ts`);
  - the portal's routes, shell, API client, plain words, components and test set-up;
  - Playwright;
  - the seed;
  - the API test harness.
  Read on 9 October 2026; condensed in the session notes.
- Outside facts, checked 9 October 2026 (sources in §9):
  - the Independent Broadcasting Authority's public list;
  - SMS providers in Zambia;
  - Cloudflare Turnstile;
  - Mailpit;
  - sharp;
  - TOTP (RFC 6238);
  - NIST SP 800-63B-4;
  - OWASP ASVS 5.0;
  - the Zambia Data Protection Act.

**Facts found while reading that change the work.**
1. **Nothing can create a station, a portal user or a membership except the seed.** The seed runs as the owner. `lookup_api` has no INSERT on `stations` or `portal_users`, and that is tested. Sign-up therefore goes through narrow SECURITY DEFINER functions (gap 1; §2.8).
2. **The station would exist before it has a name.** The plan creates the station at step 1, with status `PENDING_VERIFICATION`, but its name and frequency are asked at step 3. Today both columns are `NOT NULL`. They become nullable only while the status is `PENDING_VERIFICATION` (§2.1).
3. **The API has no connection as `lookup_admin_api`.** Tests reach the role with `SET LOCAL ROLE` only. Admin endpoints get a second data source with the same start-up checks (§3.1).
4. **`lookup_api` cannot write an audit row without a current station** (row-level security). Registration rows that have no station context are written inside the definer functions, as sign-in already does.
5. **No injectable clock, and the database's `now()` cannot be faked.**
   - Code expiry and the resend cooldown are compared in the API against an injected clock (§3.1).
   - Database expiries (email links, invitations) are tested by moving the stored expiry.
6. **Request ids are text with no index** in both `recognition_events` and `audit_events`. "Find by reference code" needs prefix indexes (§2.7).
7. **`fingerprints.audio_assets` keeps no audio object.** The A/B preview plays the upload of an ad that uses each asset.
8. **`platform_role` is never read anywhere.** `SUPPORT` has no defined powers, so it gets no admin access in 5a (gap 11).
9. **The portal has no content security policy yet.** Turnstile's script and frame, and the licence preview, are added to the list that the deploy phase writes into the static site's headers (§8).
10. **Zambia's Data Protection Act No. 3 of 2021 s.70**, as reported by CIPESA and Securiti (the official text could not be opened), requires personal data to be stored on servers in Zambia unless the Minister prescribes otherwise. Sign-up stores names, phone numbers, emails and licence documents. Hosting in Frankfurt (D2) is therefore a legal question for O7 before the pilot. It does not change the 5a build, which keeps personal data minimal and out of logs.

---

## 1. The phase at a glance

| # | Journey | Screens |
|---|---|---|
| A | A visitor registers a station | `/signup` (step 1, human check) → signed in → Verify (SMS code + email link) → Station details (+ logo) → Licence (+ document, confirm) → **Submit for review** → Application status |
| B | An applicant comes back | Sign in → the first unfinished step, or Application status once submitted |
| C | A super admin reviews | Sign in → **two-factor code** → Applications → pick one → open the licence (5-minute link) → **Approve station** or **Reject** with a reason → the station gets an SMS and an email |
| D | A rejected applicant fixes it | Sign in → Application status shows "Rejected" and the reason word for word → Edit application → **Submit again** → back in the queue |
| E | An approved station renames itself (O2) | Station profile → "Change name, frequency or licence" → the request waits in the admin queue; the station stays live under its approved details until a super admin approves |
| F | An owner builds the team | Team → invite by email with a role → the invitee opens the email link → creates an account or signs in → member |
| G | A super admin suspends a station | Stations → Suspend (reason) → the station's cards stop at the next recognition; Reactivate brings them back |
| H | Support | A person quotes the reference code from an error → Find by reference code → what happened |

---

## 2. Database — migration `1791800000000-RegistrationAndAdmin`

*Renumbered in the build (14 October 2026): `1791600000000` and `1791700000000` were taken by P4's station resolution and fingerprint version 2.*

The released migrations' checksums are pinned (`source-scan.test.ts`), so everything below is one new migration. Names follow `docs/conventions.md`:
- full words;
- `_at` for times;
- `is_` for booleans;
- every constraint named;
- every definer function with `SET search_path = pg_catalog` and `EXECUTE` granted to one role only.

### 2.1 `app.stations` — new columns and rules

| Column | Type and rule | Item |
|---|---|---|
| `coverage_note` | text, 1–300, nullable | P5A-DATABASE-01 |
| `stream_address` | text, `https://` only, ≤ 500, nullable | P5A-DATABASE-01, STATION-DETAILS-09 |
| `contact_name` | text, 1–120, nullable | P5A-DATABASE-03 |
| `contact_phone_number_e164` | text, `^\+[1-9][0-9]{6,14}$` (named check), nullable | P5A-DATABASE-03 |
| `phone_verified_at`, `email_verified_at` | timestamptz, nullable | P5A-DATABASE-04 |
| `licence_number` | text, 1–60, nullable | P5A-DATABASE-02 |
| `licence_document_object_key` | text, nullable; **no SELECT for `lookup_api`** | P5A-DATABASE-02, LICENCE-05 |
| `licence_document_file_name` | text, 1–120 (shown to the applicant and the reviewer only) | P5A-SIGNUP-SCREENS-23 |
| `licence_document_content_type` | `application/pdf` or `image/jpeg` | P5A-LICENCE-02 |
| `licence_document_byte_count` | integer 1–5,242,880 | P5A-LICENCE-02 |
| `licence_document_uploaded_at` | timestamptz | — |
| `licence_confirmed_at` | timestamptz: when the applicant ticked "I confirm this station holds a valid broadcasting licence in Zambia." | P5A-LICENCE-07 |
| `application_submitted_at` | timestamptz: the latest submission; the queue's order | P5A-ADMIN-QUEUE-01 |
| `review_note`, `reviewed_by_portal_user_id` (→ `portal_users`, `ON DELETE SET NULL`), `reviewed_at` | the last decision | P5A-DATABASE-05, ADMIN-QUEUE-18 |

- **`name` and `frequency_label` lose `NOT NULL`.** The check `stations_details_required_after_verification_check` makes them required in every status except `PENDING_VERIFICATION`. Every existing row satisfies it, since both were `NOT NULL` before. Completeness of everything else (province, city, licence, verifications) is enforced by the submit function, not by a check. Older rows created by the seed and the tests have no licence, so a check would break every later update of them.
- **Status changes are checked by a trigger.** `stations_status_change_trigger` (BEFORE UPDATE OF status) refuses any change not in the table below, for every role. A superuser is exempt: only the local seed and the tests connect as one, and the app never does. The trigger complements the grants: `lookup_api` still has no privilege on `status`, and status changes on the station's behalf happen only inside definer functions (P5A-STATION-STATUS-03).

| From → to | Who | Through |
|---|---|---|
| `PENDING_VERIFICATION` → `PENDING_REVIEW` | the applicant | `app.submit_station_application` |
| `REJECTED` → `PENDING_REVIEW` | the applicant | `app.submit_station_application` (resubmission) |
| `PENDING_REVIEW` → `ACTIVE` | a super admin | the admin approval route |
| `PENDING_REVIEW` → `REJECTED` | a super admin | the admin rejection route |
| `ACTIVE` → `SUSPENDED` | a super admin | the admin suspension route |
| `SUSPENDED` → `ACTIVE` | a super admin | the admin reactivation route |

- **Admin-only moves.** The trigger also requires `current_user = 'lookup_admin_api'` for the moves to `ACTIVE`, `REJECTED` and `SUSPENDED`, and `current_user = 'lookup_schema_owner'` (that is, inside a definer function) for the moves to `PENDING_REVIEW`.
- **The O2 move is not in the table.** The checklist's `ACTIVE → PENDING_REVIEW` (O2) is replaced by change requests, by the user's answer on 10 October 2026 (§2.4, P5A-D4).

### 2.2 `app.portal_users` and `app.portal_sessions`

- **`portal_users`** gains:
  - `two_factor_secret_ciphertext` bytea: AES-256-GCM, encrypted by the API (§5.4);
  - `two_factor_enrolled_at`;
  - `two_factor_last_used_time_step` bigint.

  Neither API role gets any privilege on these columns (P5A-DATABASE-06).
- **`portal_sessions`** gains `two_factor_verified_at`.
- **`app.describe_active_portal_session`** (new) returns the session's owner, `platform_role` and `two_factor_verified_at`; the signed-in guard calls it. *Changed in the build:* `find_active_portal_session` keeps its return type, because `change_portal_user_password` calls it.
- **Revocation reasons** gain `TWO_FACTOR_RESET`: resetting a lost authenticator ends that super admin's sessions (gap 12).

### 2.3 `app.email_verification_links` (new)

`id` uuid, `station_id`, `portal_user_id`, `token_hash` bytea (32 bytes, unique), `sent_to_email` citext, `expires_at`, `confirmed_at`, `superseded_at`, `created_at`.

- Row-level security is on with no policies, and neither API role has any grant on the table: definer functions only.
- A link lasts **24 hours**. NIST SP 800-63B-4 §4.2.2 uses 24 hours for codes sent by email.
- Sending a new link supersedes the open ones (gap 3).

### 2.4 `app.station_change_requests` (new; O2 as the user chose)

`id`, `station_id`, `name`, `frequency_label`, `licence_number`, `licence_document_object_key`, `licence_document_file_name`, `licence_document_content_type`, `licence_document_byte_count` (the document fields are all null or all set), `requested_by_portal_user_id`, `requested_at`, `decision` (`APPROVED` | `REJECTED` | `WITHDRAWN`, null while open), `decision_note`, `decided_by_portal_user_id`, `decided_at`.

- A partial unique index allows one open request per station.
- **`lookup_api`:** SELECT on every column except `licence_document_object_key`, with row-level security `station_id = app.current_station_id()`. Writes go through definer functions.
- **`lookup_admin_api`:** SELECT and UPDATE, with a full-access policy.
- Approval copies the values onto the station in one transaction.

### 2.5 `app.invitations` (new; plan name kept)

`id`, `station_id`, `kind` (`STATION_MEMBER` | `CLIENT_VIEWER`), `station_role` (OWNER | MANAGER | ANALYST, required for `STATION_MEMBER`), `client_id` (required for `CLIENT_VIEWER`, with a composite foreign key `(client_id, station_id)` → `clients`), `invited_email` citext, `token_hash` bytea (32 bytes, unique), `expires_at`, `invited_by_portal_user_id` (`ON DELETE SET NULL`), `accepted_at`, `accepted_by_portal_user_id`, `revoked_at`, `created_at`.

- **Checks:**
  - the kind matches its target fields;
  - accepted and revoked never both set;
  - a partial unique index allows one open invitation per (station, email, kind, client).
- **`lookup_api`:** SELECT on every column except `token_hash`, with row-level security on the current station. Writes go through definer functions.
- Lifetime **7 days** (gap 22). An invitation is single-use.
- `CLIENT_VIEWER` exists in the schema (P5A-DATABASE-07, TEAM-07). Phase 5c adds the functions that create one.

### 2.6 `fingerprints.asset_overlaps` (new; P5A-OVERLAP-REVIEW-04)

`id`, `audio_asset_id`, `overlapping_audio_asset_id` (both → `fingerprints.audio_assets`), `overlap_milliseconds`, `found_at`, `reviewed_at`, `reviewed_by_portal_user_id`, `review_note`.

- **Checks:** the two assets differ, and each pair is unique.
- **Access:** no grants to `lookup_api` or `lookup_admin_api`. The admin role reads and records reviews only through two definer functions (§2.8), which is the narrowest of the two paths the checklist offers (P5A-D11).
- **Who fills it:** the fingerprint worker, from phase 8. In 5a, tests seed findings directly.

### 2.7 Indexes

- `recognition_events_request_id_index` and `audit_events_request_id_index`, on `(request_id text_pattern_ops)`, for prefix search by reference code (§4.6).
- `stations_application_queue_index` on `(status, application_submitted_at)`.

### 2.8 Definer functions

Every function:
- checks its caller's right inside itself, since definer functions bypass row-level security;
- writes its own audit row;
- returns an outcome word instead of raising, except for constraint violations that the API maps.

**For `lookup_api`:**

| Function | What it does |
|---|---|
| `app.register_station_applicant(email, full_name, phone_number_e164, password_hash, new_refresh_token_hash, request_id)` | Creates the portal user, the station (`PENDING_VERIFICATION`, its contact = the applicant), the OWNER membership and a session (through `app.issue_portal_session`). Audit `station_application_started`. A duplicate email raises the unique violation on `portal_users_email_unique`, which the API maps (P5A-SIGNUP-07). |
| `app.change_applicant_contact(station_id, full_name, email, phone_number_e164, request_id)` | Step 1 edited later (Back from step 2, or Edit application). Allowed for the station's OWNER while `PENDING_VERIFICATION`, `PENDING_REVIEW` or `REJECTED`. A changed phone clears `phone_verified_at`; a changed email clears `email_verified_at` and supersedes open links. Returns which were cleared. |
| `app.record_station_phone_verified(station_id, phone_number_e164, request_id)` | Sets `phone_verified_at` only if the contact phone is still the number the code was sent to. |
| `app.issue_email_verification_link(station_id, token_hash, request_id)` | Supersedes the open links, stores the new one and returns the address to send it to. |
| `app.confirm_email_verification_link(token_hash, request_id)` | Callable without a station context, so the link works on any device. Returns `CONFIRMED`, `ALREADY_CONFIRMED`, `EXPIRED`, `SUPERSEDED`, `EMAIL_CHANGED` or `NOT_FOUND`. |
| `app.save_station_application_details(station_id, name, frequency_label, province, city, time_zone, coverage_note, stream_address, request_id)` | Step 3. Allowed while `PENDING_VERIFICATION`, `PENDING_REVIEW` or `REJECTED`. Checks the province against the 10 and the time zone against `pg_timezone_names`. |
| `app.save_station_licence_number(station_id, licence_number, request_id)` | Step 4, in the same statuses. |
| `app.attach_station_licence_document(station_id, object_key, file_name, content_type, byte_count, request_id)` | In the same statuses. Returns the replaced object's key so the API can delete it. |
| `app.submit_station_application(station_id, request_id)` | `PENDING_VERIFICATION` or `REJECTED` → `PENDING_REVIEW`, if complete: name, frequency, province, city, licence number, licence document, both verifications, and the confirmation. Sets `licence_confirmed_at` and `application_submitted_at`. Otherwise returns `INCOMPLETE` with the missing parts. |
| `app.request_station_detail_change(station_id, name, frequency_label, licence_number, document…, request_id)` | O2 for an `ACTIVE` station: opens a change request. Refused if one is already open or if nothing differs. |
| `app.withdraw_station_detail_change(station_id, request_id)` | Withdraws the open change request. |
| `app.find_two_factor_secret(session_id)` | Returns the ciphertext and the last used time step, only for a live session of an enrolled `SUPER_ADMIN`. |
| `app.record_two_factor_attempt(session_id, accepted_time_step, request_id)` | A null step records a failure. Otherwise it accepts only a step greater than the last used one, then sets `two_factor_verified_at` on the session. Audit `two_factor_succeeded` or `two_factor_failed`. |
| `app.create_station_invitation(station_id, invited_email, station_role, token_hash, request_id)` | OWNER of the current station only. Revokes an open invitation to the same email; refuses an email that already belongs to a member. |
| `app.revoke_station_invitation(station_id, invitation_id, request_id)` | OWNER only. |
| `app.describe_invitation(token_hash)` | Returns the state, station name and frequency, role, the invited email, whether that email already has an account, and the expiry. |
| `app.accept_invitation_with_new_account(token_hash, full_name, phone_number_e164, password_hash, new_refresh_token_hash, request_id)` | Creates the user and the membership, then a session. |
| `app.accept_invitation_for_signed_in_user(token_hash, request_id)` | Uses `app.current_user_id()`. Refuses if the signed-in email differs from the invited one. |
| `app.remove_station_member(station_id, portal_user_id, request_id)` | OWNER only. Locks the station's OWNER rows (`FOR UPDATE`) and refuses to remove the last OWNER. |

**For `lookup_admin_api`** (*in `app`, changed in the build:* calling a function in `fingerprints` needs USAGE on that schema, which neither API role may hold, S1-PRIVILEGES-11; both check that the signed-in user is an active SUPER_ADMIN):

| Function | What it does |
|---|---|
| `app.list_asset_overlaps_for_review()` | Each finding, its two assets, and the ads (with stations) that use each asset. |
| `app.record_asset_overlap_review(finding_id, note, request_id)` | Marks a finding checked, with the super admin as actor. |

**Admin decisions on stations** (approve, reject, suspend, reactivate, decide a change request) are plain SQL as `lookup_admin_api`. That role already has full-access policies and UPDATE on `stations`. The transition trigger enforces the allowed moves.

### 2.9 Grants

- **`lookup_api` on `stations`:** the table-wide SELECT becomes SELECT on every column except `licence_document_object_key`. UPDATE stays `(province, city, time_zone, logo_object_key, is_listed_in_app)`.
- **New tables:**
  - **`lookup_api`:** column SELECT on `invitations` and `station_change_requests`, as above; nothing on `email_verification_links` or `asset_overlaps`.
  - **`lookup_admin_api`:**
    - `stations`: everything it had, including the licence key;
    - `station_change_requests`: SELECT and UPDATE;
    - `invitations`: SELECT, without the token hash;
    - the two fingerprint functions: EXECUTE.
- Every grant gets a privilege test (P5A-DATABASE-09).

---

## 3. API

### 3.1 New infrastructure

- **Clock.** `common/time/clock.ts` provides `Clock` (`now(): Date`) and the token `CLOCK`. Code expiry and the resend cooldown read it, and tests override it.
- **Admin database.**
  - `infrastructure/database/admin-database.module.ts` holds a second TypeORM data source on `ADMIN_DATABASE_URL`, pool max 3.
  - It runs the same start-up refusal (superuser, row-level-security bypass, table owner) and also checks that `current_user` is `lookup_admin_api`.
  - `AdminTransaction` sets `app.current_user_id` and `app.current_station_id` per call, so audit rows name the super admin and the station.
  - The source scan allows only `features/admin/` to use it.
- **Notifications** (`features/notifications/`, P5A-STRUCTURE-04):
  - **The queue.** A BullMQ `notify` queue: 5 attempts, exponential back-off from 30 s, `removeOnComplete` and `removeOnFail` true.
  - **Deadlines.** Each job carries a deadline: 10 minutes for a code (useless after it expires), 24 hours otherwise.
  - **The worker** runs inside the API process (`NOTIFICATION_SENDING_ENABLED`, default true), with concurrency 2 and a heartbeat key. Several API instances share the queue safely (P5A-D9).
  - **Senders:**
    - `EmailSender` → `SmtpEmailSender` (nodemailer). In development it uses Mailpit on `127.0.0.1:1025`. In production it must be `smtps://`, or STARTTLS with certificate checks.
    - `SmsSender` → `DevelopmentSmsSender`, which delivers each SMS as an email to the development inbox, subject "SMS to +260 97 ••• ••12", so one inbox shows both channels (P5A-NOTIFICATIONS-04).
    - **No real SMS provider** is built before O16's checks are recorded (P5A-NOTIFICATIONS-05). Production configuration refuses the development sender, so production cannot start a sign-up that would never send a code.
  - **Logs.** Every job carries the request id that caused it. Log lines name the recipient only by `hashIdentifier`.
- **Human check** (`common/security/human-check.ts`):
  - `CloudflareTurnstileVerifier` posts to `https://challenges.cloudflare.com/turnstile/v0/siteverify` with a 5 s timeout, up to two retries with the same `idempotency_key`, and the client address. It accepts only:
    - `success: true`;
    - the portal's own host;
    - action `station-sign-up`.

    If Cloudflare cannot be reached it **refuses** (503 `HUMAN_CHECK_UNAVAILABLE`), so an outage cannot open sign-up to bots (gap 4).
  - `TurnstileTestKeyVerifier`, for development and test only, answers offline exactly as Cloudflare's published test secrets do:
    - `1x0000000000000000000000000000000AA` passes only the dummy token `XXXX.DUMMY.TOKEN.XXXX`;
    - `2x…AA` always fails;
    - `3x…AA` answers `timeout-or-duplicate`.
  - Production refuses the test secrets (P5A-SIGNUP-08).
- **One-time codes** (`features/registration/phone-verification-codes.ts`):
  - The code is `crypto.randomInt(0, 1_000_000)`, zero-padded to 6 digits.
  - It is kept in Valkey at `phone-verification-code:<station id>` as an HMAC-SHA-256 with a key derived from `AUTHENTICATION_SECRET` (`DerivedKeys`, label "one-time codes"). Only the hash is stored, and a stolen store cannot be brute-forced offline without the key. The hash covers the code and the phone number it was sent to.
  - Alongside the hash: the phone's hash, `sentAt`, `expiresAt` (+10 minutes), and `failedAttempts`.
  - A Lua script checks and counts atomically:
    - expired → `EXPIRED`;
    - `failedAttempts ≥ 5` → `LOCKED`;
    - wrong → increment;
    - right → delete.
  - The key's TTL is 11 minutes, only to clean up.
- **Object storage.**
  - Two new private buckets:
    - `OBJECT_STORAGE_LICENCE_DOCUMENTS_BUCKET` (`lookup-licence-documents`): CORS PUT only, no GET origin;
    - `OBJECT_STORAGE_STATION_LOGOS_BUCKET` (`lookup-station-logos`): PUT, and GET from the portal origins.
  - `createUploadUrl` and `createDownloadUrl` take the bucket.
  - A download URL can fix the response's content type and an inline disposition, so a stored file is never served as HTML.
  - `prepare-object-storage.ts` creates both buckets.
- **Images.**
  - `features/registration/station-logo-processing.ts` uses sharp 0.35.5:
    - `limitInputPixels` 25 megapixels, `failOn: 'error'`;
    - auto-rotate, strip metadata;
    - fit inside 512 × 512 without enlarging;
    - WebP, quality 85.
  - At most 2 run at once, like password hashing.
  - The original upload is deleted after processing (P5A-STATION-DETAILS-06).

### 3.2 Upload flow (logo, licence document, change-request document)

1. `POST …/uploads` with `{ fileName, contentType, byteCount }`:
   - the API checks the declared type and size against the allowed list;
   - generates the key (`<purpose>/<station id>/<random uuid>`, with nothing the applicant typed);
   - stores the pending upload in Valkey (`station-upload:<upload id>`, 15 minutes);
   - answers with a presigned PUT whose signature fixes `content-type` and `content-length` (10 minutes).
2. The browser PUTs straight to the bucket with progress (XHR), and can retry with a new upload id.
3. `POST …/uploads/:uploadId/complete`:
   - HEAD must match the signed size and type;
   - the first bytes must carry the file's signature (PDF `%PDF-`, JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`);
   - the size limit is checked **before** sharp is ever called.

   A refused file is deleted and answered with `UPLOAD_REJECTED` and a reason (`wrong_file_type`, `file_too_large`, `image_too_small`, `image_unreadable`).

| Upload | Types | Largest |
|---|---|---|
| Logo | PNG, JPG (GIF and SVG refused) | 2 MB, at least 64 × 64 px (gap 6) |
| Licence document | PDF, JPG | 5 MB = 5,242,880 bytes |

### 3.3 Routes (all under `/api/v1`)

**Registration** (`features/registration`, P5A-STRUCTURE-01):

| Route | Who | Notes |
|---|---|---|
| `POST /registration/applicants` | public | Step 1. Turnstile token required. Creates the account and station and signs in (session cookies); answers `SignedInPortalUser` and the station id. Queues the first SMS code. |
| `GET /stations/:id/application` | station member, any status | The answers, the progress of each step, the masked phone, the email, the logo link (15 minutes), the licence document's name, type, size and upload time (never its key), the submitted time, and the reason only when rejected. |
| `PUT /stations/:id/application/account` | OWNER | Step 1 edited (name, email, phone); no password, no human check |
| `POST /stations/:id/application/phone-verification-codes` | OWNER | Sends or resends. 60 s cooldown (429 `RESEND_TOO_SOON` with `Retry-After`). |
| `POST /stations/:id/application/phone-verification` | OWNER | `{ code }`: `VERIFICATION_CODE_INCORRECT`, `VERIFICATION_CODE_EXPIRED` ("This code has expired. Send yourself a new one."), `VERIFICATION_CODE_LOCKED` |
| `POST /stations/:id/application/email-verification-links` | OWNER | Sends the link again. 60 s cooldown. |
| `POST /registration/email-verifications` | public | `{ token }`, from any device |
| `PUT /stations/:id/application/details` | OWNER | Step 3 |
| `POST /stations/:id/application/logo-uploads`, `…/:uploadId/complete` | OWNER | Logo |
| `PUT /stations/:id/application/licence` | OWNER | `{ licenceNumber }` |
| `POST /stations/:id/application/licence-document-uploads`, `…/:uploadId/complete` | OWNER | Licence document |
| `POST /stations/:id/application/submission` | OWNER | `{ isLicenceConfirmed: true }` |
| `GET /stations/:id/change-request`, `POST /stations/:id/change-requests`, `POST /stations/:id/change-request/withdrawal` | OWNER (read: any member) | O2 for `ACTIVE` stations |
| `POST /stations/:id/change-request/licence-document-uploads`, `…/complete` | OWNER | The new licence document |

**Authentication additions:**
- `GET /auth/me` adds `platformRole` and `isTwoFactorCodeNeeded`.
- `POST /auth/two-factor-code` takes `{ code }` and answers 204.

**Admin** (`features/admin`, P5A-STRUCTURE-03). Every route needs `SuperAdminGuard`: the session's user is `SUPER_ADMIN` **and** the session's `two_factor_verified_at` is set. Otherwise the answer is 403 `TWO_FACTOR_REQUIRED` or 404 for everyone else (P5A-ADMIN-ACCESS-01/04).

| Route | Notes |
|---|---|
| `GET /admin/summary` | The badges: applications waiting (new stations plus change requests), audio to check |
| `GET /admin/applications` | `PENDING_REVIEW` stations and open change requests, oldest first, with duplicate flags |
| `GET /admin/applications/:stationId` | Detail: checks, details (phone masked), licence fields; for a change request, current and proposed values side by side |
| `POST /admin/applications/:stationId/licence-document-link` | A 5-minute presigned GET with the stored content type and an inline disposition |
| `POST /admin/applications/:stationId/approval` | Refused unless the licence number and document are present (O5, P5A-ADMIN-QUEUE-19). Sends an SMS and an email. |
| `POST /admin/applications/:stationId/rejection` | `{ reason }`, 10–1,000 characters. Sends an SMS and an email. |
| `POST /admin/change-requests/:requestId/approval` and `…/rejection` | O2 decisions |
| `GET /admin/stations?search=&cursor=` | By part of the name, frequency or town. Status and the date of the last decision. |
| `POST /admin/stations/:stationId/suspension` and `…/reactivation` | `{ reason }` for suspension. SMS and email (critical alerts, §3.6). |
| `GET /admin/audio-overlaps`, `POST /admin/audio-overlaps/:findingId/preview-links`, `POST /admin/audio-overlaps/:findingId/review` | "Audio to check" |
| `GET /admin/system-health` | §4.6 |
| `GET /admin/reference-codes/:code` | §4.6 |

**Team** (`features/members`, P5A-STRUCTURE-02). A new station-access requirement, `MANAGE_STATION_TEAM`, means OWNER of an active station.

| Route | Who |
|---|---|
| `GET /stations/:id/members` | Any member: members, and pending invitations without tokens |
| `POST /stations/:id/invitations` | OWNER: `{ email, role }` |
| `POST /stations/:id/invitations/:invitationId/revocation` | OWNER |
| `DELETE /stations/:id/members/:portalUserId` | OWNER |
| `POST /invitations/description` | public: `{ token }` |
| `POST /invitations/acceptance-with-new-account` | public: `{ token, fullName, phoneNumber?, password }` → signed in |
| `POST /invitations/acceptance` | signed in: `{ token }` |

The cross-site check that already guards `/auth/*` (Origin or Referer required on every non-GET) extends to `/registration/*` and `/invitations/*`, because they set session cookies.

### 3.4 Rate limits

Every limit below refuses when the counter store is down; where a limit is per account, the per-address limit applies as well (P5A-VERIFICATION-07/08, ADMIN-ACCESS-10).

| What | Per address | Per account / station / phone |
|---|---|---|
| Creating an applicant | 5 per hour | 3 per phone number per day (gap 5) |
| Sending a phone code | 10 per hour | 5 per station per hour, plus the 60 s cooldown |
| Checking a phone code | 30 per 15 min | 10 per station per 15 min, plus 5 wrong per code |
| Sending an email link | 10 per hour | 5 per station per hour, plus the 60 s cooldown |
| Confirming an email link | 20 per 10 min | — |
| Two-factor code | 20 failures per 15 min | 5 failures per account per 15 min |
| Invitations | — | 20 per station per day |
| Describing or accepting an invitation | 20 per 10 min | — |
| Upload addresses | — | 20 per station per hour |

### 3.5 Errors added to the catalogue

| Code | Status | Public message (written for the user, relayed as written) |
|---|---|---|
| `EMAIL_ALREADY_REGISTERED` | 409 | This email already has an account. Sign in instead. |
| `HUMAN_CHECK_FAILED` | 400 | We couldn't confirm you're a person. Please do the check again. |
| `HUMAN_CHECK_UNAVAILABLE` | 503 | We couldn't run the human check just now. Please try again in a minute. |
| `VERIFICATION_CODE_INCORRECT` | 400 | That code isn't right. Check the SMS and try again. |
| `VERIFICATION_CODE_EXPIRED` | 400 | This code has expired. Send yourself a new one. |
| `VERIFICATION_CODE_LOCKED` | 400 | Too many wrong tries. Send yourself a new code. |
| `RESEND_TOO_SOON` | 429 | You can ask for a new one in a minute. |
| `EMAIL_LINK_EXPIRED` | 400 | This link has expired. Ask for a new one on the sign-up page. |
| `EMAIL_LINK_NOT_VALID` | 400 | This link doesn't work any more. Ask for a new one on the sign-up page. |
| `APPLICATION_INCOMPLETE` | 409 | Your application isn't finished yet. (`fields` name the missing parts) |
| `APPLICATION_NOT_EDITABLE` | 409 | This can't be changed at the moment. |
| `CHANGE_REQUEST_ALREADY_OPEN` | 409 | You already have a change waiting for review. |
| `TWO_FACTOR_REQUIRED` | 403 | Enter the code from your authenticator app first. |
| `TWO_FACTOR_CODE_INCORRECT` | 400 | That code isn't right. Use the current code in your authenticator app. |
| `INVITATION_NOT_VALID` | 400 | This invitation link doesn't work. Ask the station's owner for a new one. |
| `INVITATION_EXPIRED` | 400 | This invitation has expired. Ask the station's owner for a new one. |
| `INVITATION_FOR_ANOTHER_EMAIL` | 403 | This invitation was sent to another email address. Sign in with that one. |
| `ALREADY_A_MEMBER` | 409 | This person is already in your team. |
| `LAST_OWNER` | 409 | A station needs at least one owner. Invite another owner first. |
| `STATION_STATUS_CHANGE_NOT_ALLOWED` | 409 | This station's status can't change that way. |

**Enumeration trade-off (P5A-D7).** Step 1 tells a visitor that an email already has an account, as P5A-SIGNUP-07 requires. OWASP's pattern of answering the same either way does not fit a form whose next step is a code sent to the number just typed. The answer is rate-limited per address and behind the human check, so harvesting emails costs a solved challenge each.

### 3.6 Notifications

| Event | SMS | Email |
|---|---|---|
| Phone verification code: "Your Look Up code is 123456. It expires in 10 minutes. Don't share it." followed by the WebOTP line `@<portal host> #123456` | ✓ | — |
| Email verification link | — | ✓ |
| Application approved | ✓ | ✓ |
| Application rejected (the reason is in the email and on the status page; the SMS says to sign in) | ✓ | ✓ |
| Change request approved or rejected | ✓ | ✓ |
| **Critical alerts:** station suspended, station reactivated | ✓ | ✓ |
| Team invitation | — | ✓ |

- **Critical alerts (gap 20).** They are the two events that change whether the station's ads reach listeners: suspension and reactivation. They go to the station's contact phone (P5A-NOTIFICATIONS-02, -06).
- **Templates are plain text**, built from named parameters, with no HTML. A link is the portal's public address plus a fragment, for example `https://…/verify-email#token=…`. A fragment never reaches a server, so the token stays out of access logs.

### 3.7 Logging additions

- **Redacted paths:** `*.oneTimeCode`, `*.verificationCode`, `*.twoFactorCode`, `*.linkToken`, `*.humanCheckToken`, `*.token`, `*.objectKey`, `*.licenceDocumentObjectKey`, `*.downloadUrl`, `*.recipient`, `*.fullName`, `*.contactName`, `*.licenceNumber`, `*.reason`. *Changed in the build (14 October 2026):* not `*.code`, which would also hide a database error's SQLSTATE (`err.code`) that the logs need; every code is logged under its own name, so it is redacted by that name.
- `*.reason` is the rejection text, which may name people.
- Captured-log tests cover a full sign-up, a code resend and check, a licence upload, an admin view and every notification (P5A-LOGGING-01..03, NOTIFICATIONS-08).

---

## 4. Portal

### 4.1 Routes

| Path | Page | Chunk |
|---|---|---|
| `/signup` | Step 1 (public) | sign-up |
| `/verify-email` | The email link's landing page (public; reads `#token=`) | sign-up |
| `/invitations/accept` | Invitation (public; reads `#token=`) | sign-up |
| `/two-factor` | The super admin's code | admin |
| `/admin/applications`, `/admin/applications/:stationId`, `/admin/stations`, `/admin/audio-to-check`, `/admin/system-health`, `/admin/reference-codes` | The console | admin |
| `/stations/:stationId/application` | Application status, or the first unfinished step | sign-up |
| `/stations/:stationId/application/account`, `…/verify`, `…/details`, `…/licence` | Steps 1 (edit) to 4 | sign-up |
| `/stations/:stationId/team` | Team (inside the shell) | station |

- **Sign-up and admin areas** are lazy routes, so a station user never downloads them (P5A-STRUCTURE-05).
- **Home (`/`):**
  - a super admin goes to `/two-factor` or `/admin/applications`;
  - a `PENDING_VERIFICATION`, `PENDING_REVIEW` or `REJECTED` station goes to its application;
  - otherwise the overview, as today.
- **`RequireSignedIn`** lets a super admin with no station through, instead of showing "Ask your station's owner to add you".

### 4.2 Sign-up wizard (wireframes; one step per screen)

- **Header.**
  - Step 1 shows "Look Up", "for stations" and a "Sign in" link.
  - Steps 2–4 show a 48 × 48 Back button whose accessible name is "Back".
  - Below the header: "Step N of 4 · <name>", with the names "Your account", "Verify", "Station details" and "Licence".
  - A 4-segment bar has segments 1..N filled and `aria-hidden="true"`.
- **Layout.**
  - One column on a phone. From `lg` the form is two columns inside a centred card, which stays 1 column for the code and the document.
  - Inputs are at least 48 px with 16 px text.
  - The primary button is full width, at least 52 px, and sticks to the bottom on phones.
- **Step 1 — "Register your station"** ("About 5 minutes. We save as you go, so you can stop and come back.").
  - Fields:
    - "Your full name" (`autocomplete="name"`);
    - "Work email" (`type="email"`, `autocomplete="email"`, placeholder "you@yourstation.co.zm");
    - "Mobile number", with a fixed "+260" prefix (`type="tel"`, `autocomplete="tel-national"`, placeholder "97 123 4567", helper "We'll text a 6-digit code to this number.");
    - "Password" (`type="password"`, `autocomplete="new-password"`, helper "At least 15 characters.", by the user's answer).
  - The password is checked as typed for length; the API checks the rest.
  - The human check sits above "Continue".
  - The Turnstile script loads only on this page.
  - If the script cannot load, the step says "The human check couldn't load. Check your connection, then try again." and offers a "Try again" button.
- **Step 2 — "Check your phone".**
  - "We sent a 6-digit code by SMS to +260 97 ••• ••12."
  - "6-digit code" uses `inputmode="numeric"`, `autocomplete="one-time-code"` and `maxlength="6"`.
  - Where the browser offers WebOTP (`navigator.credentials.get({ otp })`), the code fills itself from the SMS.
  - "Didn't get it?" sits beside "Resend in 0:45" (`aria-live="polite"`), which becomes "Send a new code".
  - **"Confirm your email" panel:**
    - a "Waiting" pill that turns into "Confirmed";
    - "We sent a link to <email>. Open it on any device — this page updates by itself.";
    - "Send the link again".
  - **"This page updates by itself"** works by polling the application:
    - every 5 s for 2 minutes, then every 15 s;
    - stopping after 30 minutes with a "Check again" button;
    - refetching when the tab becomes visible.
  - "Continue" needs the phone confirmed. The email can be confirmed any time before submitting.
- **Step 3 — "About your station".**
  - Fields:
    - "Station name";
    - "Frequency" ("e.g. 98.1 FM", tidied with the existing frequency parser);
    - "Province" ("Choose province" plus the 10);
    - "City or town";
    - "Add logo · PNG or JPG", optional, with progress, retry and a preview.
  - **"More details (optional) — time zone, coverage, stream link"** is collapsed (`<details>`) and holds:
    - "Time zone" (default `Africa/Lusaka`; a select of the zones the browser knows);
    - "Coverage";
    - "Stream link (https)".
- **Step 4 — "Your broadcasting licence".**
  - "We check every station before it goes live. It stops fake stations putting scam buttons on real ads."
  - "Licence number".
  - "Licence document": file name, state ("Uploading 40 %", "Uploaded" in green, "Upload failed"), a progress bar and "Replace". Helper: "PDF or a clear photo, up to 5 MB. Only our review team can see it."
  - The confirmation checkbox, unticked by default.
  - "What happens next: we review your application within 2 working days and let you know by SMS and email."
  - **"Submit for review"**. If the email isn't confirmed yet, the step says so, with "Send the link again".

### 4.3 Application status (AppStatus wireframe)

- **Header:** "Look Up" and "Sign out".
- **Heading:** "Thanks — your application is in", then "<name> · <frequency>".
- **"Application progress"** is an ordered list:
  - "Submitted", with the date and time;
  - "Under review", with "Usually within 2 working days";
  - "Approved", with "We'll text and email you".

  Done stages show a check, the current one has `aria-current="step"`, and future ones show an empty circle.
- **When rejected**, the last stage reads "Rejected", followed by the reviewer's reason word for word.
- **"While you wait":** "You can still change your details. Uploading ads unlocks once your station is approved." and "Edit application", which opens step 3 with the saved answers. When rejected, the panel instead says "Fix what the reviewer asked, then submit again." and offers "Fix and submit again".
- **Footer:** "If anything is missing we'll tell you exactly what to fix — nothing is lost."
- **When approved** (seen if the page is open at that moment): "Your station is approved" with "Go to your station".

### 4.4 Two-factor and the admin console

- **`/two-factor`.**
  - "Enter the 6-digit code from your authenticator app"; the code field uses the same attributes as step 2.
  - "Continue" and "Sign out".
  - Wrong codes are counted. The fifth answers `RATE_LIMITED` with "Try again in N minutes".
- **The admin shell.**
  - A sidebar from `lg`, headed "Look Up" with "Super admin".
  - Navigation:
    - "Applications" (badge);
    - "Stations";
    - "Audio to check" (badge);
    - "System health";
    - "Find by reference code".

    The current item has `aria-current="page"`.
  - Below `lg`, a top bar with a menu button opens a drawer.
  - The footer shows the name and "Sign out".
- **Applications (AdminQueue wireframe).**
  - **Heading and summary:** "Applications", then "Oldest first · N waiting".
  - **The list.** Each entry shows:
    - name · frequency;
    - age;
    - town, province;
    - a kind pill for change requests ("Change to an approved station");
    - the flag pill "Check: Same frequency and town as an approved station" (or "…as a station waiting for review", "…as a suspended station").

    The selected entry has `aria-pressed="true"`.
  - **The detail panel:**
    - "<name> · <frequency>" and "<town, province> · submitted <age>";
    - the duplicate note;
    - **Checks:** phone, email, licence document;
    - **Details:** "Contact: <name> · +260 97 ••• ••34", "Licence number", "Time zone";
    - **Licence document:** an inline preview (PDF in an `<iframe>`, JPG in an `<img>`) from a 5-minute link, and "Open full size";
    - "Reason (needed to reject — the station sees this)", placeholder "e.g. The licence photo is too blurry to read the number. Please upload a clearer copy.";
    - "Approve station" and "Reject";
    - "The station gets an SMS and email. Your decision goes in the audit log."
  - **On a phone** the list and the detail are separate pages.
- **Stations.** No wireframe; reviewed as a screenshot.
  - A search box.
  - Rows: name · frequency, town, a status badge, members, and the last decision.
  - "Suspend" asks for a reason in a dialog, which warns "Its ads stop reaching listeners straight away." "Reactivate" brings the station back.
- **Audio to check.** No wireframe.
  - Each finding: "Audio A" and "Audio B" players (links fetched on Play), the overlap length, the stations and ads using each.
  - "Mark as checked", with a note.
  - With no findings: "Nothing to check. Overlapping audio shows up here once overlap detection is switched on."
- **System health.** No wireframe. Refreshes every 30 s.
  - Tiles:
    - Queue depth: recognize, ingest, notify;
    - Workers: recognize, ingest, notifications — "Running" or "Not running";
    - "Match time (95th percentile, last 24 hours)";
    - "Error rate (last 24 hours)".
- **Find by reference code.** No wireframe.
  - "Reference code" accepts XXXX-XXXX (as the app shows it) or a full request id (as the portal shows it).
  - The results list recognitions (outcome, time, station) and audit events (action, time, who).
  - When nothing is found: "Nothing in the database matches. Search the server log for the request id starting <8 hex>." (gap 14).

### 4.5 Team (no wireframe) and the O2 change request

- **Team** (inside the shell; the "Team" nav item is visible to every role).
  - **Members:** name, email, role, and "You" for yourself.
  - **Pending invitations:** email, role, "Expires in 5 days".
  - **For the OWNER only:**
    - "Invite someone": email, and a role chosen with explanations — Owner "Everything, including the team", Manager "Ads, clients and the station profile", Analyst "Can look, can't change anything";
    - "Cancel invitation";
    - "Remove from team", with a confirm dialog.
  - Others see the lists only.
- **Invitation acceptance.**
  - "You're invited to join <station> as a Manager".
  - No account yet: name, mobile number (optional) and password, then "Join".
  - An account exists: "Sign in to accept". The email is fixed; after sign-in it comes back and accepts.
- **Station profile** gets "Name, frequency and licence" (O2).
  - It shows the approved values and "Ask to change these".
  - The form lists the three values plus an optional new licence document, and warns: "We check these changes before they show. Until then your station keeps its current name and frequency."
  - While a request waits: "Waiting for review: <changes>", with "Withdraw".
  - When a request was rejected: "Not approved: <reason>".

### 4.6 What the admin numbers mean (gap 15)

- **Queue depth:** BullMQ `waiting + active + delayed` per queue.
- **Workers:** a worker is "Running" when its heartbeat key exists.
- **Match time p95:** `percentile_cont(0.95)` of `latency_milliseconds` over recognitions received in the last 24 hours whose outcome is `MATCH`, `MATCH_DEFAULT`, `CHOOSE_STATION`, `NO_MATCH` or `AMBIGUOUS`.
- **Error rate:** recognitions with outcome `TIMEOUT`, `BUSY` or `ERROR`, over all recognitions that are no longer `PENDING`, in the same 24 hours. `INVALID_AUDIO` is the listener's clip, not our failure, and is not counted.
- **Reference code search:**
  - matches `recognition_events.request_id` and `audit_events.request_id` by prefix (`LIKE '<8 hex>%'`), received in the last 30 days, at most 20 results;
  - a full id is matched exactly;
  - client crash reports exist only in the log.

### 4.7 States every page designs

- **Loading:** skeletons.
- **Errors:** an error notice with the request id.
- **Offline:** "No connection. Your answers are saved up to the last step you finished."
- **Saving:** "Saving…" on the button.
- **Upload failed:** retry.
- **Session expired:** silent refresh; otherwise Sign in, coming back to the same step.

---

## 5. Security

1. **Account and station creation** happen only in `app.register_station_applicant`, inside one transaction (gap 1).
2. **Status and approval** follow the transition trigger and the grants (§2.1). `lookup_api` has no privilege on `status`, `name`, `frequency_label`, `licence_*` or the verification columns outside definer functions (P5A-STATION-STATUS-02/03).
3. **The licence document:**
   - a private bucket with no public GET;
   - the key is generated by the server and never sent to a station;
   - the type is checked by its first bytes;
   - the admin gets a 5-minute link only (P5A-LICENCE-03..05, -09, ADMIN-QUEUE-10/11).
4. **Two-factor for super admins:**
   - TOTP per RFC 6238: SHA-1, 6 digits, 30 s, ±1 step;
   - each step accepted once (`two_factor_last_used_time_step`; NIST SP 800-63B-4 §3.1.4.2);
   - the secret is encrypted with AES-256-GCM. The key is `TWO_FACTOR_ENCRYPTION_SECRET` (43+ base64url characters, different from the other secrets), and the user id is the associated data.
   - **Enrolment** is an operator command: `npm run admin:create-super-admin`. It reads the email, name and password from the environment, never from arguments, and prints the `otpauth://totp/Look%20Up:<email>?secret=…&issuer=Look%20Up` address and the secret once. `--reset-two-factor` issues a new one (gap 12).
   - Recovery codes are not built in 5a: another super admin, or the operator command, resets a lost device.
5. **Codes and tokens:**
   - the 6-digit code is HMAC'd with a server key;
   - email-link and invitation tokens are 32 random bytes (base64url), stored as SHA-256, single-use, and carried in URL fragments.
6. **The human check** fails closed. Production refuses test keys.
7. **Logs** hold no codes, passwords, tokens, emails, phone numbers, names, licence numbers or object keys (§3.7).
8. **Cross-site requests:** Origin is required on `/registration/*` and `/invitations/*` (§3.3).
9. **Jobs:** `notify` jobs carry deadlines and are removed when finished, so no phone number or email stays in Valkey (P5A-NOTIFICATIONS-10).
10. **Abuse limits** are in §3.4.
11. **Images** are decoded by sharp with a pixel limit, after the size and signature checks.

---

## 6. Tests

| Layer | Files (new or extended) | Covers |
|---|---|---|
| Contracts | `registration-schemas.test.ts`, `phone-number-masking.test.ts`, `two-factor-codes.test.ts` (RFC 6238 test vectors) | Inputs, masking, TOTP |
| Database | `registration-database.test.ts`, `database-privileges.test.ts`, `database-catalogue.test.ts` | Every function's rules; the transition trigger table-driven over all 25 status pairs; grants per role and column; named constraints |
| API | `registration.test.ts`, `phone-and-email-verification.test.ts`, `station-uploads.test.ts`, `two-factor-sign-in.test.ts`, `admin-console.test.ts`, `team-invitations.test.ts`, `notifications.test.ts`, `registration-log-privacy.test.ts`, `phase-5a-route-failures.test.ts` (leak suite on every 5a route), `phase-5a-audit-trail.test.ts` (every 5a write route from the router adds an audit row) | §3 |
| Portal (vitest) | One test file per page and component | Wording, attributes, states, focus, the jsdom axe pass |
| Playwright (real stack, Mailpit) | `station-sign-up.spec.ts` (375 and 1280), `admin-review.spec.ts` (approve; reject and resubmit), `team-invitations.spec.ts`, `phase-5a-accessibility.spec.ts` (axe in Chromium with contrast on, zero violations, every 5a route; focus outlines; 44 px targets; no horizontal scroll at 320/375/768/1024/1280) | P5A-TESTS-01..11 |

Playwright stubs Turnstile's script by routing `challenges.cloudflare.com/turnstile/v0/api.js` to a local stand-in. The stand-in renders a checkbox and hands the dummy token to the callback. It reads SMS and email from Mailpit's API (`GET /api/v1/search?query=to:…`), and computes the super admin's code from the seeded secret.

---

## 7. Increments (each ends with its tests green, then a commit)

1. **Contracts:** sign-up, verification, upload, application, change request, admin, team and two-factor schemas; reason codes; phone masking; the TOTP algorithm; the plain-words texts.
2. **Database:** the migration, the definer functions, the trigger, the grants; their database tests.
3. **API foundations:**
   - the clock and the admin data source;
   - notifications (queue, in-process worker, SMTP and development SMS senders) and Mailpit in compose;
   - the two buckets and download URLs;
   - the human check, the one-time codes and sharp;
   - the error catalogue, logging redactions and configuration.
4. **API registration:** steps, verification, uploads, submission, status, edits, change requests.
5. **API two-factor and admin:** the guard, the queue and decisions, stations, overlaps, health, reference codes, the operator command, and the seeded development super admin.
6. **API team**, the leak suite on every 5a route, and the audit-trail loop.
7. **Portal sign-up:** the wizard, the email landing page, Application status, home routing.
8. **Portal admin:** two-factor, the shell and the five pages.
9. **Portal team**, invitation acceptance, and the O2 section of the profile.
10. **Playwright journeys, axe and widths.** Docs: the reviewer runbook, the O16 notes, the security baseline rows.
11. **Two read-only reviews** (code and completeness), fixes, the full suites, the checklist with evidence, the gate record.

---

## 8. Left for later, with where it goes

| Item | Why not now | Where |
|---|---|---|
| A real SMS provider adapter | O16: Africa's Talking's Zambian price couldn't be confirmed, and its sender-ID letters cover Airtel and MTN only (Zamtel not mentioned). The decision and checks are recorded first (P5A-NOTIFICATIONS-05). | Deploy phase, after the user picks |
| Delivery-report callbacks | They depend on that provider (P5A-NOTIFICATIONS-09) | Same |
| The portal's content security policy | No headers are set for the static site yet. It must allow `script-src` and `frame-src https://challenges.cloudflare.com`, and the storage host for the licence preview and logos. | Deploy phase (render.yaml headers) |
| Self-service password reset and the 100-failure disable | Retired items; gap 8 still needs the user | Asked at this gate |
| Changing a member's role; recovery codes for super admins | Not stated in the sources (gaps 22, 12) | Asked at this gate |
| Clean-up of abandoned applications (`PENDING_VERIFICATION` older than 30 days) | Not stated | Deploy phase (cron) |
| What a decision on "Audio to check" does to the ads | Detection arrives in phase 8 (gap 16). In 5a a finding can be marked checked. | Phase 8 |
| Usability sessions and wireframes at 1280 px (P5A-DESIGN-01..04) | Need people and the user's approval | Asked at this gate; screens reviewed as screenshots |

---

## 9. Outside facts (checked 9 October 2026)

- **Independent Broadcasting Authority** (iba.org.zm):
  - It publishes a "Content Service Providers" list: https://www.iba.org.zm/content-service-providers/. About 190 radio rows, giving name, province, area (town and frequency, e.g. "Kabwe 90.3FM") and category.
  - The list has **no licence numbers, no expiry and no "as at" date**. Some rows say "Frequency yet to be assigned". There is no online verification.
  - Radio licences last 5 years (MISA, 20 May 2025).
  - A reviewer can therefore check name, town and frequency against the list, but not the licence number. Recorded in `docs/runbooks/reviewing-station-applications.md` (P5A-ADMIN-QUEUE-20).
- **SMS (O16):**
  - **Africa's Talking** supports Zambia SMS. Its sender-ID registration letters cover Airtel and MTN only, and its price could not be confirmed (the pricing page refused).
  - **Twilio** Zambia: an alphanumeric sender ID needs about 3 weeks of pre-registration; no numeric or short codes; $0.3942 per segment.
  - **Local aggregators** (Celcom Africa and others) claim all three networks.
  - Recorded in `docs/adr/ADR-004-sms-provider.md` as the O16 notes. The choice is the user's.
- **Turnstile:** Cloudflare's test keys, siteverify and CSP, as in §3.1 (developers.cloudflare.com/turnstile, pages updated May–September 2026). Tokens last 300 s and are single-use.
- **Mailpit:** v1.31.4, 16.8 MB compressed. SMTP on 1025, web and API on 8025. No volume needed.
- **sharp:** 0.35.5, Node ≥ 20.9. The Windows package is 19.8 MB unpacked, with libvips bundled. HEIC is not supported by the prebuilt package, which is why licence photos are JPG.
- **TOTP:** RFC 6238 §5.2 (one step of network delay; never accept a code twice); Google's key-URI format.
- **NIST SP 800-63B-4** (final, July 2025): 15 characters for a single-factor password; SMS codes valid at most 10 minutes; no more than 100 consecutive failures.
- **Data Protection Act 2021 s.70:** local storage (fact 10 above).

---

## 10. Item map

Every P5A item, by area, with the section that builds it. Items marked **open** are expected to stay unticked at the gate, for the reason given.

| Items | Built in | Notes |
|---|---|---|
| SCOPE-01 | — | Gate check: 5a is built before the station chooser (open until the gate) |
| SCOPE-02..04 | §1, §2.8, §3.3 | -03 also needs the S3 rule that a non-active station's card never returns (test with a seeded pending station that has a published ad) |
| SIGNUP-01..08 | §3.3, §4.2 | -05 password policy: the user confirmed 15 characters on 10 October 2026 |
| VERIFICATION-01..10 | §3.1, §3.3, §3.6 | -04: the expiry is tested with the injected clock |
| STATION-DETAILS-01..11 | §3.2, §4.2 | Logo optional; 2 MB; WebP 512 |
| LICENCE-01..09 | §3.2, §4.2 | |
| SIGNUP-SCREENS-01..28 | §4.2 | -15 also has a manual Android autofill check: **open** until the phone check |
| APPLICATION-STATUS-01..11 | §4.3, §3.3 | |
| STATION-STATUS-01..04 | §2.1, §2.8, §4.4 | -01: built as six moves; O2 is a change request (user, 10 Oct 2026) |
| ADMIN-ACCESS-01..10 | §3.3, §4.4, §5.4 | |
| ADMIN-QUEUE-01..21 | §3.3, §4.4, §9 | -04/-07: the pill names the matched station's status (gap 21 default: every station except rejected and unsubmitted) |
| ADMIN-STATIONS-01..05 | §3.3, §2.4 | -04: built as change requests by the user's answer; -05 holds as written |
| OVERLAP-REVIEW-01..04 | §2.6, §3.3, §4.4 | -04: the path chosen is the definer functions (P5A-D11) |
| SYSTEM-HEALTH-01..05 | §4.6 | |
| TEAM-01..07 | §2.5, §3.3, §4.5 | |
| NOTIFICATIONS-01..10 | §3.1, §3.6 | -05 and -09 **open** (the real provider; §8) |
| LOGGING-01..03 | §3.7 | |
| AUDIT-01..04 | §2.8, §6 | |
| DATABASE-01..09 | §2 | |
| STRUCTURE-01..05 | §3, §4.1 | |
| INFRASTRUCTURE-01 | §3.1 | Mailpit in compose |
| DESIGN-01..04 | — | **open**: they need wireframes at 1280 px, sessions with listeners, and the user's approval |
| RESPONSIVE-01..03 | §4, §6 | |
| TESTS-01..11 | §6 | |

---

## 11. Decisions

| # | Decision | Why |
|---|---|---|
| P5A-D1 | The account, station and OWNER membership are created at step 1 by one definer function, and the applicant is signed in. Coming back is a normal sign-in that lands on the first unfinished step. | Gaps 1 and 2. The plan's status `PENDING_VERIFICATION` belongs to a station row; signing in is how "stop and come back" works on any device. |
| P5A-D2 | `name` and `frequency_label` may be empty only while `PENDING_VERIFICATION` | The station exists before step 3 asks for them; every other status keeps them required |
| P5A-D3 | The phone must be confirmed to leave step 2; both phone and email must be confirmed to submit | Gap 2. SMS is the urgent channel; email carries the decision and the reason. Leaving the email for later keeps a slow inbox from blocking the applicant. |
| P5A-D4 | **O2, the user's answer (10 October 2026):** an approved station's change of name, frequency or licence is a change request. The station stays `ACTIVE` under its approved details until a super admin approves the change. | Listeners are never cut off by a fix, and a hijacked account cannot rename a trusted station by itself (supersedes `ACTIVE → PENDING_REVIEW` in P5A-STATION-STATUS-01 and P5A-ADMIN-STATIONS-04) |
| P5A-D5 | Status moves are enforced by a trigger for every role, besides the grants | P5A-STATION-STATUS-01's table-driven test then proves the database itself refuses, not only the API |
| P5A-D6 | **Passwords: 15 characters minimum everywhere, the user's answer (10 October 2026).** The wireframe's helper becomes "At least 15 characters." | S2-D5 confirmed; conflict 1 closed |
| P5A-D7 | Step 1 says when an email already has an account | §3.5 trade-off; P5A-SIGNUP-07 asks for it |
| P5A-D8 | The human check is Cloudflare Turnstile, on step 1 only, and fails closed. Development and tests use an offline verifier that behaves like Cloudflare's test keys; Playwright stubs the widget. | Gap 4. Tests must not depend on the internet here. Sign-in has its own limits and trusted-device cookie (S2-D7). |
| P5A-D9 | The notification worker runs inside the API process, through the BullMQ `notify` queue | One fewer service on Render and in development. The queue still gives retries, deadlines and removal, and more API instances add senders. |
| P5A-D10 | In development an SMS is delivered as an email to Mailpit | One inbox for both channels, with no development-only HTTP route that could ever be left on in production |
| P5A-D11 | `lookup_admin_api` reads overlap findings only through two definer functions | The narrowest path the checklist offers (P5A-OVERLAP-REVIEW-04): no table grant in `fingerprints` at all |
| P5A-D12 | `SUPPORT` gets no admin access in 5a | Gap 11; nothing defines it |
| P5A-D13 | Critical alerts are suspension and reactivation, by SMS and email to the station contact | Gap 20: the two events that change whether the station reaches listeners |
| P5A-D14 | Logos: PNG or JPG, at most 2 MB, at least 64 × 64 px, stored as WebP inside 512 × 512, served by 15-minute links | Gap 6. Small on metered data; one size suits the portal and the app's chooser. |
| P5A-D15 | Licence documents are PDF or JPG only, as the plan says | Conflict 16. Browsers convert iPhone HEIC to JPEG when the file field asks for images; sharp cannot read HEIC. |
| P5A-D16 | Invitations last 7 days, are single-use, and the newest replaces an open one to the same email. The last OWNER cannot be removed. Role changes are not in 5a. | Gap 22 |
| P5A-D17 | Duplicate flag: same frequency (ignoring spaces and case) and same town, against every station except `REJECTED` and unsubmitted ones. The pill names that station's status. | Gap 21 |
| P5A-D18 | Review time shown as "2 working days" | Gap 7; the wireframe's placeholder |
| P5A-D19 | The super admin's TOTP secret is encrypted with its own key, and enrolment is an operator command | Gap 12. Rotating `AUTHENTICATION_SECRET` must not lock super admins out; no web route can enrol a second factor for someone else. |
| P5A-D20 | "Find by reference code" searches the database for recognitions and audit events, and points to the log otherwise | Gap 14. Logs live in the platform's log store, not in the database. |

**The user's answers (10 October 2026):**
- **Downloads:** sharp 0.35.5, nodemailer and the Mailpit image — approved.
- **O2:** stay live under the old details while the change waits for review.
- **Password minimum:** 15 characters.

---

## 12. Build record

**14 October 2026 (overnight and the day after, under the user's standing approval).** Increments 1 to 10 built.
Nothing pushed.

| Increment | Built | Tests |
|---|---|---|
| 1. Contracts | The sign-up, upload, application, change-request, admin and team schemas; reason codes; phone masking; the TOTP algorithm (RFC 6238, Web Crypto, so the browser tests can compute codes too); `SignedInPortalUser` with `platformRole` and `isTwoFactorCodeNeeded`; the portal's `NamedMemberStation` (a station still signing up has no name) | `registration-schemas.test.ts`, `station-files-admin-and-team-schemas.test.ts`, `time-based-codes.test.ts` (RFC 6238 Appendix B, RFC 4648 §10) |
| 2. Database | Migration `1791800000000-RegistrationAndAdmin` (§2) | `registration-database.test.ts` (107: the 25 status pairs for two roles, every function's rules, the two-owners race, privileges); `database-catalogue.test.ts` updated |
| 3. Foundations | The clock; the admin data source and `AdminTransaction`; notifications (the `notify` queue, the in-process worker, SMTP, the development SMS sender) and Mailpit in compose; the two buckets and download links with a fixed type and inline disposition; the human check; the phone codes; logo processing; the error catalogue, redactions and configuration; the second factor (`POST /auth/two-factor-code`) and `npm run admin:create-super-admin` | `human-check`, `phone-verification-codes`, `two-factor-secret-box`, `station-logo-processing`, `notifications`, `station-file-storage`, `admin-database`, `two-factor-sign-in`, `startup-checks` |
| 4. Registration | Every route of §3.3's registration table, the change requests included (O2: the new licence document is checked first, then named by the request, once) | `registration.test.ts` (journey A end to end, the refusals, the cooldown, expiry and lock, gap 3); `station-change-requests.test.ts` |
| 5. Admin (API) | `SuperAdminGuard` (404 for everyone else, `TWO_FACTOR_REQUIRED` before the code); the summary, the queue with duplicate flags, the detail, the 5-minute licence links (audited), approval, rejection, change decisions, the stations list with cursors, suspension and reactivation (each told to the station by SMS and email), "Audio to check", System health, "Find by reference code" | `admin-console.test.ts` |
| 5. (rest) | The seeded development super admin (`SEED_SUPER_ADMIN_*`, its secret in base32, so the browser tests can compute its codes) | `development-seed.test.ts` |
| 6. Team (API) | Invitations by email (accepted with a new account, or signed in with the invited address), cancelling, removing a member (never the last owner) | `team-invitations.test.ts`, `phase-5a-route-failures.test.ts` |
| 7. Portal: sign-up | The four steps, the email-link page, Application status, editing the account | `sign-up.test.tsx`, `sign-up-accessibility.test.tsx` |
| 8. Portal: console | The second-factor page; Applications, Stations, Audio to check, System health, Find by reference code | `admin.test.tsx` |
| 9. Portal: team and changes | Team, the invitation page, the change request on Station profile | `team.test.tsx`, `station-profile-page.test.tsx` |
| 10. Browser journeys | `station-sign-up.spec.ts` (journey A, then approval and signing in), `admin-review.spec.ts` (journey D: reject, fix, submit again, approve), `team-invitations.spec.ts` (journey E), `phase-5a-accessibility.spec.ts` (axe with contrast, focus, 44 px, widths 320 to 1280), each at 375 and 1280 px against the real stack. Docs: `docs/runbooks/reviewing-station-applications.md`, `docs/adr/ADR-004-sms-provider.md` | the four specs |

**Changed in the build** (each also noted where the design says it):
- Migration number, `describe_active_portal_session`, the overlap functions in `app`, `TWO_FACTOR_RESET` (§2).
- Redactions name each code field, not `*.code` (§3.7).
- `SMS_SENDER` is `development` or `none`. Production refuses `development`. With `none`, step 1 answers 503 `SIGN_UP_UNAVAILABLE` ("Station sign-up isn't open yet. Please try again later."), so production can start before O16 is decided while sign-up stays closed.
- A refused logo or licence document is `STATION_FILE_REJECTED` ("We can't use this file. Check the type and size, then choose it again."), because `UPLOAD_REJECTED`'s words are about audio.
- The email link's 60-second cooldown is a key in Valkey, answered `RESEND_TOO_SOON` like the phone code's.
- A failed send's message never reaches the log or the queue: a mail server's message can quote the address. Only its kind, SMTP codes and stack (without the message) are kept.
- `StationProfile.name` and `frequencyLabel` may be null while a station is still signing up.

- `fingerprints.asset_overlaps` findings name their recordings by asset number, as the console shows them.
- A decision's reason (rejection, suspension) is kept on the station or the request; its audit row says only that there was one, because a reason may name people.

**How the browser journeys run** (increment 10):
- Turnstile's script is replaced by a stand-in tick box that hands over Cloudflare's dummy token, and every other
  request to Cloudflare is refused, so no test needs the internet.
- SMS and email are read from Mailpit's API. The super admin's code is computed from the seeded secret; the step is
  chosen after the last one used (read from the development database), since each step counts once.
- Each journey sends its API calls with an address of its own from 198.18.0.0/15 (`X-Forwarded-For`, which the
  development proxy passes on), so the per-address sign-up limits count journeys apart.
- After the run, a clean-up takes the test stations out of the listener app's list, closes any left in the review
  queue, cancels test invitations to the seeded stations and takes test members off their teams. It runs only
  against a database on this computer, and only on `browser-test-…@example.test` accounts.

**Found by the browser journeys and fixed:**
- Five stand-alone links were 20 px tall on a phone (the header's "Sign in", "Sign in instead", the email page's "Go
  to your application", "All applications", "Open full size"): each is now at least 44 px.
- On a phone, an application opened on its own page had no level-one heading. Its station name is now the `h1`
  there (`h2` beside the list), and its sub-headings follow; the decision screen says "Decision recorded".
- Inside the licence preview, focus moves into the browser's own PDF viewer. The page cannot see that focus, but
  screenshots of each Tab show the viewer ringing its own buttons, so the focus check skips a focused frame.
- The licence preview pushed Approve and Reject about 360 px down when it opened, so a tap could land on the wrong
  thing. Its space is now kept while it opens.
- Text and select fields were 44 px tall beside a 48 px mobile-number field: every portal field is now 48 px
  (P5A-SIGNUP-SCREENS-13). Step 4's confirmation tick box sat in a 24 px label on a desktop: now 44 px.
- The console's counts read "Applications2 waiting" to a screen reader: now "Applications 2 waiting".

**Added while checking the checklist** (increment 11):
- A station user who opens `/admin` is sent to their own station, not shown "couldn't find" (P5A-ADMIN-ACCESS-01).
- A too-short password says "Use at least 15 characters." once the field is left (P5A-SIGNUP-SCREENS-10).
- A logo or licence upload that failed for a connection or storage reason offers "Try again" with the same file; a
  file that is itself wrong does not (P5A-SIGNUP-SCREENS-28, P5A-LICENCE-06).
- Answers typed on steps 3 and 4 but not saved yet survive Back and forward, kept in the tab's memory only, never in
  the browser's storage (P5A-SIGNUP-SCREENS-04).

**Next:** increment 11: the reviews, the full suites, the checklist ticks with evidence, the gate record.
