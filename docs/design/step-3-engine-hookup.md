# Step 3 — Engine hookup: build spec

Scope (approved plan, thin slice, Step 3): an uploaded ad is fingerprinted by a Python worker and
becomes **Ready**; a listener's clip sent to `POST /api/v1/recognize` is fingerprinted by a second
worker, matched, resolved to the station whose schedule is live, and answered with that station's
buttons. Every request is registered to an anonymous app install first (`POST /api/v1/installs`).

The requirements are the `S3-` items in
[checklist-2-engine-and-recognition.md](../requirements/checklist-2-engine-and-recognition.md). The
engine choices are in [ADR-001](../adr/ADR-001-fingerprint-engine.md). Every rule in
[conventions.md](../conventions.md) and every Step 3 row of [security-baseline.md](../security-baseline.md)
applies. The user asked on 7 October 2026 to build every remaining phase in order; the decisions
below are the recommended answers to the open questions the checklist lists, taken so the work can go
on, and each can be changed.

## How it fits together

```
portal ─ complete upload ─► API ─ add job ─► Valkey "ingest" ─► ingest worker (Python)
                                                      download (presigned GET) → decode → check length
                                                      → SHA-256 duplicate check → fingerprint → COPY
                                                      → fingerprints.record_ad_ingest_result()  ⇒ ad READY / FAILED

app ─ POST /installs ─► API ─► app.listener_installs (hashed id) ─► install token (JWT)
app ─ POST /recognize ─► API: request id → install token → per-install limits → multipart (256 KiB)
                        → first bytes → claim (idempotency key) → admission (breaker, depth, heartbeat)
                        → add job ─► Valkey "recognize" ─► recognize worker (Python)
                                       deadline → decode (1 s) → fingerprint → lookup (800 ms) → align → decide
                        ◄─ result (asset number, aligned count, margin, offset) ─┘
                        → recognition.find_stations_for_audio() → policy (TypeScript)
                        → recognition.finish_recognition() → response
```

## Decisions

| # | Decision | Why |
|---|---|---|
| S3-D1 | **Queues on Valkey with `bullmq` 6.3.11 (Node) and `bullmq` 3.3.0 (Python), two queues, `ingest` and `recognize`, under the key prefix `QUEUE_KEY_PREFIX` (default `lookup`).** BullMQ is used directly from an `infrastructure/job-queues` module with its own Valkey connections (`maxRetriesPerRequest: null`), not through `@nestjs/bullmq`. `ioredis` stays at 5.11.1, which BullMQ 6 accepts (optional peer `>=5`). | One module owns the queues, their connections and their shutdown; the Nest wrapper adds decorators we don't need. The plan's ioredis 6 bump (S2-D21) turned out unnecessary. |
| S3-D2 | **Recognize job:** name `recognize`, data exactly `{request_id, audio_base64, codec, deadline_epoch_milliseconds, fingerprint_version}`, options `attempts: 1`, `removeOnComplete: true`, `removeOnFail: true`, job id a new random UUID for each attempt (a retry of the same recognition must never meet the earlier attempt's job, which may still be in the queue). When the API stops waiting it removes its job, so a clip no worker took is not left in Valkey; a job a worker has started is dropped at its deadline and removed when done. While a job exists its clip is in Valkey's memory and in its append-only file, which keeps it until Valkey next rewrites the file (security baseline §5). **Result:** `{status: MATCH | AMBIGUOUS | NO_MATCH | EXPIRED, audio_asset_number, aligned_hash_count, match_margin, match_offset_milliseconds}`; `match_margin` is `null` when there is no runner-up (never `Infinity`, which JSON cannot carry). A failure's reason is only a code: `INVALID_AUDIO`, `DECODE_TIMEOUT`, `LOOKUP_TIMEOUT`, `FINGERPRINT_VERSION_MISMATCH`, `ENGINE_FAILED`. | Full-word names with units (S3-STRUCTURE-01); the job carries nothing that identifies the listener or the station (S3-QUEUE-07). |
| S3-D3 | **The API waits on its own listener, registered on a long-lived `QueueEvents` before the job is added**, for at most `RECOGNITION_WAIT_MILLISECONDS` (2,500). It does not call `job.waitUntilFinished`. | With `removeOnComplete` a fast job can finish and vanish before `waitUntilFinished` subscribes; listening first removes that race. The behaviour the checklist asks for (wait 2.5 s, then give up; the deadline makes the worker drop the job) is unchanged. |
| S3-D4 | **Ingest job:** name `ingest`, data `{request_id, ad_id, download_address, deadline_epoch_milliseconds, fingerprint_version}`, job id `ingest-<ad id>` (so an ad has at most one job waiting), `attempts: 3` with exponential backoff from 10 s, `removeOnComplete: true`, `removeOnFail: true`, deadline and download address valid for 30 minutes. It is added when `complete` accepts an upload, and every minute a sweep re-adds ads that have waited in `PROCESSING` for over 5 minutes with no job (`app.find_ads_waiting_for_ingest`), each with a fresh address. The sweep looks at the 500 longest-waiting ads and adds at most 50 a run, re-adds an ad at most once every 15 minutes (a cooldown key per ad), and logs an error for an ad re-added 12 times in a week. | Covers the ads left in `PROCESSING` by Step 2 and the seed, a Valkey outage at the moment of `complete`, and a job whose retries ran out on a temporary failure. The cooldown keeps ads that keep failing from crowding out the rest. |
| S3-D5 | **The worker never holds storage credentials.** The API signs the download address with the internal storage endpoint (`OBJECT_STORAGE_ENDPOINT`), not the public one used for browsers. | Baseline §4; a worker on a private network cannot reach the public host. |
| S3-D6 | **Ingest outcome is written by one SECURITY DEFINER function, `fingerprints.record_ad_ingest_result(ad_id, audio_asset_id, upload_content_sha256, refusal_reason, request_id)`**, executable only by `lookup_fingerprint_worker`. Exactly one of the asset and the reason is given. It changes only an ad still in `PROCESSING` (returns whether it did), sets READY with the asset link, duration and SHA-256, or FAILED with a reason from the fixed list, and writes the audit row (`ad_audio_ready` or `ad_upload_refused`, actor empty, the job's request id). | The worker gains no privilege on `app` (S3-DATABASE-04, -06); the ad's status is mirrored only through this function (S3-INGEST-15). |
| S3-D7 | **Ingest refusal reasons** (added to `UPLOAD_REFUSAL_REASONS`, lowercase, each with a sentence in the portal): `audio_too_short` (under 5 s), `audio_too_long` (over 120 s), `no_audio_in_file`, `audio_unreadable` (not decodable, container not allowed, empty), `audio_took_too_long_to_read` (over the 30 s decode cap). Temporary failures (download, database, Valkey) are retried, never recorded as a refusal. | Engine codes are upper case and technical; the station sees a plain reason (S3-INGEST-14). |
| S3-D8 | **Exact duplicates are found by the SHA-256 of the uploaded bytes, before decoding.** The asset row is inserted with `ON CONFLICT (content_sha256) DO NOTHING`; when another ingest of the same file wins the race, the loser links to its asset. The asset and all its hashes are written in one transaction with the ad's outcome. | D7: one fingerprint per audio; concurrency settles on the unique key. |
| S3-D9 | **`fingerprints.audio_assets` gains `fingerprint_status` (`READY`, `NEEDS_REVIEW`), default `READY`. No row is created for a failed file**, so a failure lives on the ad (`processing_error_code`), not on an asset. **No canonical copy of the audio is stored yet**: the uploaded original stays in storage and is decoded again when re-indexing is built (P8). | S3-TESTS-14 asks that a corrupt file leaves no asset row, which rules out a failed asset status. A canonical copy needs a second upload path for the worker; nothing reads it before re-indexing. S3-INGEST-19 and the failure half of S3-INGEST-20 are therefore built differently. |
| S3-D10 | **Decode caps.** Clips: at most 262,144 bytes in, 16 s decoded, and a 1 s decode deadline. Ads: at most 20 MiB in (the upload limit), 121 s decoded, and a 30 s decode deadline. The deadline is the engine's own, checked as each frame is decoded (past it: `DECODE_TIMEOUT`). Behind it is a hard cap on the whole task in the process pool, which abandons the task and replaces the process: 2.5 s for a clip (decode, fingerprint and lookup together, the time the API waits) and 45 s for an ad. A decode stuck inside one frame is therefore stopped at the hard cap, not at the deadline. | A process can be abandoned; a thread cannot. One frame of a clip under 256 KiB decodes in milliseconds, so the deadline does the work in practice; the hard cap bounds what it cannot see. |
| S3-D11 | **Workers:** `python -m workers.recognize` and `python -m workers.ingest` in `services/fingerprinter/workers/`, asyncio with a `ProcessPoolExecutor` for decoding and fingerprinting, `structlog` 26.1.0 JSON lines to standard output, `sys.excepthook` and an asyncio exception handler, a heartbeat key `<prefix>:worker-heartbeat:<queue>` written every 5 s with a 15 s expiry, connecting to Postgres as `lookup_fingerprint_worker`. Settings: `KEY_VALUE_STORE_URL`, `FINGERPRINT_DATABASE_URL`, `QUEUE_KEY_PREFIX`, `WORKER_CONCURRENCY`, `LOG_LEVEL`; nothing about storage. | S3-WORKERS-01…05, S3-LOGGING-01…02, S3-ERRORS-07, -08. |
| S3-D12 | **Install registration:** `POST /api/v1/installs` with `{install_id (UUID made by the app), platform (ANDROID or IOS), app_version}`; the server stores HMAC-SHA-256(`LISTENER_INSTALL_ID_PEPPER`, install id) and answers `{install_token, expires_at}`: an HS256 JWT signed with `LISTENER_INSTALL_TOKEN_SECRET`, audience `lookup-listener-app`, subject the install's row id, valid 30 days. Registering again (same install id) renews the token and updates the app version and last-seen time. A BLOCKED install gets 401 `INSTALL_TOKEN_INVALID` everywhere. `listener_installs` gains a nullable `integrity_verdict`; Step 3 stores none (checking Play Integrity or App Attest needs calls to Google or Apple, decided with the app in Step 4). | O10: the verdict is only a soft signal, so its absence must change nothing. |
| S3-D13 | **Recognize request** (`multipart/form-data`): file part `audio`; fields `clip_duration_milliseconds` (2,000–15,000), `codec` (`aac` in an MP4/M4A container, first bytes `ftyp`; or `opus` in Ogg, first bytes `OggS`; the codec must match the container), `idempotency_key` (UUID), `captured_at` and `sent_at` (ISO timestamps), `is_deferred` (`true`/`false`), optional `station_hint` (a station id). Install token in `Authorization: Bearer`. The audio part may be 262,144 bytes; the whole body 278,528 bytes. Parsing is a streaming `busboy` 1.6.0 reader that stops at the limit (413) and never buffers more. | The 256 KiB the plan names, read as 2^18 bytes; full-word field names (S3-STRUCTURE-01, -02). |
| S3-D14 | **Order of checks:** request id → the general per-address ceiling every route has (429; a middleware, so even requests with bad tokens from one address are bounded) → install token (401) → per-install and per-address limits (429) → recognitions in progress on this instance (503) → body read, its size (413) and its time (400) → fields (400) → first bytes (415) → capture time (422) → claim (409 or replay) → admission (503) → job and wait (503 on timeout) → resolve → record → respond. | S3-REQUEST-13. Each refusal happens before anything later is done. |
| S3-D15 | **Clock correction and capture-time limits are built now** (they were P4): effective capture time = `captured_at` + (receipt time − `sent_at`). More than 24 hours old → 422 `CAPTURE_EXPIRED`; more than 2 minutes ahead → 422 `CAPTURE_TIME_INVALID`. `recognition_events` gains `client_captured_at` and `clock_skew_milliseconds`. A request is marked deferred when the app says so or when it arrives over 120 s after capture. | Without correction a phone with a wrong clock would break the database's capture-time check (S3-ERRORS-03); correcting is simpler and kinder than refusing. |
| S3-D16 | **Idempotency is built now** (the claim was P4): `recognition.claim_recognition` inserts the key and a `PENDING` event, or answers with the existing one. A finished recognition is replayed (same `recognition_id`, same card version); one still `PENDING` and younger than 30 s gets 409 `RECOGNITION_IN_PROGRESS`; a `PENDING` one older than 30 s, or one that ended `TIMEOUT`, `BUSY` or `ERROR`, is claimed again (`attempt_count` + 1, first receipt time kept). | The keys table makes a repeated key a unique violation, so Step 3 needs an answer for it anyway; the app retries with the same key after a 503. |
| S3-D17 | **Admission:** an `opossum` 10.0.0 breaker wraps "add job and wait" (opens at 50 % failures over at least 5 requests in 10 s, tries again after 10 s); the queue's waiting count is read at most once a second in the background and compared with `RECOGNITION_QUEUE_DEPTH_LIMIT` (50); the recognize heartbeat key is checked in the same refresh. Each API instance also takes at most `RECOGNITIONS_IN_FLIGHT_LIMIT` (32) recognitions at once, counted from before the body is read, so the clips held in memory stay bounded. Each refusal is 503 `RECOGNITION_BUSY` with `Retry-After: 10`, logged with its cause; a wait that ends with no result is 503 `RECOGNITION_TIMEOUT` with `Retry-After: 5`. | Fail fast; the app shows "Busy" with a countdown and retries with the same idempotency key. |
| S3-D18 | **Limits, all counted in Valkey before the body is read.** Per install: `RECOGNITIONS_PER_INSTALL_PER_MINUTE` (6) and `RECOGNITIONS_PER_INSTALL_PER_DAY` (60). Per address: `RECOGNITIONS_PER_CLIENT_ADDRESS_PER_MINUTE` (300) on `/recognize` and `LISTENER_REGISTRATIONS_PER_CLIENT_ADDRESS_PER_HOUR` (60) on `/installs`, because installs cost nothing to make, so one sender with many installs must not fill the queue for everyone. A clip must arrive within `RECOGNIZE_BODY_READ_MILLISECONDS` (20,000), or the request ends with 400. Above these, the general per-address ceiling on the two listener routes is `LISTENER_REQUESTS_PER_CLIENT_ADDRESS_PER_MINUTE` (600); the portal's baseline no longer applies to them. Until the app sends an integrity verdict (Step 4), the per-install limits keep listeners fair to each other but stop no one who makes installs: the per-address limits are the abuse control. | Zambian mobile networks put many listeners behind one address (G11), so the address limits are set high; they still bound a single sender. |
| S3-D19 | **Station resolution (Step 3 part):** `recognition.find_stations_for_audio(audio_asset_number, effective_captured_at)` returns, for every ACTIVE station with an ACTIVE campaign on a non-archived ad that uses the asset, the station's public details, the ad title, the client, the campaign's card and the client's default card, and whether the capture time falls inside the campaign's period (`[start, end)`) and one of its windows (in the station's time zone, ISO days, overnight windows belonging to their start day). The policy in TypeScript: exactly one station in window → `MATCH` with its campaign card; none in window and exactly one station → that client's default card (`MATCH` with `result.kind: CLIENT_DEFAULT`, stored `MATCH_DEFAULT`), or `NO_MATCH` if it has none; any other case → `NO_MATCH` (stored with fallback reason `several_stations`) until P4 adds the chooser. Grace periods, receipt-time checks and the hint are P4. Besides what a listener may see, the function returns each owning station's `campaign_id`, `campaign_action_card_id` and `client_default_action_card_id`: the API needs them to record which campaign and card version answered, and they never leave the API (the response contract has no field for them). The API's two other reads across stations are as narrow: `app.find_ads_waiting_for_ingest` (ad id and upload key, for the sweep) and `recognition.describe_recognition` (one install's own recognition, for a replay). | Choosing the station in TypeScript keeps the policy testable without a database and ready for P4's chooser; the price is that these ids reach the API process. |
| S3-D20 | **Public station reference = the station id** (a UUID), the same value the hint and (in P4) the choice and engagement endpoints take. | The id is already in portal addresses and reveals nothing; a second opaque token would need its own table. |
| S3-D21 | **Recognize response** (`packages/contracts`, emitted as `recognize-response.schema.json`, `additionalProperties: false`): `{status, recognition_id, request_id, is_deferred, captured_at, result?}`, `status` one of `MATCH`, `CHOOSE_STATION`, `NO_MATCH`; `result = {kind: CAMPAIGN | CLIENT_DEFAULT, station: {id, name, frequency_label, logo}, client: {name, logo}, title, card: {schema_version, layout, header_image, actions}}`; images are `{address, width_pixels, height_pixels, size_bytes}` or `null`. Stations and clients have no logos and cards have no header image yet (no screen sets them), so these are `null` until the portal can set them. AMBIGUOUS is stored as AMBIGUOUS and answered as `NO_MATCH`. | S3-RESPONSE-01…17 with full-word names; nothing internal (asset, campaign, scores) leaves the API. |
| S3-D22 | **Recording:** every claimed recognition is finished by `recognition.finish_recognition` with its outcome, the match facts, the latency, the resolved station, campaign and card (a card id is a snapshot because card versions never change) and `completed_at`. Recognition ids are UUIDv7 made by the API (our own 20-line generator). | S3-RECORDING-01…09; no new dependency for UUIDv7. |
| S3-D23 | **Error catalogue additions:** `INSTALL_TOKEN_INVALID` (401), `INVALID_AUDIO` (400), `RECOGNITION_IN_PROGRESS` (409), `CAPTURE_EXPIRED` and `CAPTURE_TIME_INVALID` (422), `RECOGNITION_BUSY` and `RECOGNITION_TIMEOUT` (503); 413 and 415 keep `PAYLOAD_TOO_LARGE` and `UNSUPPORTED_MEDIA_TYPE`. Worker `INVALID_AUDIO` becomes 400 `INVALID_AUDIO`; `DECODE_TIMEOUT`, `LOOKUP_TIMEOUT` and `FINGERPRINT_VERSION_MISMATCH` become 503 `RECOGNITION_BUSY` (a decode that runs out of time says more about a busy worker than about the clip, and the app tries again); `ENGINE_FAILED` and anything else is 500 `INTERNAL` with the code only in the log. | S3-ERRORS-02, -05. Telling a listener their clip was unusable when the worker was only slow would lose a recognition. |
| S3-D24 | **Engine settings for this version are the denser peaks the 30 Sep and 7 Oct synthetic runs favoured, fingerprint version 1, thresholds from the same runs** — see ADR-001. They are provisional until real recordings at the pilot (D10). | S3-ENGINE-12, -16. |
| S3-D25 | **Tests:** the API suite starts real Python workers (from `services/fingerprinter/.venv`) against the compose Valkey and Postgres for the cross-language and end-to-end tests, each test file on its own queue prefix; the worker's own tests run with `pytest`, and the Postgres index tests run by default against the compose database (no skip). A missing virtual environment fails the run with a plain message rather than skipping. | S3-TESTS-01…03, -10. |
| S3-D26 | **Packaging:** the worker image becomes multi-stage (`uv sync --frozen` in a build stage, a slim runtime stage, non-root), with one image and two commands; `infra/docker-compose.yml` gains the two workers under a `workers` profile so they start only when asked. The Python service moves to uv with `uv.lock` (S2-D22). | S3-WORKERS-05…07, S3-STACK-06. Building it needs downloads (uv, Python 3.12 wheels), asked for first. |
| S3-D27 | **The portal's wording for a checked upload changes** from "Audio checked … prepared once recognition is switched on" (S2-D26) to "Preparing for recognition", and the upload screen's last stage ends at "Ready for listeners". | Recognition is switched on now. |

## Database: migration `1791500000000-EngineHookup`

All new functions are `SECURITY DEFINER`, owned by `lookup_schema_owner`, with
`search_path = pg_catalog, <schema>, pg_temp`, and executable only by the role named.

- `fingerprints.audio_assets`: `fingerprint_status text NOT NULL DEFAULT 'READY'` with a check (`READY`, `NEEDS_REVIEW`).
- `app.listener_installs`: `integrity_verdict text NULL` with a check (`MEETS_DEVICE_INTEGRITY`, `MEETS_BASIC_INTEGRITY`, `FAILED`); `app_version` 1 to 32 characters.
- `app.stations`: `name` 1 to 120 characters, `frequency_label` 1 to 32 (they reach every listener's phone).
- `app.recognition_events`: `client_captured_at timestamptz NULL`, `clock_skew_milliseconds integer NULL`, `last_claimed_at timestamptz NULL` (when the latest attempt was claimed, for the 30-second in-progress rule).
- `fingerprints.record_ad_ingest_result(...)` — `lookup_fingerprint_worker`.
- `app.find_ads_waiting_for_ingest(waited interval, maximum_count integer)` → ad id, upload object key — `lookup_api`.
- `recognition.claim_recognition(...)`, `recognition.finish_recognition(...)`, `recognition.find_stations_for_audio(...)`, `recognition.describe_recognition(...)` (for replays) — `lookup_api`.
- `USAGE ON SCHEMA recognition` to `lookup_api` only.

## Configuration added

API: `QUEUE_KEY_PREFIX`, `RECOGNITION_WAIT_MILLISECONDS`, `RECOGNITION_QUEUE_DEPTH_LIMIT`,
`RECOGNITIONS_PER_INSTALL_PER_MINUTE`, `RECOGNITIONS_PER_INSTALL_PER_DAY`,
`RECOGNITIONS_PER_CLIENT_ADDRESS_PER_MINUTE`, `RECOGNITIONS_IN_FLIGHT_LIMIT`, `RECOGNIZE_BODY_READ_MILLISECONDS`,
`LISTENER_REGISTRATIONS_PER_CLIENT_ADDRESS_PER_HOUR`, `LISTENER_REQUESTS_PER_CLIENT_ADDRESS_PER_MINUTE`,
`INGEST_SWEEP_INTERVAL_SECONDS` (60; 0 switches the sweep off), `LISTENER_INSTALL_TOKEN_SECRET` and
`LISTENER_INSTALL_ID_PEPPER` (both refused when missing, short or a placeholder), `FINGERPRINT_VERSION`.
Workers: see S3-D11.

## What Step 3 leaves to later phases

- **P4:** grace periods; checks at receipt time (station and campaign status, engagement limits);
  storing and using the hint; the chooser (`CHOOSE_STATION`, `recognition_candidates`) and the
  choice endpoint; engagements; the deferred allowance, shedding and priority;
  load tests.
- **P5A/P5B:** logos and header images (and how they are served); the super-admin read path into
  `fingerprints` for overlap review.
- **P8:** near-full and partial acoustic duplicates (`NEEDS_REVIEW`), re-indexing, calibration of
  the thresholds on real recordings, continuous integration.

## Gate record (8 October 2026)

**Test runs**, on the build machine against the compose Postgres, Valkey and object storage. No
Android emulator or qemu process was running (checked before the runs).

| Suite | Result |
|---|---|
| API (vitest), with real Python workers in `fingerprint-workers.test.ts` | 37 files, 549 tests passed, 0 skipped; `recognize-route.test.ts` run again on its own after one more assertion: 50 passed |
| Fingerprint service (pytest) | 189 passed, 0 skipped |
| Contracts (vitest) | 10 files, 289 tests passed |
| Portal (vitest) | 44 files, 656 tests passed |
| Browser journeys (Playwright, installed Chrome, with the workers running) | 10 passed; 2 skipped by design (the keyboard check runs at desktop width, the touch-target check at phone width) |
| Typechecks | API, contracts, portal and its browser journeys: clean |

**Checks a test cannot hold**

- A run with Valkey unreachable (`KEY_VALUE_STORE_URL` pointed at a closed port) failed with exit
  code 1: both test files failed in their setup, none passed.
- A run of `fingerprint-workers.test.ts` with the recognize worker deliberately broken failed with
  exit code 1 and "the recognize worker stopped while starting"; the worker file was then restored
  byte for byte.

**Logging review (S3-LOGGING-08).** Before the workers' logging was switched on, the engine's call
sites were checked: `lookup_fingerprint` prints and logs nothing, and the workers write only through
`worker_logging.py`, which drops audio, clip and download-address values, shortens long ones while
keeping the error a stack ends with, and adds the job's request id to every line. Tests now hold
this (`test_engine_rules.py`, `test_workers.py`), with the log-capture tests in `recognize-route`,
`log-request-details` and `fingerprint-workers`.

**Security baseline (S3-SECURITY-01).** Every Step 3 row is Built and names test files that exist
and pass. The rows still Planned belong to later phases (two-factor sign-in, station approval and
"Report this", restore drills, data-protection work, continuous integration, Render networking).

**Fixed at the gate** (found by the review of the checklist): the API role's right to write an
ad's upload checksum (now the worker's alone); listener cards are now checked against every rule of
a saved card before they are sent; the recognize worker stops at once with one log line when
Postgres is unreachable at start-up, and its pool processes give up on a connection after 10
seconds; a shortened stack trace keeps the error it ends with.

**Open at this gate**, each with its reason in the checklist: the worker image and uv (S3-D26,
waiting for approval of the downloads); the k6 load tests (P4); the listener app's halves of the
shared-fixture and no-fingerprinting rules (Step 4); the decisions recorded above as built
differently; and cross-feature imports inherited from Step 2 (S3-STRUCTURE-04).
