# Phase 4 — Station resolution and engagements: server design

*Written 10 October 2026, revised the same day after two critics' review and the contract amendments
A1–A8 (§3). This file decides how the server side of phase P4, and the server parts that phase P6
needs, are built. The build follows it. A decision that changes during the build is changed here
first. Fourteen questions in §10 are still open; three of them are needed before Piece 1, and every
decision that waits on one names it.*

**Scope.** Phase 4 of the approved plan ("Station resolution & scheduler"), in two gates.
- **Gate part 1** (P4-RESOLUTION-16): station resolution in full. That is candidate stations, time
  windows with grace, the listener's station hint, `CHOOSE_STATION` with every candidate's card
  inline, the station-choice endpoint, the default-card fallback, idempotency and the deferred-clip
  rules.
- **Gate part 2** (P4-RESOLUTION-17): engagement (tap) limits and the engagements endpoint, built
  after the P6 outbox.
- **The server parts P6 needs:** the "My station" list (`GET /api/v1/stations`), the update gate
  (426 `APP_UPDATE_REQUIRED`), "Report this" (if approved), a queued crash report's time, the shared
  outbox rules, and the stand-in API's new routes.

The app's own screens are designed in the P6 design. This file names them only where a walkthrough
needs them.

**Requirements.** Every `P4-` item in `docs/requirements/checklist-2-engine-and-recognition.md` —
**114 items, 16 already ticked** — is mapped in §8.1. The P6 items that have a server half are mapped
in §8.2, and the ALL rules in §8.3. `docs/conventions.md`, `docs/security-baseline.md` and the error,
logging and test rules in the user's CLAUDE.md apply.

**Sources read.**
- Checklist part 2: how to read it, conflicts 1–16, the whole P4 section, gaps 1–49.
- Checklist part 3: the whole P6 section, the ALL rules that bind the app, gaps 1–50.
- Checklist part 5: "ALL — Rules for every phase".
- The approved plan, "Reference — master implementation plan": D3, D5, D7, D8, the Data model with
  roles and row-level security, the Recognition flow (steps 1–9, the listener's station choice,
  engagements), Mobile design patterns A–C, the cross-cutting error, logging and test rules, Phases
  rows 4 and 6, open decisions O3, O4 and O10–O14, and the execution order.
- The wireframes in `c:\tmp\lookup-workflows\wireframes\`: Chooser, Settings, Offline, History,
  Result and Main. Screen wording below is copied from them.
- `docs/design/step-3-engine-hookup.md`, `docs/design/step-4-listener-app.md` (with its gate record
  and "After the gate"), `docs/conventions.md`, `docs/security-baseline.md`.
- The code: the Foundation, AdCardsAndSchedules and EngineHookup migrations; `features/recognition/*`;
  `common/{errors,rate-limiting,listener-authentication,http}`; `configure-http-application.ts`;
  `recognize-queue.ts`; `recognition-event-partitions.ts`; `config/app-config.ts`; the contracts'
  `recognize-schemas.ts`, `client-error-schemas.ts`, `station-schemas.ts`, `schedule-schemas.ts`,
  `action-card-schema.ts` and fixtures; the seed scripts; `apps/mobile/tool/fake_listener_api.py`;
  the portal's schedule step; and `bullmq` 6.3.11 as installed in `node_modules` (read from disk, no
  download).
- The project memory notes on the 10 October reorder, on live walkthroughs and on open threads (the
  ngrok token).
- The review of 10 October 2026: 47 findings from a completeness critic and a correctness critic,
  each checked against the code before acting on it, and the contract amendments A1–A8 the lead
  decided from them. `opossum` 10.0.0 and the portal's schedule step were read for the review.

**What this design settles.** 37 decisions (§9, P4-D1 to P4-D37), each with its reason and the
checklist gap or review finding it answers; fifteen of the first 29 were amended after review, each
marked so. Fourteen questions only the user can answer (§10), each with a recommended answer, the
checklist items that depend on it and the piece it must be answered before. Five pieces (§7), each
ending with a live walkthrough. The behaviours this design adds that no checklist item states are
listed in §8.4, to be added to checklist part 2 before Piece 2. **No download is needed for the
server work.** The k6 load tests, which would need one, are proposed for P8 (P4-D22, Q10). The app's
new packages are listed, with sizes, in the P6 design.

**Facts found while reading that change the work.**
1. **The order changed.** On 10 October 2026, after a walkthrough, the user put P4 and P6 before 5a.
   5a is parked on the branch `phase-5a-parked`. P4-DELIVERY-03 ("after sign-up, the chooser") is
   therefore superseded and is recorded as a deferral the user has seen (P4-D1).
2. **Grace is stored but never applied.** `recognition.find_stations_for_audio` ignores
   `campaigns.time_window_grace_period` (default 10 minutes; the portal saves 0, 5, 10 or 20). The
   wording disagrees too: the portal says "Keep giving the buttons after a slot ends", the contract
   comment says "after a time window closes", and the plan says "± grace" (Q1).
3. **The hint is checked but unused.** `hinted_station_id` has a foreign key to `app.stations`, so
   storing an unknown id would fail as a 500. The hint must be looked up before it is stored.
4. **Status has no history.** Candidates are filtered by the *current* status of the station and
   the campaign. A campaign paused after the clip was heard drops out entirely, and the listener
   gets "no match" instead of the client's default card (O13). A re-claim reads the status at the
   retry, not at the first receipt.
5. **Missing pieces.** `recognition_events` has no `resolution` column. `recognition_candidates`,
   `engagement_events` and `campaign_counters` do not exist. The service builds only `MATCH` and
   `NO_MATCH`. `describe_recognition` (replays) does not re-check the station's status, so today a
   replay can return the card of a station suspended since the first answer.
6. **The coherence rule already exists.** `finish_recognition` accepts a card that is either the
   campaign's card or the client's default card. The choice can reuse that rule.
7. **The recognition id tells the receipt time.** The API makes the UUID version 7 id after the clip
   has been read, so `received_at` lies within about a minute before the id's own time. The choice
   and engagement routes can find the row by id and still prune the monthly partitions.
8. **The per-install count happens before the body is read**, so the server cannot know whether a
   request is deferred when it counts it. The app already sends the text fields before the audio
   (S4-D8), and the stand-in already refuses any other order.
9. **BullMQ's waiting count leaves out prioritised jobs.** In `bullmq` 6.3.11,
   `Queue.getWaitingCount()` counts only `waiting`, and a job added with a priority goes to the
   separate `prioritized` set. Once deferred jobs get a priority, the depth check must count both.
10. **The listener routes are an exact list.** `LISTENER_ROUTES` holds `/api/v1/recognize` and
    `/api/v1/installs` only. The new listener routes would otherwise fall under the portal's lower
    per-address limit, which many listeners behind one carrier address would hit.
11. **No job tooling yet.** There is no idempotency-key clean-up, no `runJob` wrapper, and the
    partition helper covers `recognition_events` only. No API route sets a client's default card.
12. **The clock skew is an integer twice over.** The column is `integer`, and so is the
    `clock_skew_milliseconds` parameter of `recognition.claim_recognition`, its only writer
    (EngineHookup migration). `clip-checks.ts` therefore stores NULL for a phone clock off by more
    than 2,000,000,000 ms (about 23 days). Widening the column alone would not help: the claim must be
    recreated too (P4-D2, P4-D18).
13. **Sample data reaches real numbers.** The contract has no station city, but the Chooser
    wireframe shows "98.1 FM · Lusaka". The two realistic sample numbers sit in 54 JSON fixture files
    (13 of them recognize-response fixtures) and 38 source and test files, and in the seed's
    `SAMPLE_PHONE`. The card schema takes any E.164 number, so Ofcom's drama range
    `+44 7700 900000–900999` works everywhere.
14. **Every sample ad has the same jingle.** The seed gives all its ads one generated jingle, so
    Station A already has two ACTIVE campaigns on one shared recording. Resolution must fold a
    station's campaigns into one candidate, or the chooser could list Station A twice.
15. **JSON bodies are parsed before the guards.** The 100 KB JSON parser runs as middleware, so for
    the new JSON routes a malformed or oversized body is answered before the token check. The
    contract's "order of checks" is corrected for this (§3).
16. **Every answer says `Cache-Control: no-store`.** The station list needs a deliberate exception
    for its 24-hour private cache (P4-D17).
17. **The default-card sentence will become wrong.** The Step 4 app says "This ad isn't on air right
    now, so these are [client name]'s usual contact details." From P4 a default card is also shown
    when a campaign is at its tap limit, or was paused after the clip was heard. Amendment A7 replaces
    the sentence with "These are [client name]'s usual contact details.", wording pending Q8.
18. **The Step 4 app shows "This needs a newer Look Up" for `CHOOSE_STATION`** and for 426. Until
    Piece 3, a two-station answer looks like that on the phone.
19. **No phone has identified against the real stack yet.** The Step 4 phone check steps 1, 3 and
    5–8 are still open. Piece 2's walkthrough is the first one; if it fails, that is fixed first.
20. **Three corrections to the interface contract** (§3): where JSON body parsing and the recognize
    route's own checks sit in the order of checks, the count of files with realistic numbers, and
    hints for unlisted stations.
21. **The API role reads every column of a recognition** (found in review). The Foundation migration
    grants `lookup_api` `SELECT` on the whole of `app.recognition_events`, filtered only by row
    policy, so a station's context could read `listener_install_id` and `hinted_station_id`, and from
    P4 a chooser recognition becomes visible to the chosen station. No API code reads the table
    directly (only the definer functions and the partition helper do), so column grants cost nothing
    (P4-D30).
22. **One circuit breaker serves every clip** (found in review). `recognition-breaker.ts` filters only
    `INVALID_AUDIO`, so a deferred job's timeout counts against the breaker that also refuses live
    clips. In `opossum` 10.0.0 a filtered error is counted as a success and closes a half-open
    breaker, so filtering deferred timeouts inside the shared breaker would hide live failures. Deferred
    sends get a breaker of their own (P4-D15).
23. **The in-flight limit is checked before the body is read** (found in review), so a deferred send
    refused there could only get the live `Retry-After` of 10 seconds, and a burst of deferred sends
    could take every place before their fields were read (P4-D15).
24. **A replay is never counted** (found in review). A finished key's attempt count never grows, so the
    "fewer than 5 attempts" exemption never ends for replays (P4-D14).
25. **`<@` does not prune partitions.** The compose database is `postgres:16-alpine`; partition pruning
    uses only the partition key's ordering operators, so a lookup written as `received_at <@ range`
    reads every month (P4-D32).
26. **The portal's time slots are quarter hours**, and "all day" is two slots (00:00–12:00 and
    12:00–00:00), so walkthrough steps must use quarter hours (§7, Piece 2).

---

## 1. The phase at a glance

```
clip ─► POST /recognize: fields first; then the places in flight (deferred: 16 of 32) and the
        per-install allowance chosen by is_deferred (a held key: the replay allowance)
        ─► claim the key ─► admission (deferred refused first) ─► worker ─► MATCH {audio asset}
                                                                              │
recognition.find_station_candidates(asset, corrected capture time)  ◄─────────┘
   the capture time decides:     the campaign's period, its windows ± grace,
                                 the slot that started last, the slot that ended last
   the processing time decides:  station ACTIVE; campaign ACTIVE (or paused or ended after the
                                 capture); tap limit reached; the current card version
                                                                              │
resolveStation(rows, hint)   TypeScript, no database                          ▼
   one candidate per station, each with its card: campaign card, client's default card, or none
   only one station can show a card ............................ MATCH           SINGLE_OWNER
   several can, exactly one has it on air ....................... MATCH           SCHEDULE_UNIQUE
   several have it on air, the hint is one of them .............. MATCH           HINT
   several have it on air, no usable hint ....................... CHOOSE_STATION  UNRESOLVED
   none has it on air, the hint owns it ......................... MATCH (default) HINT
   none has it on air, several own it ........................... CHOOSE_STATION of default cards
   no station can show a card ................................... NO_MATCH
                                                                              │
recognition.finish_recognition(outcome, resolution, hint, shown candidates) ─► answer (2–4 cards inline)

later, from the phone's outbox:
   POST /recognitions/{id}/choice {station_id}   ─► resolution LISTENER_CHOICE, 204
   POST /engagements {…}                          ─► tap stored once, counted once, 204   (gate part 2)
                                                     (a tap on an unanswered chooser is also the choice, A4)
```

What a listener can do once P4 and P6 are both built: identify an ad that two stations air at the
same time and get the sheet "Which station are you listening to?" with both stations' cards already
on the phone; tap one and see its buttons at once, even with no signal; tick "Remember my station" so
the next identify skips the sheet; identify with no signal and get the result later; tap a button
with no signal and have the tap counted once when the phone is back online.

---

## 2. What each person sees

This is a server phase, but every rule ends on someone's screen (ALL-DECISIONS-02).

**Listeners (the app; built in the P6 design, 320 and 360 dp, light and dark).**
- The chooser is a bottom sheet over a dimmed backdrop, with a drag handle. Its wording comes from
  the Chooser wireframe: "Which station are you listening to?", "This ad is on more than one station
  right now.", one row per station ("Station A", "98.1 FM · Lusaka"; "Station B", "104.3 FM · Kitwe")
  at least 56 dp tall, the checkbox "Remember my station — skip this next time" (ticked), and
  "Cancel". The rows come in the server's order (§5.1); the app never reorders them.
- When every candidate shows a default card (none is on air), the second line changes (Q8).
- Settings → "My station" shows "<name> · <frequency> — used when an ad is on more than one station",
  from the station list of §5.6.
- An app below the minimum version shows the P6 design's "Please update the app" screen instead of a
  result, and keeps its waiting clips. Its sending pause ends when the app is updated, when a live
  identify gets any other answer, or when a probe sent at app start or every 6 hours does (A2).
- A default card carries a short note above the buttons: "These are [client name]'s usual contact
  details." (A7; the words wait on Q8). It is shown for each reason a default card appears: the ad is
  out of its slots, the campaign was paused after the clip was heard, or it reached its tap limit.
- The notification for a result that arrives later never names the brand, the ad, the station or the
  outcome: "Look Up", "Your saved clip has been checked. Tap to see the result." (A6).

**Station staff (the portal, 375 and 1280 px).**
- The schedule step's grace control changes its wording once Q1 is answered: the label becomes
  "Keep giving the buttons before and after each slot", and the options "None: only during the slot"
  and "10 minutes before and after the slot". The control and its layout stay as they are.
- The tap limit field already exists in the schedule step; from Piece 5 it bites.
- A station never sees who a listener is, nor which other stations were offered for the same
  recognition (row-level security, §4.5). From P4 this holds in the database too: the API role cannot
  read a recognition's install, hint, idempotency key, phone capture time or clock skew (P4-D30).
- Analytics screens ("resolved" and "possible", taps per button) come in P7.

**Super admins.** "Report this" reports (if approved) are stored for the 5a console, each with an
anonymous code for the phone that sent it, so many reports from one phone can be told apart from
reports by many listeners (P4-D28). Until then the walkthrough shows them with a development script.

**Client viewers.** Nothing changes (5c).

---

## 3. Interface contract

Reproduced verbatim from the interface contract agreed for this phase and the P6 design. Only its
heading levels are moved down two steps so that it nests in this file, and the `|` inside the code
of two table cells (rule 1.0, "Per-address ceiling" and "App client") is written `\|` so that the
table keeps its columns; it still shows as `|`. Three corrections are added as marked notes; the
contract's own text is unchanged. The contract amendments decided after review (A1–A8) follow the
contract's last section, word for word as in the P6 design; where an amendment and the contract
differ, the amendment wins. Elsewhere in this file, "contract §1.3" means section 1.3 of the text
below, and "A4" means amendment A4.

### Listener app and API contract for P4 and P6

Paths are relative to `C:\dev\Look Up`. This contract is checked against these files: `packages/contracts/src/recognition/recognize-schemas.ts` and its fixtures, `apps/api/src/features/recognition/*`, `apps/api/src/common/{errors,rate-limiting,listener-authentication}`, `apps/mobile/lib/core/network/*`, `apps/mobile/lib/features/identify/{data,domain}`, `apps/mobile/tool/fake_listener_api.py`, the checklists and the approved plan. Where the two maps disagreed, the decision is stated here once, and section 5 lists each one.

**Gates.** Gate part 1 (P4-RESOLUTION-16) builds the recognize changes, the choice route, the station list and the update gate (426). The P6 chooser, outbox, History and Settings are built against those. Gate part 2 (P4-RESOLUTION-17) then builds the engagements route, which is specified in full now so the outbox is built once.

---

#### 1. Endpoints

##### 1.0 Rules for every listener route

| Rule | Exact contract |
|---|---|
| Base | `https://<host>/api/v1`. Plain `http` only in the development flavour (S4-D25, unchanged). |
| Listener routes | `POST /installs`, `POST /recognize`, `POST /recognitions/{recognition_id}/choice`, `GET /stations`, `POST /engagements`, `POST /recognitions/{recognition_id}/report`. `POST /client-errors` is public and is not a listener route. |
| Headers sent | `X-Request-Id`: a new lower-case version-4 UUID on every attempt. `Accept: application/json`. `Content-Type: application/json` on JSON bodies. `Authorization: Bearer <install token>` on every listener route except `/installs`. Never on `/installs` or `/client-errors`. |
| Headers received | `X-Request-Id` is echoed on every answer. `Retry-After` is in whole seconds on 409, 429 and 503. |
| Who may call | An ACTIVE install with a valid install token (`InstallTokenGuard`). Missing, malformed, expired or blocked gives **401 `INSTALL_TOKEN_INVALID`**. The app then registers again with the same install id, once, and resends. |
| Update gate | After the token check, the guard compares the install's **registered** `app_version` with the configured `LISTENER_MINIMUM_APP_VERSION`. Below it gives **426 `APP_UPDATE_REQUIRED`** on every install-token route. `/installs` and `/client-errors` never answer 426. Section 5, point 2 has the details. |
| Order of checks | Request id, then the per-address listener ceiling (429), then the token (401), then the app version (426), then the per-install allowance (429), then the body (400/413/415), then the route's own work. |
| Errors | Always `ErrorEnvelope` `{error:{code, message, request_id, fields?}}`. The app never shows `message` (S4-D13). An unknown code is handled by its HTTP status. |
| Bodies | JSON objects with `additionalProperties: false`. **Every value is a string**, so the app's `ContractSchemaChecker` (flat objects of strings only) can check every request body. Field names are full words in snake_case. Times are ISO 8601 with an offset; the app sends UTC as `YYYY-MM-DDTHH:MM:SS.mmmZ`. Ids are lower-case UUIDs. Recognition ids are version 7. |
| Never sent | Requests never carry the install id (except to `/installs`), device details, phone numbers, card contents or free text. Answers never carry an install id, campaign id, card id, counter, limit or match score (S3-RESPONSE-14). |
| Per-address ceiling | `LISTENER_ROUTES` in `apps/api/src/common/rate-limiting/limit-requests-per-client-address.ts` gains `/api/v1/stations`, `/api/v1/engagements` and the pattern `^/api/v1/recognitions/[0-9a-f-]{36}/(choice\|report)$`. All of these count against `LISTENER_REQUESTS_PER_CLIENT_ADDRESS_PER_MINUTE` (600). The test "covers exactly the listener app's routes" changes with it. |
| App client | `ApiClient.listenerRoutePaths` (`apps/mobile/lib/core/network/api_client.dart`) becomes a matcher for `recognize`, `stations`, `engagements` and `recognitions/<uuid>/(choice\|report)`. `ApiClient` gains `getJson(path, {installToken, ifNoneMatch})`, which returns `ApiAnswer` and never throws, like the existing methods. |

> **Correction 1 (this design, 10 October 2026; rewritten after review) — "Order of checks".** The
> order above is exact for no route. It is, in full:
>
> - **The JSON routes (choice, engagements, report).** Request id; the per-address listener ceiling
>   (429); the cross-site check, which acts only on a request that carries a cookie and so never on
>   the app (403); the JSON body parser, which runs as HTTP middleware (`configure-http-application.ts`)
>   before any guard (413 `PAYLOAD_TOO_LARGE` over 100 KB, 400 `INVALID_JSON`); the token (401); the
>   app version (426); the follow-up allowance (429); the path's recognition id (400); the body
>   against its schema (400 `VALIDATION_FAILED`); then the route's own work.
> - **`POST /recognize`** (§5.2 of this design). Request id; the per-address listener ceiling (429);
>   the cross-site check (403, cookie requests only); the token (401); the app version (426); the
>   recognize per-address limit, 300 a minute (429); the body's type and declared length (415, 413);
>   then, when the text fields have arrived and before any audio is read: the places in flight (503),
>   and the per-install allowance chosen by `is_deferred`, or the replay allowance for a key the
>   server already holds (429); invalid or missing fields (400); then the audio part (413, 400), the
>   clip's first bytes (415), the capture time (422), the claim (409 or a replay), admission (503),
>   the job and the wait (503), resolution and the answer.
>
> Because the places in flight are now checked after the text fields, no 503 is ever answered before
> the fields, so the sentence in §1.2 about "a 503 refused by the in-flight limit before the text
> fields are read" no longer applies: a deferred send always gets the deferred `Retry-After`. The app
> honours whatever value arrives, as before. The app never sends a malformed JSON body, so the outbox
> rules do not change. The S3-REQUEST-13 re-run asserts exactly these two orders.

##### 1.1 `POST /api/v1/installs` (existing, one behaviour change)

- The request `{install_id, platform, app_version}` and the answer `{install_token, expires_at}` are unchanged.
- **App change:** the app keeps the `app_version` it registered with. When the running `AppVersion.current` differs, it registers again (same install id) before its next listener request. If that registration gets no answer, the request counts as "no answer", so a clip is kept and nothing is sent with the old token.
- **Server:** registration never answers 426. It always records the version, so an updated app can clear the gate.
- Checklist: P6-COMPATIBILITY-01 (how the version travels, gap 37), S4-INSTALLS-02.

##### 1.2 `POST /api/v1/recognize` (existing; P4 changes)

**Request** (`multipart/form-data`). The fields are unchanged; two rules are new.

| Part | Value | P4/P6 rule |
|---|---|---|
| `clip_duration_milliseconds`, `codec`, `idempotency_key`, `captured_at`, `sent_at` | as today (S4 §3.10) | Deferred sends: `captured_at` and `idempotency_key` are the original values; `sent_at` is taken fresh before every attempt. |
| `is_deferred` | `"true"` or `"false"` | `"true"` for **every send made by the outbox**, `"false"` for every send made by the live flow. **The field as sent chooses the allowance, the admission threshold, the Retry-After range, the queue priority and the wait (2.5 s or 5 s).** The `is_deferred` that is stored and answered is the computed one: the flag, or receipt more than 120 s after the corrected capture time. |
| `station_hint` | the "My station" id, or absent | The station that was "My station" **when the clip was captured**. It is stored with an outbox clip and is not re-read at send time. The server uses it (HINT, P4-FALLBACK-01). A hint for an unknown, unlisted, suspended or non-candidate station is ignored silently, never refused. `hinted_station_id` is stored only when the station exists. |
| `audio` | file part, **last** | **New contract rule:** every text field comes before the audio part. If an audio part arrives before all the text fields, the server answers 400 `VALIDATION_FAILED` with `fields:[{path:"audio", code:"audio_part_before_fields"}]`. The app already sends in this order (S4-D8), and the fake already checks it. |

> **Correction 3 (this design, after review) — hints for unlisted stations.** The `station_hint` row
> above, and §5 point 8, ignore a hint for an "unlisted" station. Resolution (§5.1 of this design)
> never filters candidates by `is_listed_in_app`: an unlisted station that airs the ad is offered in
> the chooser like any other, so "Remember my station" can store it. Ignoring its hint would then ask
> that listener every time, despite the tick. The server therefore uses a hint for **any** station
> that is a candidate (on air, or with none on air an owner that can show a card), listed or not,
> and ignores it silently in every other case: unknown, suspended, or not a candidate. Being listed
> decides only whether a station appears in `GET /stations`. The P6 design's copy needs the same note.

> **Correction 4 (this design, after the app review, 11 October 2026) — what the app design settled.**
> The P6 design was revised against this one, and these points now hold for both:
> - **Pauses by group.** The app pauses its outbox by **allowance group**, not as a whole: clips, follow-ups
>   (choices, taps and reports, which share one server allowance, §5.11) and crash reports. A 426 still
>   pauses everything (A2). Read "pause the sender" in R8, R11 and the acknowledgement table as "pause the
>   item's group". The server's allowances are independent, so no server code changes.
> - **The acknowledgement fixture.** `acknowledgement-rules.json` gains default rows for each kind and
>   status class with no error code (the server's catalogue test skips rows that name no code); a row for a
>   deferred clip's 502, 503 or 504 that carries **no** `Retry-After` ("wait a random 60–300 s"); and a 409
>   row for every kind.
> - **Crash reports.** A queued crash report keeps one `report_id` and sends it as `X-Request-Id` on every
>   try; the API keeps a well-formed caller id (`assign-request-id.ts`). So after a lost answer the log can
>   hold the same request id twice for one report. That is expected, and "Find by reference code" shows both
>   lines.
> - **Clip lifetime on the phone.** The app deletes a waiting clip at 23 h 58 min by the phone clock, and at
>   once when its capture time is more than 2 minutes ahead of the phone clock. The server's 24-hour rule is
>   unchanged; this only explains why `CAPTURE_EXPIRED` is rare in practice.
> - **The stand-in** (contract §4) also: accepts on `/installs` a token it issued (A3); takes the replacement
>   phone number on its control page, never on the command line and never in its logs or state; serves
>   sample pictures at `/sample-images/…` with `--public-origin` for the https tunnel; checks the content
>   type, Origin and Host of every control request; and drops the connection for "No signal" before taking
>   any queued answer.
> - **The update message.** The 426 wording is the P6 design's §2.15 ("Please update the app" / "This
>   version of Look Up is too old to identify ads."), pending its Q14.

**Response 200**: the `RecognizeResponse` discriminated union, unchanged except for these points:

- `result.station` and every candidate's `station` become the shared **`ListenerStation`**: `{id, name, frequency_label, city, logo}`. `city` is a required field that may be `null`.
- `CHOOSE_STATION`:
  - It carries `candidates` with 2 to 4 entries and never a `result` (P4-CHOOSER-01, -02).
  - Each candidate's station id is distinct (a new schema refinement).
  - Each candidate carries its full `ListenerCard` inline (P4-CHOOSER-04).
  - The order is the server's display order, and **the app never reorders**.
  - In-window chooser: the kinds are `CAMPAIGN`. A candidate whose campaign is at its limit or was paused after the capture becomes `CLIENT_DEFAULT` (gate part 2 / O13).
  - Out-of-window chooser: every candidate is `CLIENT_DEFAULT` (P4-FALLBACK-02).
- A MATCH resolved by hint looks like any other MATCH; the resolution is never sent.
- No answer ever contains a station that is not ACTIVE (P4-RESOLUTION-14). After P4, `NO_MATCH` means "no owner, or no owner with a card to show". "Several stations" no longer produces `NO_MATCH`.

**Errors** (the "live" column is the P6 live flow; the "outbox" column is the deferred clip, section 3).

| HTTP | Code | Retry-After | When | Live flow (P6) | Outbox clip |
|---|---|---|---|---|---|
| 200 | MATCH / NO_MATCH / CHOOSE_STATION / unknown status | — | — | Result, Fallback, No match, **chooser sheet**, "newer app". Clip dropped. | delete |
| 200 | unreadable | — | — | Server failure plus a crash report. Clip dropped. | delete plus crash report |
| 400 | INVALID_AUDIO | — | worker could not use the clip; a replay answers it again | Recording unusable | delete |
| 400 | VALIDATION_FAILED, BAD_REQUEST | — | bad fields or order, slow body | Server failure plus a report | delete plus report |
| 401 | INSTALL_TOKEN_INVALID | — | token | Register again once, resend | register again once per run, then resend |
| 409 | RECOGNITION_IN_PROGRESS | 3 | same key PENDING for less than 30 s | Wait, resend the same key (at most 2 times) | keep; this item waits Retry-After |
| 413 | PAYLOAD_TOO_LARGE | — | — | Server failure plus a report | delete plus report |
| 415 | UNSUPPORTED_MEDIA_TYPE | — | — | Server failure plus a report | delete plus report |
| 422 | CAPTURE_EXPIRED, CAPTURE_TIME_INVALID | — | more than 24 h old, or more than 2 min in the future; permanent | Server failure plus a report (unchanged) | delete, no report |
| 426 | **APP_UPDATE_REQUIRED** (new) | — | registered version below the minimum | "This version of Look Up is too old. Please update the app." Clip dropped. | keep; sender paused until the app version changes |
| 429 | RATE_LIMITED | seconds left in the window | live: 6 a minute or 60 a day; **deferred: 10 an hour** | Too many tries, **clip moved to the outbox** (P6 change) | keep; sender paused until Retry-After |
| 500 | INTERNAL | — | stored as ERROR (transient) | Server failure, dropped (unchanged) | keep; item backs off |
| 503 | RECOGNITION_BUSY, RECOGNITION_TIMEOUT, SERVICE_UNAVAILABLE | live 10 or 5; **deferred: random 60–300, different on each answer** | admission or timeout | Busy, up to 4 sends, **then the clip moves to the outbox** (P6 change) | keep; sender paused until Retry-After |
| — | no answer (network) | — | — | **Saved offline: clip written to the outbox** | keep; run ends |

A 503 refused by the in-flight limit before the text fields are read still carries the live 10 s. The app honours whatever value arrives.

**Rate limits**
- Per address: 300 a minute for recognize, plus the 600-a-minute listener ceiling.
- In flight: 32 per instance.
- Per install, bucket chosen by the `is_deferred` field: live 6 a minute and 60 a day; deferred **10 an hour** (new `RECOGNITIONS_DEFERRED_PER_INSTALL_PER_HOUR`).
- The per-install count happens **after the text fields arrive and before the audio part is read**. Fields that fail validation count against the live bucket.
- A send whose `(install, idempotency_key)` the server already holds, with fewer than 5 attempts, is **not counted** against either per-install bucket. This covers replays, 409s and resends after a 503 (gap 21).
- Deferred admission: `RECOGNITION_DEFERRED_QUEUE_DEPTH_LIMIT` (default 20) is below the live 50, and the depth counts prioritised jobs. Deferred jobs get a lower BullMQ priority and a 5,000 ms deadline and wait.

**Idempotency and replay** (the key is `idempotency_key`, per install)

| Stored state of the key | Answer |
|---|---|
| none | claim, process |
| PENDING, less than 30 s | 409, Retry-After 3 |
| PENDING 30 s or more, BUSY, TIMEOUT, ERROR | re-claim: same `recognition_id`, first `received_at` kept |
| MATCH / MATCH_DEFAULT / NO_MATCH / AMBIGUOUS | 200 replay: same id and status, same card version. **If the matched station is no longer ACTIVE: `NO_MATCH` with the same id.** |
| CHOOSE_STATION | 200 replay of the same candidates, same cards, same order, even after a choice. Stations no longer ACTIVE are left out; if 1 remains it is a `MATCH`, if 0 remain it is `NO_MATCH`. |
| INVALID_AUDIO | 400 INVALID_AUDIO again (gap 13 settled) |

A replay creates no job and moves no counter. The `is_deferred` in a replay is the stored value, not an echo of the request.

**Checklist:** P4-TIMERULE-01..08, P4-CLOCK-01..08, P4-DEFERRED-01..10 and -12, P4-IDEMPOTENCY-01..21, P4-ADMISSION-01, P4-RESOLUTION-01..14, P4-FALLBACK-01..03, P4-CHOOSER-01..04, P4-LIMITS-05 (part 2), S3-RESPONSE-17, P6-STATE-02..04, P6-CHOOSER-07, -15, P6-MYSTATION-05, P6-OUTBOX-07, P6-OFFLINE-13..19, P6-LISTENING-02, P6-COMPATIBILITY-01..02, P6-TESTS-09.

##### 1.3 `POST /api/v1/recognitions/{recognition_id}/choice` (new, gate part 1)

- **Path:** `recognition_id` is a lower-case UUID version 7. If it is malformed: 400 `VALIDATION_FAILED` `{path:"recognition_id", code:"invalid_format"}`.
- **Body:** `{"station_id": "<uuid>"}`, schema `RecognitionStationChoiceInput`. The "Remember my station" tick never leaves the phone.
- **Answer:** **204, no body**, for an accepted choice and for a repeat of the same choice.
- **Effects** (for server tests):
  - `resolution = LISTENER_CHOICE`.
  - That candidate gets `is_chosen = true`, with at most one chosen per recognition.
  - The event's station, campaign and card become the candidate's.
  - No counter moves.
- **Idempotency:** the natural key is `recognition_id`. The first choice wins. The same station again gives 204 and changes nothing.
- **No time limit**, as long as the recognition exists; a deferred CHOOSE_STATION can be answered hours later. There is **no "cancel" request**: a cancelled sheet leaves the recognition `UNRESOLVED` (gap 28).

| HTTP | Code | When | Outbox |
|---|---|---|---|
| 204 | — | accepted or repeated | delete |
| 400 | VALIDATION_FAILED | body or path | delete plus report |
| 401 | INSTALL_TOKEN_INVALID | token | register again, resend |
| 404 | NOT_FOUND | unknown id, another install's recognition, or not a CHOOSE_STATION recognition | delete plus report |
| 422 | **STATION_NOT_A_CANDIDATE** (new) | station not among the candidates | delete plus report |
| 422 | **STATION_ALREADY_CHOSEN** (new) | a different station was chosen earlier | delete plus report |
| 426 | APP_UPDATE_REQUIRED | — | keep, pause sender |
| 429 | RATE_LIMITED | — | keep, pause until Retry-After |
| 500 | INTERNAL | — | keep, back off |
| 503 | SERVICE_UNAVAILABLE | — | keep, pause until Retry-After |

- **Rate limit:** `RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE` (60), shared with engagements and reports, plus the address ceiling.
- **Checklist:** P4-CHOICE-01..07, P4-RESOLUTION-11, -12, P6-CHOOSER-10, -14, P6-OUTBOX-02, -03, -05, P6-TESTS-07.

##### 1.4 `GET /api/v1/stations` (new, gate part 1)

- **Who:** install token, then the update gate, then `STATION_LIST_REQUESTS_PER_INSTALL_PER_HOUR` (20).
- **200 answer** `ListenerStationList`: `{"stations":[{id, name, frequency_label, city, logo}]}`.
  - It lists only stations whose status is `ACTIVE` and whose `is_listed_in_app` is true.
  - Order: `lower(name)` in C collation, then `frequency_label`, then `id`. There is no paging; at most 1,000 stations; an empty list is valid.
- **Headers:** `Cache-Control: private, max-age=86400` and a strong `ETag` (a hash of the body).
  - The app sends `If-None-Match` with its stored ETag.
  - A matching ETag gives **304 with no body** and the same headers. The app keeps its list and resets the list's fetch time.
- **App:** it caches the list with its fetch time in app-private storage and fetches again only after 24 h. Every error (401 after one re-registration, 426, 429, 5xx, no answer) keeps the cached list. This route is never an outbox item.
- The route sits beside the portal's `GET /stations/:stationId` without clashing. It is `@PublicRoute()` plus `InstallTokenGuard`, and a portal cookie gives no access.
- **Checklist:** P6-MYSTATION-01..04, -06 (D8), P6-CHOOSER-03 (city), P6-SETTINGS-03.

##### 1.5 `POST /api/v1/engagements` (new, gate part 2: build with P6-OUTBOX-06)

- **Body** `RecordEngagementInput`: `{recognition_id, station_id, action_id, occurred_at, sent_at}`.
  - `sent_at` is **added to the plan's four fields** (section 5, point 4).
  - The action type, labels and numbers are never sent.
- **Who:** install token, the update gate, then the follow-ups allowance (60 a minute).
- **Validity:**
  - The recognition must be finished and made by this install.
  - `station_id` must be a station whose card the answer showed: the MATCH's station, or a candidate of a CHOOSE_STATION. Once a choice exists, it must be the chosen station.
  - `action_id` must be an action on that station's card **as shown** (the stored card version). This covers P4-ENGAGEMENTS-05..07 and -10.
- **Server effects:**
  - Effective time = `occurred_at + (received − sent_at)`, clamped to `[recognition.received_at, now]` (P4-ENGAGEMENTS-03, -04).
  - The action type is taken from the card (-09).
  - The engagement counts toward the campaign limit only for a `CAMPAIGN` card and only the first time.
- **Answer:** **204, no body**, whether the tap was stored, was already stored, or did not count toward a limit. It never says which (gap 31).
- **Idempotency:** the natural key is `(recognition_id, action_id)`, kept in a small unpartitioned key table (-02, -12). The first tap wins.

| HTTP | Code | When | Outbox |
|---|---|---|---|
| 204 | — | valid tap, repeated or not, counted or not | delete |
| 400 | VALIDATION_FAILED | missing or extra field, bad time | delete plus report |
| 401 / 426 / 429 / 500 / 503 | as in 1.3 | — | as in 1.3 |
| 404 | NOT_FOUND | unknown id, another install, or not finished (PENDING or transient) | delete plus report |
| 422 | STATION_NOT_A_CANDIDATE | station not shown, or not the chosen one | delete plus report |
| 422 | **ACTION_NOT_ON_CARD** (new) | action id not on the shown card | delete plus report |

**Checklist:** P4-ENGAGEMENTS-01..12, P4-LIMITS-02..06, P4-TIMERULE-04, P4-IDEMPOTENCY-09, -20, P6-OUTBOX-05, -06.

##### 1.6 `POST /api/v1/recognitions/{recognition_id}/report` (new; build only if the user approves "Report this", P6-RESULT-04)

- **Body** `ReportRecognitionInput`: `{station_id, reason}`, where `reason` is one of `WRONG_OR_MISLEADING_BUTTONS`, `NUMBER_OR_LINK_DOES_NOT_WORK`, `LOOKS_LIKE_A_SCAM`, `SOMETHING_ELSE`. There is no free text.
- **Answer:** 204. There is one report per recognition: the first wins, and a repeat gets 204, even with another reason.
- Validity, errors and limits are the same as 1.5, without ACTION_NOT_ON_CARD.
- Reports are stored for the 5a console and are never shown to stations with any listener identity. They go through the outbox.
- **Checklist:** P6-RESULT-04, -05.

##### 1.7 `POST /api/v1/client-errors` (existing)

- `ClientErrorReport` gains an optional `occurredAt` (ISO with offset, camelCase like the rest of that schema) for reports queued offline. Answers stay 202, 400 and 429.
- **Checklist:** P6-ERRORREPORTING-05.

##### 1.8 Not a server route

`/r/<recognition_id>` opens a result from the local History cache only (gap 19). No server route is added.

---

#### 2. Changes to `packages/contracts`

##### 2.1 Schemas

```ts
// src/recognition/public-image-schema.ts (PublicImage moved here, unchanged, to avoid a circular import)

// src/recognition/listener-station-schemas.ts
export const ListenerStation = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(120),
  frequency_label: z.string().min(1).max(32),
  city: z.string().min(1).max(MAXIMUM_CITY_LENGTH).nullable(),   // from stations/station-schemas.ts
  logo: PublicImage.nullable(),
}).meta({ id: 'ListenerStation' });
export const MAXIMUM_LISTED_STATIONS = 1_000;
export const ListenerStationList = z.strictObject({
  stations: z.array(ListenerStation).max(MAXIMUM_LISTED_STATIONS),
}).superRefine(/* distinct ids, reason 'station_listed_twice' */).meta({ id: 'ListenerStationList' });

// src/recognition/recognize-schemas.ts
export const RecognitionId = z.string().regex(UUID_VERSION_7).meta({ id: 'RecognitionId' }); // exported, used below
export const MAXIMUM_CHOOSER_CANDIDATES = 4;
// RecognitionResult.station := ListenerStation
// RecognizeResponse: .superRefine(candidate station ids distinct, reason 'candidate_station_repeated')
// RecognizeRequestFields: comment states the text-fields-first rule and that is_deferred picks the allowance

// src/recognition/station-choice-schemas.ts
export const RecognitionStationChoiceInput = z.strictObject({ station_id: z.uuid() })
  .meta({ id: 'RecognitionStationChoiceInput' });

// src/recognition/engagement-schemas.ts
export const RecordEngagementInput = z.strictObject({
  recognition_id: RecognitionId,
  station_id: z.uuid(),
  action_id: z.uuid(),
  occurred_at: z.iso.datetime({ offset: true }),
  sent_at: z.iso.datetime({ offset: true }),
}).meta({ id: 'RecordEngagementInput' });

// src/recognition/recognition-report-schemas.ts (if approved)
export const RECOGNITION_REPORT_REASONS = ['WRONG_OR_MISLEADING_BUTTONS', 'NUMBER_OR_LINK_DOES_NOT_WORK', 'LOOKS_LIKE_A_SCAM', 'SOMETHING_ELSE'] as const;
export const ReportRecognitionInput = z.strictObject({ station_id: z.uuid(), reason: z.enum(RECOGNITION_REPORT_REASONS) })
  .meta({ id: 'ReportRecognitionInput' });

// src/client-errors/client-error-schemas.ts: add occurredAt: z.iso.datetime({ offset: true }).optional()
```

##### 2.2 Constants and functions

- **`src/recognition/listener-app-versions.ts`**
  - `compareListenerAppVersions(first, second): -1 | 0 | 1 | null`. It parses `^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:\+(\d{1,9}))?$`, compares major, minor, patch, then build (a missing build counts as 0), and returns `null` when either value cannot be parsed.
  - `isBelowMinimumAppVersion(registered, minimum)`: true on −1, or on `null` when the minimum is not `0.0.0`.
  - The API configuration validates that `LISTENER_MINIMUM_APP_VERSION` (default `0.0.0`, gate off) parses.
- **`src/recognition/listener-outbox-rules.ts`**: the values the app and the server must agree on, equal to `fixtures/listener-outbox/timing-rules.json` (section 3).

##### 2.3 Reason codes

| Code | Where | Relayed in `VALIDATION_FAILED`? |
|---|---|---|
| `audio_part_before_fields` | recognize reader | yes: add `RECOGNIZE_REQUEST_REASONS` to `VALIDATION_REASON_CODES` |
| `candidate_station_repeated` | `RecognizeResponse` refinement | no (response rule; contract tests only) |
| `station_listed_twice` | `ListenerStationList` refinement | no |

##### 2.4 Error catalogue (`apps/api/src/common/errors/error-catalog.ts`) and envelope fixtures

| Code | HTTP | Message | Envelope fixture (new, `fixtures/errors/envelopes/`) |
|---|---|---|---|
| APP_UPDATE_REQUIRED | 426 | "Please update the app." | `app-update-required.json` |
| STATION_NOT_A_CANDIDATE | 422 | "That station isn't one shown for this recording." | `station-not-a-candidate.json` |
| STATION_ALREADY_CHOSEN | 422 | "A station was already chosen for this recording." | `station-already-chosen.json` |
| ACTION_NOT_ON_CARD | 422 | "That button isn't on this card." | `action-not-on-card.json` |
| NOT_FOUND (exists) | 404 | "Not found." | `not-found.json` |

`CODES_THE_APP_MAPS` in `packages/contracts/test/error-envelope-fixtures.test.ts` gains these five codes. The deferred Retry-After variants do **not** go in `errors/envelopes`, because that test allows one envelope per code with fixed Retry-After values. They live in the outbox fixture (2.6).

##### 2.5 Emitted JSON Schemas (`packages/contracts/schemas/`, `scripts/emit-json-schemas.ts`)

- New: `listener-station-list.schema.json`, `recognition-station-choice-input.schema.json`, `record-engagement-input.schema.json`, `report-recognition-input.schema.json`.
- Regenerated: `recognize-response.schema.json` (city), `client-error-report.schema.json`.
- `$id`s follow `https://contracts.lookup.invalid/<name>/1.json`.
- The three input schemas must stay flat objects of strings so the Dart `ContractSchemaChecker` can read them.

##### 2.6 Shared fixtures

Every fixture is `{description, <payload>}`. Invalid fixtures add `expected_issues:[{path, code}]`, so the API's `VALIDATION_FAILED.fields` and the Dart checker must name the same problem. All of them are read by `packages/contracts` tests (zod and emitted schema), by the API tests and by the Dart tests through `ContractFixtures`. The fake API serves the valid ones.

| Folder | Valid | Invalid |
|---|---|---|
| `recognition/recognize-request` (`fields`) | `deferred-send-from-the-outbox.json` (is_deferred "true", captured 10:00:00.000Z, sent 11:30:00.000Z, with hint), `live-identify-with-station-hint.json` | `station-hint-not-a-uuid.json`, `is-deferred-as-yes.json` |
| `recognition/recognize-response` (`response`) | **edit all existing** (add `city`, safe numbers and links); `choose-station.json` rewritten: Station A "98.1 FM", Lusaka; Station B "104.3 FM", Kitwe (as in the Chooser wireframe); each card with its own action ids. Add `choose-station-three-candidates.json`, `choose-station-four-candidates.json`, `choose-station-out-of-window.json` (all CLIENT_DEFAULT), `choose-station-deferred.json`, `match-campaign-station-b.json`, `match-station-without-city.json` | `choose-station-with-result.json`, `choose-station-five-candidates.json`, `choose-station-one-candidate.json`, `choose-station-same-station-twice.json`, `station-without-city-field.json`, `candidate-with-campaign-id.json` |
| `recognition/station-choice-input` (`body`) | `choose-station-b.json` | `missing-station-id.json`, `station-id-not-a-uuid.json`, `recognition-id-in-body.json`, `remember-flag-in-body.json` |
| `recognition/engagement-input` (`body`) | `call-button-tap.json`, `tap-sent-later-with-offset.json` | `missing-occurred-at.json`, `missing-sent-at.json`, `action-type-in-body.json`, `recognition-id-version-4.json`, `occurred-at-without-time-zone.json`, `phone-number-in-body.json` |
| `recognition/recognition-report-input` (`body`, if approved) | `looks-like-a-scam.json` | `free-text-comment.json`, `unknown-reason.json` |
| `recognition/listener-station-list` (`response`) | `two-stations.json`, `no-stations.json`, `station-without-city.json` | `station-status-included.json`, `listed-flag-included.json`, `same-station-twice.json`, `station-id-not-a-uuid.json` |
| `recognition/listener-app-versions/comparisons.json` | rows `{first, second, expected}`, including `0.1.0+1` < `0.1.0+2` < `0.2.0`, `1.0.0` = `1.0.0+0`, unparseable → null | — |
| `errors/envelopes` | the five new envelopes from 2.4 | — |
| `listener-outbox/acknowledgement-rules.json` | one row per `(item_kind, http_status, error_code, retry_after_seconds)` → `{action, wait}` (table in section 3); includes deferred 503 with 187 s and deferred 429 with 2,400 s | — |
| `listener-outbox/timing-rules.json` | the numbers in section 3 | — |

##### 2.7 Data rules for fixtures and the seed

- **Phone numbers:** only Ofcom's drama range, **+44 7700 900000–900999** ("will not be allocated to communications providers in the foreseeable future"). Use `+447700900NNN` with NNN unique per card within a fixture. There is no such reserved range known for Zambia. The card schema accepts any E.164 number, and the +260 nine-digit rule only applies to +260.
- **Links:** `https://example.com/...` (reserved by RFC 2606). `example.co.zm` is not reserved and is used in 16 fixture files today.
- **Edit and replace now:** the 13 recognize-response fixtures (4 valid, 9 invalid) and the development seed's `SAMPLE_PHONE` must be edited in this phase anyway (city, Station B), so their numbers and links change in the same commit. The other files with `+260977123456` or `+260966123456` (about 54 fixture files plus tests) wait for the separate sweep the user is asked about. `phone_number_display_test`'s +260 formatting cases stay.

> **Correction 2 (this design, 10 October 2026; recounted after review) — the file count.** Counted
> on 10 October 2026 over the files git tracks: 54 JSON fixture files carry `+260977123456` or
> `+260966123456` **in all**, and 13 of them are the recognize-response fixtures edited now. Outside
> the fixtures, **49 source, test and script files** hold the same two numbers in some written form:
> 37 in the `+260` form, the others in local form (starting `09…`), grouped with spaces or as bare
> digits. One of them is screen text every station user sees: the portal's phone-number hint in
> `apps/portal/src/features/ad-buttons/button-row.tsx`. Five documents quote them too. The separate
> sweep therefore covers **45 fixture files** (41 in the `+260` form, and 4 that hold the numbers only in
> local or spaced form: `action-card/invalid/local-phone-number`, `phone-with-spaces`,
> `zambian-number-ten-digits` and `action-card/reader/bad-phone-skipped`; 58 fixture files in all,
> recounted by the app review) plus those **49 files in every written form, screen text and comments
> included**, not "about 54 fixture files plus tests".

##### 2.8 Tests that change on purpose

- **Contracts:** `recognition-schemas.test.ts` ("has fixtures for every status…" lists the new fixtures), `error-envelope-fixtures.test.ts`, the committed JSON Schemas test.
- **API:** `recognition-rules.test.ts` ("covers exactly the listener app's routes"). The **S3-REQUEST-13 evidence must be re-run**, because the per-install count moves after the text fields.
- **App:**
  - `recognize_response_parser_test` (CHOOSE_STATION candidates and recognition_id)
  - the T19 tests (CHOOSE_STATION becomes the chooser)
  - T24 (429 now keeps the clip in the outbox)
  - T27/T37 ("No connection" becomes Saved offline)
  - the `ApiClient` listener-route tests
- **Fake:** `tool/test_fake_listener_api.py`.

---

#### 3. Rules for deferred clips and outbox entries

Item kinds: `DEFERRED_CLIP`, `STATION_CHOICE`, `ENGAGEMENT`, `RECOGNITION_REPORT`, `CLIENT_ERROR_REPORT`. One sender sends every kind.

**`timing-rules.json`** (mirrored by `listener-outbox-rules.ts`, the Dart constants and, where it has them, the API configuration defaults):

```json
{ "maximum_stored_clips": 5, "stored_clip_lifetime_seconds": 86400,
  "follow_up_item_lifetime_seconds": 604800, "maximum_follow_up_items": 200, "maximum_queued_client_error_reports": 20,
  "sending_delay_maximum_seconds": 120, "sending_delay_for_new_item_while_online_maximum_seconds": 10,
  "deferred_shed_retry_after_minimum_seconds": 60, "deferred_shed_retry_after_maximum_seconds": 300,
  "longest_honoured_retry_after_seconds": 3600, "backoff_first_wait_seconds": 30, "backoff_longest_wait_seconds": 1800,
  "backoff_lowest_jitter_factor": 0.5, "registrations_after_refused_token_per_run": 1,
  "deferred_allowance_per_hour": 10, "live_server_wait_milliseconds": 2500, "deferred_server_wait_milliseconds": 5000 }
```

| # | Rule | App test | Server test |
|---|---|---|---|
| R1 | **What enters the outbox.** A clip enters when a live send gets no answer (no connection, timeout or dropped connection); when Busy gives up after the 4th busy answer, or the app goes to the background during Busy; and on a live 429. It keeps the **same key, audio, `captured_at` and capture-time hint**. A choice enters on a chooser row tap. A tap entry is coalesced: one per `(recognition_id, action_id)`, with the first tap's time. A report enters once per recognition. A crash report enters when it cannot be sent. | Throwing fake network: the state is Saved offline and the outbox holds 1 clip with the original key (P6-STATE-04, P6-OFFLINE-01, P6-LISTENING-02). Two Call taps give one entry. | — |
| R2 | **Deferred send fields.** `is_deferred:"true"`; original `captured_at` and `idempotency_key`; `sent_at` fresh per attempt; `station_hint` from capture time or absent; text fields before audio. | FakeClock: captured 10:00, sent 11:00 (fails), sent 11:30. Both sends have `"true"`, the same key and captured time, and sent times 11:00 and 11:30 (P6-OUTBOX-07). | `deferred-send-from-the-outbox.json` gives `is_deferred` true on the row and in the answer, the corrected `captured_at`, and the hint stored (P4-DEFERRED-01, P4-RESOLUTION-10). |
| R3 | **Bucket and exemption.** The server picks the bucket from the field. A held key with fewer than 5 attempts is not counted. | — | After 10 deferred sends, the 11th new key gets 429 while a live send succeeds, and the reverse. Resending a held key after a 503 gets no 429 (P4-DEFERRED-03, -04). |
| R4 | **Shedding.** Every 503 answered after the fields were read, to a request with `is_deferred:"true"`, carries a random Retry-After of 60–300. Deferred jobs get the lower priority and 5 s. | Retry-After 187: no send before 187 s (P6-OFFLINE-18). | 50 shed answers all in [60, 300] and not all equal; depth between 20 and 50 sheds deferred and admits live; the paused-worker priority test; about 5 s versus about 2.5 s (P4-DEFERRED-05..09). |
| R5 | **Expiry.** A clip is deleted unsent at its `captured_at` (phone clock) + 24 h. A follow-up item is deleted 7 days after it was queued. This is checked at start, at resume, before each send and in the background job. **There is a sixth clip: the oldest waiting clip is deleted** (pending the user). | FakeClock at 24 h + 1 s: file gone and nothing sent; 6 captures leave 5 (P6-OFFLINE-04, -05). | 24 h + 1 s gives 422 CAPTURE_EXPIRED, permanent, with no job (P4-CLOCK-05, -07). |
| R6 | **When a run starts.** On app start (after the first frame), resume, network regained while open, and the background job (if approved). The run waits a **random whole number of 0–120 s, drawn once per run** from an injected `Random`, not before each item. When an item is queued while the last run sent everything, the wait is 0–10 s. No outbox send starts while a live identify is recording or sending. | Seeded `Random` plus FakeClock: the first send at the drawn second; a 3-item run waits once (P6-OFFLINE-07, -12). | — |
| R7 | **Order and concurrency.** One request in flight. The oldest eligible item goes first: clips by `captured_at`, other items by queued time. Items waiting on their own backoff are skipped. A choice is always queued before taps of the same recognition. | 10:00, 10:05, 10:10 are sent in that order; a slow fake network never has 2 in flight (P6-OFFLINE-10, -11). | The engagement route accepts any shown candidate before a choice exists (no ordering dependency). |
| R8 | **Waits.** A `Retry-After` is honoured exactly, clamped to [1, 3600]. Without one, the item waits `min(30 × 2^(n−1), 1800) s × U[0.5, 1.0]` after its n-th failure. **429 or any 503 pauses the whole sender** for the wait. 409 delays only its own item. 500 backs off only its own item. A network failure ends the run. | FakeClock waits grow; Retry-After 120 is honoured (P6-OUTBOX-04). | The deferred 429 Retry-After equals the seconds left in the hour. |
| R9 | **Acknowledgement.** The table below. Server and app both test it with `acknowledgement-rules.json`. | Each row: `OutboxAcknowledgementPolicy.decide(kind, status, code, retryAfter)` equals the expected action (P6-OFFLINE-13..19). | Each row's code has that HTTP status in `ERROR_CATALOG`; each route's e2e suite produces every code listed for it. |
| R10 | **401.** Register again with the same install id, at most once per run, and resend that item. A second 401 ends the run. | Fake 401 then 204: one registration and one resend. | Bad token gives 401 on every new route (P4-CHOICE-07, P4-ENGAGEMENTS-08). |
| R11 | **426.** Keep every item and pause the sender until `AppVersion.current` differs from the version stored at the pause. Expiry continues. | 426 then no further sends; a version change resumes. | Install below the minimum gives 426 on recognize, choice, engagements, stations and report; after re-registering with a new enough version, 200 or 204. |
| R12 | **Idempotency on retry.** Clip: `idempotency_key`. Choice: `recognition_id`. Tap: `(recognition_id, action_id)`. Report: `recognition_id`. No `Idempotency-Key` header. `X-Request-Id` is new per attempt. | Three failed sends of one item carry the same key; two items carry different keys (P6-OUTBOX-03). | The same choice, tap or clip sent 3 times gives one row and three successes (P4-CHOICE-02, P4-ENGAGEMENTS-02, P6-OUTBOX-05). |
| R13 | **Results of deferred clips.** History is keyed by `recognition_id` (a replay after a lost answer cannot duplicate it), plus a local notification. A deferred CHOOSE_STATION opens the chooser from the notification. | Fake "answer lost" then a replay: one History row. | Replay gives the same id (P4-IDEMPOTENCY-05). |

**Acknowledgement table** (the rows of `acknowledgement-rules.json`)

| Answer | DEFERRED_CLIP | STATION_CHOICE / ENGAGEMENT / RECOGNITION_REPORT | CLIENT_ERROR_REPORT |
|---|---|---|---|
| 200 (any status) / 204 / 202 | delete (unreadable 200: delete plus report) | delete | delete |
| 400 INVALID_AUDIO | delete | — | — |
| other 400, 403, 404, 405, 413, 415 | delete plus report | delete plus report | delete (never a report about a report) |
| 401 | register again, resend | register again, resend | delete |
| 409 RECOGNITION_IN_PROGRESS | keep, item waits Retry-After (default 3) | — | — |
| 422 CAPTURE_EXPIRED / CAPTURE_TIME_INVALID | delete, no report | — | — |
| 422 STATION_NOT_A_CANDIDATE / STATION_ALREADY_CHOSEN / ACTION_NOT_ON_CARD | — | delete plus report | — |
| 426 | keep, pause until the app version changes | same | keep |
| 429 | keep, pause sender (default 60) | same | same |
| 500 | keep, item backs off | same | same |
| 502 / 503 / 504 | keep, pause for Retry-After, otherwise the item backs off | same | same |
| no answer (network) | keep, end run | same | same |
| phone fault | delete plus report | delete plus report | delete |

---

#### 4. Python stand-in API (`apps/mobile/tool/fake_listener_api.py`)

It stays standard library only, stays strict, and answers only from shared fixtures.

**Behaviour changes**
- One scenario queue per route. `POST /__fake/scenarios` is unchanged; each name belongs to one route, and recognize names keep their current meaning.
- Recognize:
  - It makes a **new UUID version 7 per new idempotency key** (hand-written: 48-bit milliseconds plus random) and **replays the stored 200 answer for a repeated key**, logged as scenario `replay`.
  - It remembers which recognition ids it answered with which candidates or station and card.
  - The request log adds the values of `is_deferred`, `captured_at`, `sent_at`, `station_hint` and `idempotency_key` (no personal data).
- Every listener route checks the token the fake issued, and refuses a body outside the contract with 400, so the run fails.

**New routes**

| Route | Checks (refuse means the test fails) | Default answer |
|---|---|---|
| `GET /api/v1/stations` | token | 200 `listener-station-list/valid/two-stations.json`, `ETag: "fake-stations-1"`, `Cache-Control: private, max-age=86400`; a matching `If-None-Match` gives 304 |
| `POST /api/v1/recognitions/{id}/choice` | body equals `{station_id}`; id is a CHOOSE_STATION the fake gave; station is one of its candidates | 204; the same station again gives 204; a different station gives 422 STATION_ALREADY_CHOSEN |
| `POST /api/v1/engagements` | strict five fields; recognition, station and action are ones the fake answered | 204, deduplicated per `(recognition_id, action_id)` |
| `POST /api/v1/recognitions/{id}/report` (if approved) | `{station_id, reason}` from the enum | 204, one per recognition |

**New control routes**
- `POST /__fake/offline {"is_offline": true|false}`: while on, every `/api/v1/*` connection is closed unanswered and logged as `dropped: offline`.
- `POST /__fake/minimum-app-version {"minimum_app_version": "0.2.0"}`: compares the `app_version` the install registered with, as the real guard does, and answers 426 on every listener route.
- `GET /__fake/state`: recognitions by key, choices, engagements, reports and the station-list request count.
- `/__fake/reset` also clears the switches.
- Optional CLI flag `--replace-phone-numbers-with <E.164>` replaces numbers in answers **in memory only**, for a phone check against the user's own number. It is never written to a file.

**New scenarios**

| Scenario | Route | Answer | Shows / proves |
|---|---|---|---|
| `choose-station-three`, `choose-station-four` | recognize | the 3 and 4 candidate fixtures | P6-CHOOSER-02 |
| `choose-station-out-of-window` | recognize | all CLIENT_DEFAULT | out-of-window sheet wording, P4-FALLBACK-02 (app half) |
| `match-by-hint` | recognize | requires `station_hint`; answers the hinted station's MATCH (`match-campaign-station-b.json` for B); refuses if there is no hint | P6-CHOOSER-07, -15 |
| `match-answer-lost` | recognize | stores a MATCH for the key, then closes the connection; the retry gets the replay | P6-OUTBOX-05 (1) |
| `busy-deferred-shed` | recognize | 503 RECOGNITION_BUSY, Retry-After 60 (the real range's minimum, keeps demos short) | P6-OFFLINE-18 |
| `rate-limited-deferred` | recognize | 429, Retry-After 90 | P6-OFFLINE-17 |
| `in-progress` | recognize | 409, Retry-After 3 | P6-OFFLINE-16 |
| `capture-expired` | recognize | 422 CAPTURE_EXPIRED | P6-OFFLINE-14 |
| `choice-answer-lost`, `choice-busy`, `choice-not-a-candidate` | choice | records then drops / 503 Retry-After 6 / 422 | P6-CHOOSER-10, drop path |
| `engagement-answer-lost`, `engagement-busy` | engagements | — | P6-OUTBOX-06 |
| `stations-unavailable` | stations | 503 | picker keeps its cache |

**Emulator walkthrough per state**
- **Chooser:** queue `choose-station`, then Identify, then the sheet. Turn offline on and tap Station B: Result "via Station B" appears at once. Turn offline off: `/__fake/state` shows exactly 1 choice.
- **Remember my station:** with Remember ticked, queue `match-by-hint`, then Identify: no sheet, and the log shows the hint.
- **Station picker:** Settings, then My station: one GET; reopening gives no GET within 24 h.
- **Saved offline:** offline on, then Identify, then Saved offline, then History Pending. Offline off: the log shows `is_deferred=true`, the same key and a new `sent_at`, followed by the result and the notification.
- **Shed and limited sends:** queue `busy-deferred-shed` or `rate-limited-deferred`, then `match`: the second send comes at least Retry-After later.
- **Update gate:** set the minimum version to `0.2.0`: "Please update the app".
- **Queued crash report:** offline on, "Send a test error", offline off: one report with `occurredAt`.

**Development-only setting.** The development flavour accepts `LOOKUP_OUTBOX_SENDING_DELAY_MAXIMUM_SECONDS` (for example 5) so emulator runs don't wait 2 minutes. Staging and production builds refuse any value other than 120 at start-up.

**Fake's own tests.** `test_fake_listener_api.py` covers each new route accepting the valid fixtures and refusing the invalid ones, replay by key, the offline switch and the version gate.

---

#### 5. Open points the two designs must decide the same way (recommended decision)

1. **Deferred allowance (gap 21).**
   - The `is_deferred` field picks the bucket, the threshold, the Retry-After, the priority and the wait.
   - The server counts after the text fields and before the audio; audio before the fields gives 400 `audio_part_before_fields`.
   - Held keys with fewer than 5 attempts are not counted; invalid fields count as live.
   - The app sends `"true"` only from the outbox and always sends the fields first.
2. **App version for 426 (gap 37).**
   - The version is the one stored at registration; there is no new header.
   - The app registers again whenever its running version differs from the registered one, and sends nothing with the old token.
   - 426 comes from every install-token route, never from `/installs` or `/client-errors`.
   - The minimum defaults to `0.0.0`, compared by `comparisons.json`.
   - No card `min_app_version` field: P6-COMPATIBILITY-03 is met by this gate plus the reader's `schema_version` rule. Record that as the reason.
3. **Codes and statuses.**
   - Permanent refusals use 422 (STATION_NOT_A_CANDIDATE, STATION_ALREADY_CHOSEN, ACTION_NOT_ON_CARD) or 404 (unknown recognition, another install's, or one that is not finished).
   - 409 is used only for RECOGNITION_IN_PROGRESS, so "409 means wait and retry" holds on every route.
   - Successful follow-ups answer **204 with no body**.
4. **Engagements (gaps 28 and 31).**
   - 204 whether or not the tap counted.
   - Station: the shown station, or the chosen one once a choice exists.
   - Action: on the card version shown.
   - The first tap wins.
   - Taps on default cards are stored but never counted.
   - **Add `sent_at`** for O11-style clock correction before the clamp. If the user declines, drop the field and the correction step from both sides together.
5. **Choice (gap 30).** Same install only (others get 404). The first choice wins and a different one gets 422. No time limit. No cancel request (gap 28).
6. **Chooser content (gaps 7, 18, 25, 26).**
   - Nullable `city` in the shared `ListenerStation` (candidates and the station list).
   - 2–4 distinct stations.
   - In-window chooser order: the slot that started most recently first, ties by name. Out-of-window order: the most recent slot end in the last 7 days, ties by name. More than 4: the first 4 by that order.
   - Owners with no card to show are left out. If exactly 1 remains, the answer is MATCH.
   - The app shows candidates in the order received.
   - When **all candidates are CLIENT_DEFAULT**, the sheet must not say "on more than one station right now". Proposed text: "This ad is played on more than one station." (no wireframe; the user approves the wording).
7. **Replays (gap 13, P4-RESOLUTION-14).**
   - A suspended station's MATCH replays as NO_MATCH with the same id.
   - A chooser replays identically, minus stations no longer ACTIVE.
   - INVALID_AUDIO stays 400.
8. **Hint.**
   - Taken at capture time and stored with an outbox clip.
   - Ignored silently when unknown, unlisted, suspended or not a candidate; stored only if the station exists.
   - The app never clears "My station" by itself, even when it is missing from the fresh list.
9. **The live flow feeds the outbox.** No answer, Busy given up or backgrounded, and live 429 all move the clip to the outbox with the same key (the plan's acknowledgement rule). Live 500 and 422 keep the Step 4 behaviour.
10. **Lifetimes.** Follow-up items live 7 days on the phone. The server puts no time limit on choices, engagements or reports while the recognition row exists. Note for P7: taps arriving more than 48 h late fall outside the rollup's re-aggregation window.
11. **"Report this" (gap 5).** It needs the user's approval of route 1.6 and the four reasons. If declined, P6-RESULT-04 needs another answer before the P6 gate.
12. **Phone numbers and links.**
    - Use +44 7700 900000–900999 and `example.com` in all new and edited fixtures and in the seed.
    - The remaining sweep of the existing +260 numbers waits for the user's approval as one mechanical change.
13. **Sixth clip (gap 17).** Delete the oldest waiting clip and keep the new one.
14. **History time.** Show the phone's own capture time for Pending and finished rows, so a row doesn't jump when the answer comes. The parser still keeps the answer's `captured_at`.
15. **Out of scope for this contract, with reasons recorded.**
    - Banner width and WebP variants (P6-DATASAVER-01): deferred until stations can upload images; `PublicImage` is unchanged.
    - Server-only items with no wire effect: grace on both sides, the campaign status-change time for O13, the out-of-window column, key clean-up, partitions.
16. **Preconditions before building the outbox.**
    - Diagnose Step 4 emulator run 4 ("no match" shown as "No connection"), because P6 rewrites that no-answer path.
    - Re-run the S3-REQUEST-13 order tests after the per-install count moves.

### Contract amendments after review (10 October 2026)

Two critics checked both designs against the checklists and the code. These amendments change the contract above. They are the same, word for word, in the server design (`docs/design/phase-4-station-resolution-and-engagements.md`) and the app design (`docs/design/phase-6-full-listener-app.md`). Where an amendment and the text above differ, the amendment wins.

- **A1. R8, waiting after "no answer".**
  - A run that ends on "no answer" (no connection, a timeout or a dropped connection) counts as a failure of the item it was sending. That item waits `min(30 × 2^(n−1), 1800) s × U[0.5, 1.0]` after its n-th failure, like any other failure.
  - While the app is in the foreground, the sender schedules a wake-up for the earliest `next_attempt_at` of the items left. A run therefore starts again by itself, without a restart, a resume or a network event.
  - The development flavour may use a 5 s base instead of 30 s. That is a configuration value, and a test proves staging and production use 30 s.
  - Built from Piece 1.
  - App test (FakeClock and a seeded `Random`): no answer at 10:00:00, then the next send happens at the drawn second, inside [10:00:15, 10:00:30], with the app left open.
- **A2. R11, how a 426 pause ends.** The pause ends at the first of these:
  - (a) `AppVersion.current` differs from the version stored at the pause;
  - (b) a live identify gets any answer other than 426;
  - (c) a probe. While paused, the sender sends one item at each app start and every 6 hours, and an answer other than 426 resumes sending.

  So a minimum version set by mistake, then lowered again, cannot freeze a phone's outbox until its clips expire. App test: a 426, then a probe answered with 204, resumes sending; a 426 answer to the probe keeps the pause.
- **A3. §1.1, re-registration after an update.**
  - A `POST /api/v1/installs` that carries a valid install token for the same `install_id` is a re-registration.
  - A re-registration does not count against `LISTENER_REGISTRATIONS_PER_CLIENT_ADDRESS_PER_HOUR`. It counts against `LISTENER_REREGISTRATIONS_PER_INSTALL_PER_DAY` (5) instead. Many listeners share one carrier address, and they all register again after an app update.
  - Server tests:
    - with the address limit used up, a re-registration with the install's own valid token still succeeds;
    - the same request without a token gets 429;
    - an install's 6th re-registration in a day gets 429.
- **A4. §1.5 and R7, a tap before a choice.**
  - A tap on a station of a recognition that is still `UNRESOLVED` (a chooser with no choice yet) records that station as the listener's choice. It does so in the same transaction and under the same row lock as `record_station_choice`, and sets `resolution = LISTENER_CHOICE`.
  - A later tap or choice for **another** station of that recognition gets 422 `STATION_ALREADY_CHOSEN`: delete, plus a report. So one chooser answer can no longer count taps for up to four stations.
  - The app's rule that a choice is queued before the taps of the same recognition still holds.
  - Server tests:
    - taps on two candidate stations of one chooser recognition: the first gets 204, the second gets 422;
    - the event's chosen station is the first one;
    - only the chosen station's campaign counter moves.
- **A5. §2.1, `RecognitionId`.** `RecognitionId` gets no registry id (no `.meta({ id })`; a description only). The emitted JSON Schemas of the three new input schemas (`RecognitionStationChoiceInput`, `RecordEngagementInput`, `ReportRecognitionInput`) then hold only plain string properties, with no nested `$ref` that the Dart fixture checker cannot follow. A contracts test asserts this.
- **A6. R13, the notification's words.**
  - The notification for a deferred result never names the brand, the ad, the station or the outcome, in any version, including the lock-screen one. Its title is "Look Up" and its text is "Your saved clip has been checked. Tap to see the result."
  - The details appear only inside the app, after the tap. Android shows the full text of a private notification on the lock screen by default, so a public version alone would not keep them private.
- **A7. The default card's note** (wording pending the user's answer to the shared question).
  - When `result.kind` is `CLIENT_DEFAULT`, the Result screen says "These are [client name]'s usual contact details." This replaces Step 4's "This ad isn't on air right now, so these are [client name]'s usual contact details."
  - From P4 a default card also appears when the campaign was paused after the clip was heard, or reached its tap limit, while the ad is still on air.
  - The app gets an ARB key for it, and a widget test for each reason: out of its slots, paused after capture, at its tap limit.
- **A8. Engagements and recognitions.**
  - `app.engagement_events` has **no foreign key** to `app.recognition_events`. `record_engagement` checks the recognition itself, as `recognition_reports` already does.
  - Both tables are partitioned by arrival time, and taps arrive up to 30 days after their recognition. A foreign key between them would stop old months of `recognition_events` from being detached.
  - A database-scaling test detaches a month that later taps point to.

---

## 4. Database: migration `1791600000000-StationResolution`

**One new migration** holds every schema change of P4, including the tables and functions that only
Piece 5 uses (P4-D2), the recreated `recognition.claim_recognition` (P4-D2, P4-D18) and the column
grants that replace the API role's table-wide read of `recognition_events` (P4-D30). Released
migrations are checksum-pinned in `apps/api/test/source-scan.test.ts` and are never edited. This one is pinned there when Piece 2 is committed; any later change is a new
migration. Every new function is `SECURITY DEFINER`, owned by `lookup_schema_owner`, with
`search_path = pg_catalog, <its schema>, pg_temp`, `EXECUTE` revoked from `PUBLIC` and granted only to
the role named. The migration explains each scaling choice in a comment (ALL-MIGRATIONS-04).

### 4.1 Columns and constraints added to existing tables

| Table | Change | Why |
|---|---|---|
| `app.recognition_events` | `resolution text`, with `recognition_events_resolution_check` (`SINGLE_OWNER`, `SCHEDULE_UNIQUE`, `HINT`, `LISTENER_CHOICE`, `UNRESOLVED`) and `recognition_events_resolution_outcome_check`: a `CHOOSE_STATION` row holds `UNRESOLVED` or `LISTENER_CHOICE` (its outcome stays `CHOOSE_STATION` after a choice, because that is the answer that was given); a `MATCH` or `MATCH_DEFAULT` row holds `SINGLE_OWNER`, `SCHEDULE_UNIQUE` or `HINT`; every other outcome holds NULL. *Amended after review:* a plain check cannot exempt older rows, so the migration first fills the rows finished before it (development data only; nothing is deployed): `MATCH_DEFAULT` gets `SINGLE_OWNER` (Step 3 gave a default card only when one station owned the recording) and `MATCH` gets `SCHEDULE_UNIQUE` (Step 3 answered `MATCH` only when exactly one station had the ad on air). The strict check is added after that (P4-D33). | P4-RESOLUTION-11; gap 27 |
| `app.recognition_events` | `clock_skew_milliseconds` becomes `bigint`, and `recognition.claim_recognition`, its only writer, is dropped and created again with a `bigint` parameter (§4.4) | P4-CLOCK-04 (P4-D18, P4-D2) |
| `app.campaigns` | `status_changed_at timestamptz NOT NULL DEFAULT now()`, filled from `updated_at` for existing rows; trigger `campaigns_set_status_changed_at` (before update, when the status changes) | O13: "paused after the clip was heard" (P4-D4, Q3) |
| `app.campaigns` | `campaigns_time_window_grace_period_check`: between 0 and 60 minutes | the slot arithmetic of §4.3 looks one day around the moment; the portal offers 0–20 |
| `app.stations` | blank cities become NULL; `stations_city_check`: NULL or 1–80 characters | the city now reaches every listener; a longer one would break the answer's contract (P4-D27) |

### 4.2 New tables

Every station-owned row carries a NOT NULL `station_id`, references other station-owned rows through
composite keys `(id, station_id)`, and refers to `app.stations` with `ON DELETE RESTRICT`
(ALL-DATABASE-01, -02, -12, -13). No new table holds a listener install id (ALL-PRIVACY-01); the
reports table holds only a keyed hash of it, and only super admins can read that table.

**`app.recognition_candidates`** — the stations weighed for one recognition (G12): *amended after
review*, one row for every station that owns the matched recording and can show a card, whatever the
outcome, so a single-owner match writes one row (P4-D8, P4-RESOLUTION-12). Range-partitioned by month
on `recognition_received_at` (gap 47; P4-D8).

| Column | Type | Note |
|---|---|---|
| `recognition_id` | uuid NOT NULL | with `recognition_received_at`, references `app.recognition_events (id, received_at)` |
| `recognition_received_at` | timestamptz NOT NULL | the partition key: the recognition's first receipt |
| `station_id` | uuid NOT NULL | |
| `campaign_id` | uuid NOT NULL | composite key with `station_id` to `app.campaigns` |
| `action_card_id` | uuid NOT NULL | composite key with `station_id` to `app.action_cards`; the version sent inline (the replay snapshot) |
| `card_kind` | text NOT NULL | `CAMPAIGN` or `CLIENT_DEFAULT` |
| `is_in_window` | boolean NOT NULL | on air at the capture moment, grace included |
| `display_position` | smallint NULL | 1–4 for a station shown in a chooser, in display order; NULL when weighed but not shown |
| `is_chosen` | boolean NOT NULL DEFAULT false | the listener's choice |
| `chosen_at` | timestamptz NULL | set with `is_chosen` |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

Constraints and indexes: primary key `(recognition_id, recognition_received_at, station_id)`;
`recognition_candidates_card_kind_check`; `recognition_candidates_display_position_check` (1–4);
`recognition_candidates_chosen_is_shown_check` (a chosen row has a display position);
`recognition_candidates_chosen_at_check` (`chosen_at` set exactly when chosen); the partial unique index
`recognition_candidates_one_chosen_unique_index` on `(recognition_id, recognition_received_at) WHERE is_chosen`
(P4-CHOICE-05); the partial unique index `recognition_candidates_display_position_unique_index` on
`(recognition_id, recognition_received_at, display_position) WHERE display_position IS NOT NULL`;
indexes on `(station_id, recognition_received_at)`, `(campaign_id)` and `(action_card_id)`
(ALL-SCALING-05). *Amended after review:* a unique constraint cannot be partial, and the conventions
had no name for a partial unique index, so `docs/conventions.md` gains the rule
`<table>_<rule>_unique_index` (P4-D34); every other index keeps `<table>_<columns>_index`. Both unique
indexes include the partition key, as PostgreSQL requires on a partitioned table.

**`app.engagement_events`** — one row per distinct button tap (G4). Range-partitioned by month on
`received_at`, the tap's arrival at the server (gap 47; P4-D11).

| Column | Type | Note |
|---|---|---|
| `id` | uuid NOT NULL | UUID version 7 made by the API (ALL-SCALING-02) |
| `received_at` | timestamptz NOT NULL | partition key |
| `recognition_id`, `recognition_received_at` | uuid, timestamptz NOT NULL | name the recognition; *amended after review:* **no foreign key** to `app.recognition_events` (A8, P4-D11). `record_engagement` checks the recognition itself, as `record_recognition_report` does. |
| `station_id` | uuid NOT NULL | the station whose card was tapped |
| `campaign_id`, `action_card_id` | uuid NOT NULL | composite keys with `station_id`; the card version as shown |
| `card_kind` | text NOT NULL | `CAMPAIGN` or `CLIENT_DEFAULT` |
| `action_id` | uuid NOT NULL | the action's id on that card version |
| `action_type` | text NOT NULL | taken from the card, never from the request; check `^[A-Z][A-Z_]{0,31}$`, so a new action type needs no migration |
| `occurred_at` | timestamptz NOT NULL | corrected and clamped (§5.8) |
| `client_occurred_at` | timestamptz NOT NULL | the phone's own value, for audit |
| `clock_skew_milliseconds` | bigint NOT NULL | receipt minus the phone's `sent_at` |
| `is_counted` | boolean NOT NULL | counted toward the campaign's tap limit |
| `request_id` | text NOT NULL | |

Constraints and indexes: primary key `(id, received_at)`; `engagement_events_occurred_at_check`
(`occurred_at` between `recognition_received_at` and `received_at`);
`engagement_events_counted_card_check` (only a `CAMPAIGN` tap can be counted); indexes on
`(station_id, occurred_at)`, `(recognition_id, recognition_received_at)`, `(campaign_id, received_at)`
(it also serves the foreign key to campaigns, and the per-install count of P4-D10 reads it),
`(action_card_id)`, and a block-range index on `received_at`. Taps arrive up to 30 days after their
recognition (History) and up to 7 days later from the outbox, so a tap's month is often later than
its recognition's; without a foreign key between them, old months of either table are detached on
their own (§4.6).

**`app.engagement_deduplication_keys`** — the cross-month uniqueness of one tap per
`(recognition_id, action_id)` (P4-ENGAGEMENTS-12, ALL-SCALING-08). Not partitioned.
Columns `recognition_id`, `action_id`, `recognition_received_at`, `engagement_event_id`,
`engagement_received_at`, `created_at`. Primary key `(recognition_id, action_id)`; index on
`recognition_received_at` for the clean-up of §4.6. Row-level security on and deliberately no policy,
like `recognition_idempotency_keys`; no grant to any service role.

**`app.campaign_counters`** — taps counted toward a campaign's limit (P4-LIMITS-03). Not partitioned
(one row per campaign). Columns `campaign_id` (primary key), `station_id`,
`counted_engagement_count integer NOT NULL DEFAULT 0` with `campaign_counters_counted_engagement_count_check`
(0 or more), `created_at`, `updated_at` with the shared `set_updated_at` trigger
(`campaign_counters_set_updated_at`). Composite key `(campaign_id, station_id)` to `app.campaigns`;
index on `station_id`.

**`app.recognition_reports`** — only if "Report this" is approved (Q6, P4-D28). Not partitioned (low
volume). Columns `id` (`gen_random_uuid()`), `recognition_id`, `recognition_received_at`,
`station_id`, `reason` (check: the four reasons), `listener_install_hash` (text NOT NULL, check: 22
characters), `received_at`, `request_id`, `created_at`. Unique `recognition_reports_recognition_id_unique`
on `recognition_id` (*renamed after review* to the `<table>_<columns>_unique` rule); indexes on
`(station_id, received_at)` and `(listener_install_hash, received_at)`. *Amended after review:*
`listener_install_hash` is the API's keyed hash of the install (`DerivedKeys.hashIdentifier`, the same
value the logs carry as `actor`, P4-D26), never the install id. Only `lookup_admin_api` can read the
table, so super admins can tell 500 "scam" reports from one phone from 500 listeners, also after old
months of recognitions are detached; no station ever sees it. No foreign key to `recognition_events`,
so detaching an old month of events is never blocked by a report kept for moderation; the function of
§4.4 checks the recognition instead.

### 4.3 Time windows with grace

Grace widens **each time window on both sides**, and never the campaign's active period (P4-D3, Q1).
A clip heard at local moment *m* is on air when some slot of the window, `[slot_start, slot_end)`,
satisfies `slot_start − grace ≤ m < slot_end + grace`. With a grace of 0 this is exactly the rule of
`app.is_time_window_open`, which the portal's "Live now" badge keeps using.

- `app.list_time_window_slots(days_of_week smallint[], local_start_time time, local_end_time time,
  local_from timestamp, local_to timestamp) RETURNS TABLE (slot_start timestamp, slot_end timestamp)`.
  `IMMUTABLE`, not a definer function, no grant. Every slot of one weekly window that starts on a day
  from the day before `local_from` to the day of `local_to`; an overnight slot ends the next day and
  belongs to the day it starts (as today).
- `app.is_time_window_open_with_grace(days_of_week, local_start_time, local_end_time,
  local_moment timestamp, grace interval) RETURNS boolean`. `IMMUTABLE`, no grant. Uses the slots
  from `local_moment − grace` to `local_moment + grace`. Grace is at most 60 minutes (§4.1), so this
  look-around is always wide enough.
- Times are compared in the station's local wall-clock time, as today. Zambia has no daylight saving;
  a station elsewhere could be an hour out on the night the clocks change (gap 22, recorded in
  ADR-003).

### 4.4 Functions the API calls

All in the `recognition` schema unless named otherwise; `EXECUTE` for `lookup_api` only.

| Function | What it does | Replaces |
|---|---|---|
| `claim_recognition(claiming_listener_install_id, claimed_idempotency_key, new_recognition_id, request_id, effective_captured_at, client_captured_at, clock_skew_milliseconds bigint, received_at, is_deferred, clip_duration_milliseconds)` returns `recognition_id, recognition_received_at, recognition_captured_at, attempt_number, claim_outcome, previous_outcome, is_deferred` | *Added after review* (P4-D2). The Step 3 body, unchanged in what it decides, with three differences: the skew is `bigint`, so it is always stored exactly (P4-D18); a re-claim stores `is_deferred = stored OR new`, so a clip that went Busy live and was then sent from the outbox is stored and answered as deferred (contract §1.2: "the `is_deferred` that is stored and answered is the computed one"); and it returns the stored capture time and `is_deferred`, so a retry is resolved at the same capture moment as the first attempt. The first `received_at` and `captured_at` are kept, as before. | the Step 3 `claim_recognition` (dropped; `clip-checks.ts` loses `LARGEST_STORED_SKEW_MILLISECONDS`) |
| `find_station_candidates(matched_audio_asset_number integer, effective_captured_at timestamptz)` returns `station_id, station_name, station_frequency_label, station_city, ad_title, client_name, campaign_id, campaign_period_started_at, is_campaign_active, campaign_action_card_id, campaign_card, client_default_action_card_id, client_default_card, is_in_window, matched_slot_started_at, last_slot_ended_at, is_at_engagement_limit` | One row per campaign that makes its station an owner (P4-D4): ACTIVE station, non-archived ad on the asset, campaign ACTIVE, or PAUSED or ENDED with `status_changed_at` after the capture (`is_campaign_active` false). `is_in_window`: the period contains the capture moment and a window (± grace) does. `matched_slot_started_at`: the start of the latest slot that contains it. `last_slot_ended_at`: the end of the latest slot that ended at or before the capture, started inside the period, within 7 days. `campaign_period_started_at`: the lower bound of the period, for folding a station's campaigns (§5.1, step 1). `is_at_engagement_limit`: a yes or no, never the limit or the count. Status, card version and limit are read now, when the clip is processed (P4-D5). Stations are not filtered by `is_listed_in_app` (Correction 3). | `find_stations_for_audio` (dropped) |
| `finish_recognition(finished_recognition_id, recognition_received_at, finished_attempt_number, final_outcome, fallback_reason, matched_audio_asset_number, resolved_station_id, resolved_campaign_id, shown_action_card_id, resolution, hinted_station_id, weighed_candidates jsonb, aligned_hash_count, match_margin, match_offset_milliseconds, latency_milliseconds, fingerprint_version)` returns boolean | As in Step 3 (only the attempt still PENDING changes), plus: checks the resolution against the outcome; stores the hint only when that station exists (P4-D9); writes one candidate row per entry of `weighed_candidates` (`station_id, campaign_id, action_card_id, card_kind, is_in_window, display_position`), checking each station, campaign and card belong together and the display positions run 1..n. *Amended after review:* the API passes every station that can show a card (*S* in §5.1), whatever the outcome (P4-D8). All in one transaction. | the Step 3 `finish_recognition` (dropped) |
| `describe_recognition_for_replay(described_recognition_id, recognition_received_at, asking_listener_install_id)` returns `outcome, is_deferred, captured_at, display_position, card_kind, station_id, station_name, station_frequency_label, station_city, is_station_active, client_name, ad_title, action_card` | For the install that made it only: one row for a MATCH, one row per shown candidate in display order for a CHOOSE_STATION (before or after a choice), one row without a station otherwise. `is_station_active` lets the API withhold a station suspended since (P4-D13). | `describe_recognition` (dropped) |
| `count_recognition_attempts(asking_listener_install_id uuid, asked_idempotency_key uuid)` returns integer | The attempt count of a key this install already holds, or NULL for an unknown key and for another install's key. Used when the text fields arrive, before the audio is read (§5.2): a held key under 5 attempts is counted against the replay allowance instead of the live or deferred one (P4-D14). | — |
| `record_station_choice(chosen_recognition_id uuid, choosing_listener_install_id uuid, chosen_station_id uuid)` returns text | Finds the recognition by id within its receipt bounds (below), locks its row (`FOR UPDATE`), and answers `CHOSEN`, `ALREADY_CHOSEN`, `NOT_FOUND` (unknown, another install's, not a chooser), `NOT_A_CANDIDATE` (not a shown candidate) or `ANOTHER_STATION_CHOSEN`. On `CHOSEN`: the candidate's `is_chosen` and `chosen_at`; the event's `resolution = LISTENER_CHOICE` and its station, campaign and card from the candidate. Moves no counter. The choosing steps are one internal routine, `recognition.record_choice_on_locked_recognition` (no grant), which `record_engagement` calls too (A4). | — |
| `list_stations_for_listeners(maximum_count integer)` returns `station_id, station_name, station_frequency_label, station_city` | ACTIVE stations with `is_listed_in_app`, ordered by `lower(name) COLLATE "C"`, then `frequency_label`, then `id`, at most `maximum_count` (the API passes 1,000). | — |
| `record_engagement(new_engagement_id, engaged_recognition_id, engaging_listener_install_id, engaged_station_id, tapped_action_id, corrected_occurred_at, client_occurred_at, clock_skew_milliseconds, received_at, request_id, maximum_counted_taps_per_install integer)` returns text | §5.8. Answers `RECORDED`, `ALREADY_RECORDED`, `NOT_FOUND`, `NOT_A_CANDIDATE`, `ANOTHER_STATION_CHOSEN` or `ACTION_NOT_ON_CARD`. *Amended after review:* a tap on a chooser with no choice yet records that station as the choice, under the same row lock (A4); the last parameter is the per-install cap of P4-D10 (NULL: no cap). Whether the tap was counted is in the row, never in the answer. | — |
| `record_recognition_report(reported_recognition_id, reporting_listener_install_id, reporting_listener_install_hash, reported_station_id, reason, received_at, request_id)` returns text (if approved) | Same validity as a tap without the action (it never records a choice); one per recognition; answers `RECORDED`, `ALREADY_RECORDED`, `NOT_FOUND`, `NOT_A_CANDIDATE` or `ANOTHER_STATION_CHOSEN`. Stores the hash, never the install id (P4-D28). | — |
| `delete_expired_recognition_idempotency_keys(older_than interval, maximum_count integer)` returns integer | Deletes up to `maximum_count` keys created more than `older_than` ago, oldest first; refuses `older_than` under 25 hours, so a key a phone may still retry is never deleted (P4-IDEMPOTENCY-19). | — |
| `app.create_listener_traffic_partitions(months_ahead integer)` returns integer | Creates the missing monthly partitions of `recognition_events`, `recognition_candidates` and `engagement_events`, from a fixed list inside the function (never a table name from the caller). | `app.create_recognition_event_partitions` (dropped) |

**Finding a recognition by id** (*amended after review*, P4-D32). The API makes the UUID version 7 id
after the clip has been read, so `received_at` lies between the id's own time minus the body-read
limit and the id's time. Two internal `IMMUTABLE` helpers (no grant) read the id's 48-bit millisecond
time and do the arithmetic in milliseconds before converting, so they stay truly immutable:
`recognition.compute_earliest_receipt_time(uuid)` gives the id time minus 5 minutes and
`recognition.compute_latest_receipt_time(uuid)` the id time plus 1 minute. The choice, engagement and
report functions look the event up with
`id = $1 AND received_at >= recognition.compute_earliest_receipt_time($1) AND received_at <= recognition.compute_latest_receipt_time($1)`.
Partition pruning on PostgreSQL 16 works only with the partition key's ordering operators (`=`, `<`,
`<=`, `>=`, `>`), never with a range test such as `<@`, so this form reads one or two monthly
partitions and the earlier `<@ tstzrange` form would have read them all. A database test checks the
plan (`EXPLAIN`): a lookup touches at most two partitions. A route test pins the assumption: for every
recognition it makes, `received_at` is at most 60 seconds before the id's time and never after it.

**The counter statement** (P4-LIMITS-04). One atomic statement; the limit sits in its `WHERE`, so two
taps can never both pass a full limit:

```sql
INSERT INTO app.campaign_counters AS counter (campaign_id, station_id, counted_engagement_count)
VALUES (tapped_campaign_id, tapped_station_id, 1)
ON CONFLICT (campaign_id) DO UPDATE
   SET counted_engagement_count = counter.counted_engagement_count + 1
 WHERE campaign_engagement_limit IS NULL OR counter.counted_engagement_count < campaign_engagement_limit
RETURNING counter.counted_engagement_count;
```

A returned row means the tap was counted. A limit is always above zero (the Foundation check), so the
first insert is always within it. The limit is read in the same function, inside the same
transaction. This is the plan's "`UPDATE … RETURNING` with the limit in its WHERE clause", written as
an upsert because the API role cannot create counter rows when campaigns are made.

### 4.5 Row-level security and grants

| Table | Row-level security policies | `lookup_api` | `lookup_admin_api` |
|---|---|---|---|
| `recognition_candidates` | `recognition_candidates_visible_to_station` (SELECT, `station_id = app.current_station_id()`); `recognition_candidates_admin_full_access` | SELECT | SELECT |
| `engagement_events` | `engagement_events_visible_to_station`; `engagement_events_admin_full_access` | SELECT | SELECT |
| `campaign_counters` | `campaign_counters_visible_to_station`; `campaign_counters_admin_full_access` | SELECT | SELECT |
| `engagement_deduplication_keys` | none (on the "deliberately no policy" list) | nothing | nothing |
| `recognition_reports` (if approved) | `recognition_reports_admin_full_access` only | nothing | SELECT |
| `recognition_events` (existing) | unchanged | *Amended after review:* the table-wide `SELECT` is revoked and replaced by `SELECT` on every column except `listener_install_id`, `hinted_station_id`, `idempotency_key`, `client_captured_at` and `clock_skew_milliseconds` (P4-D30) | SELECT (unchanged) |

- **Why those five columns** (P4-D30). The install id names the listener. The hint is the listener's
  "My station", which, when it was ignored, is another station's id: a listening habit and a
  competitor's information. The idempotency key is the phone's own value. The phone's own capture time
  and the clock skew together are a fingerprint of one phone's clock, which would let a station link
  one listener's recognitions. A station needs none of them; P7 may grant a column in its own
  migration if a screen needs it. Every station query still works: no API code reads the table
  directly (only the definer functions, which run as the owner, and the partition helper), and the
  isolation tests read only `id`, `station_id` and constants. `SELECT *` as `lookup_api` is refused
  from now on, which is intended.
- Every write goes through the definer functions of §4.4. `INSERT`, `UPDATE` and `DELETE` are refused
  to `lookup_api` on all five tables (P4-DATABASE-02: the nine writes on the first three, plus the two
  other tables).
- A station sees only its own candidate rows, so it cannot tell which other stations were offered for
  the same recognition (P4-RESOLUTION-13). A chooser's event row has no station until a choice, so no
  station sees it; after the choice only the chosen station does (P4-CHOICE-06).
- Partitions are reachable only through their parent and its policies (ALL-SCALING-07).
- `lookup_fingerprint_worker` gets nothing new.

### 4.6 Partitions and clean-up

- **Partitions.** `recognition_candidates` and `engagement_events` get a default partition and the
  current month plus three ahead, created by `app.create_listener_traffic_partitions(3)` in the
  migration and topped up daily (§5.12). Old months are detached whole by the schema owner, never
  deleted row by row (ALL-SCALING-01). *Amended after review:*
  - Engagements have no foreign key to `recognition_events` (A8), so a month of engagements and a
    month of events are detached each on their own. A tap in month N+1 on a recognition of month N
    never blocks detaching events month N.
  - Candidates reference `recognition_events` and share its month. PostgreSQL keeps that foreign key
    on a detached partition as a constraint of its own, so the order is: detach candidates month N;
    archive it and drop it, or drop its foreign key; then detach events month N.
  - The runbook note goes into ADR-003, and `database-scaling.test.ts` runs exactly these steps with a
    tap in engagement month N+1 that names a recognition of month N.
- **Engagement keys** are removed together with their recognition's month: when a month of
  `recognition_events` is detached, the keys whose `recognition_received_at` falls in it are deleted
  in the same maintenance step. A key therefore lives exactly as long as a tap on that recognition can
  be accepted (P4-D11). No retention for recognitions is decided yet (gap 37), so nothing is detached
  in P4; Q13 proposes deciding it in P8 with O7 and the data-protection review (P4-D37).
- **Recognition idempotency keys** are cleaned up daily after 48 hours (§5.12; P4-D19).

### 4.7 What the down step restores

It drops everything above in reverse order, restores `app.create_recognition_event_partitions`,
`find_stations_for_audio`, the Step 3 `claim_recognition` (integer skew), `finish_recognition` and
`describe_recognition` with their Step 3 bodies and grants, restores the table-wide `SELECT` on
`recognition_events` for `lookup_api`, turns `clock_skew_milliseconds` back into an integer (values
beyond the integer range become NULL), and drops the new checks, the trigger and the columns.
`database:revert-latest` followed by `database:migrate` is part of the migration's test.

---

## 5. The API

### 5.1 Station resolution (`features/recognition/resolve-station.ts`)

`resolveStation(rows, stationHint)` is a pure TypeScript function over the rows of
`find_station_candidates`. It replaces `choose-station.ts` and is tested without a database, table by
table (P4-RESOLUTION-01). The rules run in the plan's order: **candidates, then the schedule, then the
hint, then limits** (P4-D6).

**Step 1 — one candidate per station.** A station may have several campaigns on the same recording
(the seed's Station A does, for two clients). *Amended after review:* its candidate is, in this order:
1. the campaign in window whose slot started last;
2. if none is in window, the campaign whose slot ended last (`last_slot_ended_at`, within 7 days);
3. if none has a slot in those 7 days, the campaign with the latest period start that is not after
   the capture;
4. if every period starts after the capture, the one that starts first;
5. then the campaign id.

*Built as (Piece 2):* each rule breaks the ties of the one before, so two campaigns on air in slots that started
together fall to the slot that ended last, then the latest period start, then the id.

So a campaign that has not started yet never stands in for one that has been on air: the seed's
"Weekend sale" (Brand B, starting in 3 days) can no longer put Brand B's default card on a clip of
Brand A's "Summer service offer". The order also matches how stations are ordered (the slot that
started last, then the slot that ended last).

**Step 2 — each candidate's card.** Limits and the processing-time status decide only *which card* a
station shows, never which station answers:

| The station's campaign | Card shown | Kind |
|---|---|---|
| in window, ACTIVE now, not at its tap limit, has a card | the campaign's card | `CAMPAIGN` |
| in window, but at its limit, or paused or ended after the capture (O13), or without a card | the client's default card, if any | `CLIENT_DEFAULT` |
| not in window | the client's default card, if any | `CLIENT_DEFAULT` |
| any of the above with no card to show | none: the station is not offered | — |

A station that cannot show any card is treated as if it did not own the ad (gap 25). This is the only
way a limit can change who answers.

**Step 3 — decide.** Let *S* be the stations with a card and *W* those of them in window.

| Case | Answer | Stored outcome | Resolution | Candidate rows written |
|---|---|---|---|---|
| *S* is empty, no owner at all | `NO_MATCH` | `NO_MATCH`, fallback reason `no_station_airs_it` | NULL | none |
| *S* is empty, owners exist | `NO_MATCH` | `NO_MATCH`, `no_card_to_show` | NULL | none |
| exactly one station in *S* | `MATCH` with its card | `MATCH` or `MATCH_DEFAULT` | `SINGLE_OWNER` | that station, no display position |
| *S* has several, exactly one in *W* | `MATCH` | `MATCH` or `MATCH_DEFAULT` | `SCHEDULE_UNIQUE` | every station of *S*, no display position |
| *W* has several, the hint is one of them | `MATCH` with the hinted station's card | `MATCH` or `MATCH_DEFAULT` | `HINT` | every station of *S*, no display position |
| *W* has several, no hint or a hint outside *W* | `CHOOSE_STATION`, the first 4 of *W* by the slot that started last, then `lower(name)`, then id | `CHOOSE_STATION` | `UNRESOLVED` | every station of *S*; the shown ones with positions 1–4 |
| *W* is empty, the hint is in *S* | `MATCH` with the hinted station's default card | `MATCH_DEFAULT` | `HINT` | every station of *S*, no display position |
| *W* is empty, *S* has several, no usable hint | `CHOOSE_STATION` of default cards, the first 4 by the slot that ended last (none in 7 days: last), then `lower(name)`, then id | `CHOOSE_STATION` | `UNRESOLVED` | every station of *S*; the shown ones with positions 1–4 |

*Amended after review* (P4-D8): the last column now writes a row for every station of *S*, whatever
the outcome, each with the card it would show and whether it was in window. P4-RESOLUTION-12 asks for
"one row per candidate station", and P7's "possible" counts need the owners that were weighed but did
not answer. The cost is one small row per station that could answer, in the same transaction.

- "Exactly one station in *S*" is `SINGLE_OWNER` even when other stations own the ad but have no card
  to show; the fallback reason then says `other_owners_have_no_card` (gap 27). *Built as (Piece 2):* any other
  `MATCH_DEFAULT` stores why the usual card was shown as its fallback reason: `not_on_air`, `campaign_not_active`
  (paused or ended after the capture), `campaign_at_tap_limit` or `campaign_has_no_card`.
- When stations are in window, owners out of window are never offered: the listener most likely
  heard one of the stations on air.
- The hint is used only when it names a station of *W* (on air) or, with none on air, of *S*, whether
  that station is listed in the app or not (Correction 3). Any other hint is ignored silently
  (P4-RESOLUTION-08, P4-FALLBACK-01, P4-D9).
- The server never guesses between stations on air: without a usable hint it always asks
  (P4-RESOLUTION-09).

**Receipt-time facts** (P4-D5). Station status, campaign status, the tap limit and the card version
are read when the clip is processed. On a re-claim they are read at the retry; the first `received_at`
and the first corrected `captured_at` are kept, and the retry is resolved at that same capture moment
(P4-D2). Nothing keeps a history of statuses or of which card version was current when, and building
one is not worth it for a retry that comes seconds or hours later. *Amended after review:* this
differs from P4-IDEMPOTENCY-16's own words ("so limits, statuses and card version are still judged at
the first receipt time"), so the item is not ticked on the `received_at` assertion alone: Q9 asks the
user to accept the reworded item, or to have the history built.

### 5.2 The recognize route: order of checks and the reader

The order of S3-D14 changes in three places: the update gate after the token, and, *amended after
review*, both the places in flight and the per-install allowance after the text fields (P4-D14,
P4-D15).

1. Request id (middleware).
2. The listener per-address ceiling, 600 a minute (middleware).
3. The cross-site check (middleware): 403 for a request that carries a cookie from a foreign origin.
   The app never sends a cookie, so it never meets this.
4. The install token (401) and the update gate (426), in `InstallTokenGuard` (§5.7).
5. The recognize per-address limit, 300 a minute (429).
6. The body starts: not multipart (415); declared length too large (413).
7. **The text fields arrive.** When the audio part begins, `readRecognizeRequest` calls the
   controller's `beforeReadingAudio(fields)` and reads no audio until it returns. The audio stream
   simply waits (backpressure); the 20-second read limit keeps running. In this order:
   - **The places in flight.** Every request takes one of the instance's
     `RECOGNITIONS_IN_FLIGHT_LIMIT` places (32); a request whose `is_deferred` field is `"true"` must
     also find one of the `RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT` places (16). Past either: 503
     `RECOGNITION_BUSY` with the `Retry-After` the field names (live 10; deferred a new random 60–300).
     A refusal here is the server's load, not the listener's doing, so it is never counted against
     the listener's allowance. Deferred sends can therefore hold at most 16 of the 32 places, and
     live clips always find the rest (P4-DEFERRED-05).
   - **All required fields present and valid:** if this install already holds the key with fewer than
     5 attempts (`count_recognition_attempts`), the request is counted against the **replay
     allowance**, `RECOGNITION_REPLAYS_PER_INSTALL_PER_HOUR` (60), and not against the live or
     deferred bucket (contract §1.2). Otherwise one request is counted against the bucket the
     `is_deferred` field names: live (6 a minute, 60 a day) or deferred (10 an hour). Past either:
     429 with the seconds left in that window (P4-DEFERRED-03, -04).
   - **Present but invalid:** a live place; one request is counted against the live bucket (429 when
     that is spent), then 400 `VALIDATION_FAILED` with the contract's issues.
   - **A required field missing:** a live place; one request is counted against the live bucket, the
     audio is read, and the decision waits for the end of the body. If the missing field arrives after
     the audio, the answer is 400 with `{path: "audio", code: "audio_part_before_fields"}`; if it
     never arrives, 400 with the contract's issues. A text part after the audio part always gives
     `audio_part_before_fields`.
   - **No audio part at all:** counted against the live bucket; 400 `{path: "audio", code: "invalid_type"}` as today.
8. The audio part (413 past 256 KiB; 400 past 20 seconds).
9. The first bytes (415). 10. The capture time (422). 11. The claim (409 or replay).
12. Admission (503, §5.3). 13. The job and the wait (503 on timeout). 14. Resolution (§5.1).
15. Finishing (§4.4). 16. The answer (§5.4).

**Why the places in flight moved after the fields** (P4-D15, found in review). Before the fields
arrive the server cannot know whether a send is deferred, so an in-flight refusal there could only
carry the live 10 seconds (no jitter for a crowd of phones whose tower has just come back), and a
burst of deferred sends could take every place before their fields were read. The places still bound
the clips held in memory: no audio is read before a place is taken. A request waiting for its fields
holds only a connection and a few bytes, bounded by the server's existing timeouts (20 seconds for
the headers, 60 seconds for the whole request), the 20-second body-read limit and the per-address
limits.

**Replays** (*amended after review*, P4-D14). A replay of a finished key never claims, so its attempt
count never grows and the "fewer than 5 attempts" rule alone would never stop it. Every send of a held
key is therefore counted against the replay allowance of 60 an hour: generous for the outbox's real
resends after a lost answer, a 409 or a 503, and a bound on one install replaying a finished key for
ever. Replays also pass steps 1–7, so they stay bounded by the address limits and the places in
flight. A held key stops being exempt from the live and deferred buckets at its fifth attempt.

### 5.3 Admission, priority and waiting

Every value is chosen by the `is_deferred` **field as sent**, never by the computed flag (P4-D14).

| | Live (`"false"`) | Deferred (`"true"`) |
|---|---|---|
| Places in flight per instance | any of `RECOGNITIONS_IN_FLIGHT_LIMIT` (32) | one of `RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT` (16), inside the 32 |
| Queue depth refused at | `RECOGNITION_QUEUE_DEPTH_LIMIT` (50) | `RECOGNITION_DEFERRED_QUEUE_DEPTH_LIMIT` (20) |
| Circuit breaker | the live breaker | its own deferred breaker; refused also while the live one is open |
| `Retry-After` on any 503 (every 503 now comes after the fields) | 10 (busy) or 5 (timeout) | a new random whole number from 60 to 300 on every answer (`crypto.randomInt`) |
| BullMQ priority | none (the plain waiting list) | `10` (the prioritised set) |
| Job deadline and wait | 2,500 ms | 5,000 ms |

- The depth read once a second becomes `getJobCounts('waiting', 'prioritized')`, summed (fact 9).
- BullMQ takes plain waiting jobs before prioritised ones, so a waiting live job always goes first.
  The Python worker (`bullmq` 3.3.0) moves jobs with the same Valkey scripts, so it needs no change;
  a test with the real worker proves it (§6.4).
- `recognizeQueue.addAndWait(jobId, data, {waitMilliseconds, priority})`; both breakers keep
  `timeout: false`, so a 5-second wait is never cut short.
- **Two breakers** (*amended after review*, P4-D15). `recognition-breaker.ts` makes two breakers with
  the same settings: one for live sends and one for deferred sends. Deferred jobs wait at a lower
  priority with a 5-second deadline, so under load they time out by design; in one shared breaker
  those timeouts would open it and refuse live clips. They cannot simply be filtered out either: in
  `opossum` 10.0.0 a filtered error counts as a success (and closes a half-open breaker), which would
  hide real live failures. With two breakers:
  - live admission looks at the live breaker only, so deferred timeouts never refuse a live clip;
  - deferred admission refuses while either breaker is open, because a live failure means the
    workers are in trouble for everyone;
  - both keep counting worker and queue failures, and neither counts `INVALID_AUDIO`.
- The heartbeat check is unchanged. The in-flight check moves to the moment the fields arrive and
  gains the deferred share (§5.2). P4-ADMISSION-01's evidence is re-run against the new order.
- A refusal at admission happens after the claim, so the key is held as `BUSY` and the resend is
  counted against the replay allowance, not the listener's own (§5.2).

### 5.4 Answers and replays

- `respond()` builds all three statuses. Every station in an answer is a `ListenerStation` with its
  city; logos stay `null` until stations can upload them (S3-D21). Every answer is still checked
  against the shared contract before it leaves, so a chooser can never carry five candidates or the
  same station twice.
- **A replay** reads `describe_recognition_for_replay` (P4-D13):
  - `MATCH` / `MATCH_DEFAULT`: the same id, status and card version; if the station is no longer
    ACTIVE, `NO_MATCH` with the same id.
  - `CHOOSE_STATION`: the same candidates, cards and order, also after a choice, minus stations no
    longer ACTIVE; one left gives a `MATCH` with its stored card and kind; none left gives `NO_MATCH`.
  - `NO_MATCH`, `AMBIGUOUS`: `NO_MATCH`. `INVALID_AUDIO`: 400 `INVALID_AUDIO` again.
  - The `is_deferred` and `captured_at` answered are the stored ones.
- A replay creates no job and changes no row or counter.

### 5.5 The station choice route

`features/recognition/station-choice.controller.ts`: `POST recognitions/:recognitionId/choice`,
`@PublicRoute()` plus `InstallTokenGuard` (token, then the update gate), then the follow-up allowance
(§5.11), then the path check (a UUID version 7, else 400 `{path: "recognition_id", code: "invalid_format"}`),
then the body against `RecognitionStationChoiceInput`, then `record_station_choice`.

| Function answer | HTTP |
|---|---|
| `CHOSEN`, `ALREADY_CHOSEN` | 204, no body |
| `NOT_FOUND` | 404 `NOT_FOUND` (an unknown id, another install's, and a recognition that is not a chooser look the same) |
| `NOT_A_CANDIDATE` | 422 `STATION_NOT_A_CANDIDATE`; nothing changes |
| `ANOTHER_STATION_CHOSEN` | 422 `STATION_ALREADY_CHOSEN`; nothing changes |

- No time limit while the recognition exists; no cancel request. A chosen station that was suspended
  since is still recorded: the choice is a record of what the listener saw, and nothing is shown.
- No counter moves. Taps come separately (§5.8).
- *Amended after review* (A4): a tap on a chooser with no choice yet also records the choice, through
  the same internal routine and under the same row lock. A choice of another station after that gets
  422 `STATION_ALREADY_CHOSEN`, exactly as after a choice sent through this route.

### 5.6 The station list route

`features/listener-stations/`: `GET stations`, `@PublicRoute()` plus `InstallTokenGuard`, then
`STATION_LIST_REQUESTS_PER_INSTALL_PER_HOUR` (20), then `list_stations_for_listeners(1000)`.

- The body is `ListenerStationList`, checked against the contract before it leaves.
- The strong `ETag` is `"` + the first 27 characters of the base64url SHA-256 of the body + `"`. The
  controller compares `If-None-Match` itself (any of its listed tags, exactly) and answers 304 with no
  body; it does not rely on Express's own weak ETags.
- `Cache-Control: private, max-age=86400` replaces the global `no-store` on this route only (P4-D17).
  `private` keeps the list out of shared caches; its content is public anyway. A test checks that every
  other listener route still says `no-store`.
- A portal cookie opens nothing here; the portal's `GET /stations/:stationId` is a different route.

### 5.7 The update gate (426)

`InstallTokenGuard` already reads the install row on every listener request. It now reads
`app_version` with `status`, and refuses with 426 `APP_UPDATE_REQUIRED` when
`isBelowMinimumAppVersion(app_version, LISTENER_MINIMUM_APP_VERSION)`. The message is the catalogue's
"Please update the app." `/installs` and `/client-errors` do not use the guard, so they never answer
426. Registration records the new version, so an updated app clears the gate at once (P4-D16).

*Added after review* — the guard also puts a keyed hash of the install on every log line of the
request as `actor` (`DerivedKeys.hashIdentifier`, as `SignedInGuard` does for portal users), so every
error line of a listener route carries the hashed actor that ALL-LOGGING-01 requires, and never the
raw id (P4-D26).

**Registering again after an update** (*added after review*, A3, P4-D31). Every phone registers
again when its app version changes, so after a release many phones behind one carrier address do so
within the hour. `POST /installs` therefore looks at an `Authorization: Bearer` header when one is
sent:
- a token that verifies, for an ACTIVE install whose `install_id_hash` matches the `install_id` in
  the body, makes the request a **re-registration**: it is counted against
  `LISTENER_REREGISTRATIONS_PER_INSTALL_PER_DAY` (5), keyed by the install, and not against
  `LISTENER_REGISTRATIONS_PER_CLIENT_ADDRESS_PER_HOUR`;
- anything else (no header, an expired or bad token, a token of another install) is a first
  registration, counted per address as today.

The header is never required, and the answer is the same in both cases. The order of checks is
unchanged apart from this choice of counter. `listener-install-reregistration.test.ts` holds A3's
three tests.

### 5.8 The engagements route and tap limits (gate part 2)

`features/engagements/` (P4-DELIVERY-02): `POST engagements`, the same guard, the follow-up
allowance, then the body against `RecordEngagementInput`.

1. The service makes a UUID version 7 for the tap, notes `receivedAt`, and corrects the phone's time:
   `corrected = occurred_at + (receivedAt − sent_at)`, the skew kept as milliseconds.
2. `record_engagement` then, in one transaction:
   - finds the recognition within its receipt bounds (§4.4), locks its row (`FOR UPDATE`, the same
     lock `record_station_choice` takes) and refuses `NOT_FOUND` for an unknown id, another install's
     recognition, or one that is not finished with a card (PENDING or transient). There is no foreign
     key to lean on (A8): this check is the one that keeps taps valid;
   - finds the card *as shown*: for `MATCH` or `MATCH_DEFAULT`, the event's station and card (another
     station: `NOT_A_CANDIDATE`); for `CHOOSE_STATION`, the named station's shown candidate row
     (`NOT_A_CANDIDATE` when it was not shown; a `NO_MATCH` has no shown station);
   - *amended after review* (A4): on a `CHOOSE_STATION` that is still `UNRESOLVED`, records the named
     station as the listener's choice, through the same internal routine as `record_station_choice`
     (`is_chosen`, `chosen_at`, `resolution = LISTENER_CHOICE`, the event's station, campaign and
     card). Once a choice exists, a tap naming **another** station answers `ANOTHER_STATION_CHOSEN`
     (422 `STATION_ALREADY_CHOSEN`) and stores nothing. One chooser answer can therefore never count
     taps for up to four stations;
   - finds `tapped_action_id` in that card's `actions` and takes its `type` (`ACTION_NOT_ON_CARD`
     otherwise);
   - clamps the time to `[recognition received_at, receivedAt]` (P4-ENGAGEMENTS-03, -04);
   - inserts the deduplication key; if it already exists, answers `ALREADY_RECORDED` and changes
     nothing;
   - for a `CAMPAIGN` card only: *added after review* (P4-D10, Q12), takes a transaction-scoped
     advisory lock for this install and campaign, and, when the install already has
     `maximum_counted_taps_per_install` counted taps on this campaign in the last 24 hours (found by
     joining the campaign's counted taps of those 24 hours to their recognitions'
     `listener_install_id`, inside the function; no install column is added), the tap is not
     counted; otherwise runs the counter statement of §4.4, and a returned row means counted;
   - inserts the engagement row with `is_counted`.
3. The route answers 204 for `RECORDED` and `ALREADY_RECORDED`, 404 and the three 422s otherwise
   (contract §1.5 and A4). It never says whether the tap counted (gap 31).

**When a limit bites** (P4-D10, Q2). The counter moves at the tap. When a recognition is processed,
`is_at_engagement_limit` is read, and a campaign at its limit shows the client's default card
(P4-LIMITS-05, P4-TIMERULE-04). A replay moves nothing (P4-IDEMPOTENCY-09, -20). Taps on a default
card are stored, never counted. A tap past the limit, or past the install's own cap, is stored with
`is_counted = false`.

**Tap farming, what remains** (*added after review*, P4-D10). Installs cost nothing to make, and one
install may identify about 300 times a day, so a competitor could try to use up a campaign's limit and
leave everyone with the default card. A4 stops one chooser answer from counting taps for several
stations. The per-install cap (Q12; recommended 5 counted taps per install, campaign and 24 hours)
stops one install from counting more than a few. What remains is many installs from many addresses,
which only a device-integrity check stops (Play Integrity, deferred to hardening). The security
baseline gets a row naming this risk as open until P8 (§5.13).

### 5.9 "Report this" (only if approved, Q6)

`features/recognition-reports/`: `POST recognitions/:recognitionId/report`, the same guard and
allowance, the body against `ReportRecognitionInput`, then `record_recognition_report`. One report
per recognition; a repeat, even with another reason, answers 204 and changes nothing. A report never
records a choice; a report naming another station than the chosen one gets 422
`STATION_ALREADY_CHOSEN`, as a tap does. Reports carry no listener identity apart from the keyed hash
of the install (P4-D28), and are read only by `lookup_admin_api` (the 5a console). Until then the
walkthrough shows them with the development script of §5.15.

### 5.10 A client's default card (portal route)

P4-FALLBACK-04 needs a way to set the card (P4-D20). `features/clients/`:
`PUT stations/:stationId/clients/:clientId/default-action-card` with `{actionCardId: uuid | null}`
(portal bodies are camelCase), schema `SetClientDefaultActionCardInput` beside the client schemas in
`packages/contracts`.
- Signed in, OWNER or MANAGER (ANALYST 403), the cross-site cookie check, row-level security in the
  station's context (another station's client answers 404).
- The card must be a version of this client's cards: otherwise 400 `VALIDATION_FAILED`
  `{path: "actionCardId", code: "card_not_of_this_client"}`.
- Answers 204. Writes the audit event `client_default_card_changed` with the previous and new card
  ids (no card content).
- The portal control is P5B-CLIENTS-02. Until then the seed sets default cards (§5.15).

### 5.11 Configuration

All validated at start-up (`config/app-config.ts`; P4-DEFERRED-10). The plan's example numbers are the
defaults until the P8 load test sets them (O14, P4-D22).

| Setting | Default | Rule |
|---|---|---|
| `LISTENER_MINIMUM_APP_VERSION` | `0.0.0` (gate off) | must parse with `compareListenerAppVersions` |
| `RECOGNITIONS_DEFERRED_PER_INSTALL_PER_HOUR` | 10 | 1–1,000 |
| `RECOGNITION_DEFERRED_QUEUE_DEPTH_LIMIT` | 20 | 1 to `RECOGNITION_QUEUE_DEPTH_LIMIT` |
| `RECOGNITION_DEFERRED_WAIT_MILLISECONDS` | 5,000 | at least `RECOGNITION_WAIT_MILLISECONDS`, at most 10,000 |
| `RECOGNITION_DEFERRED_RETRY_AFTER_MINIMUM_SECONDS` | 60 | 1–3,600 |
| `RECOGNITION_DEFERRED_RETRY_AFTER_MAXIMUM_SECONDS` | 300 | at least the minimum, at most 3,600 |
| `RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE` | 60 | 1–10,000; one bucket for choice, engagements and reports (`common/rate-limiting/listener-follow-up-limits.ts`) |
| `STATION_LIST_REQUESTS_PER_INSTALL_PER_HOUR` | 20 | 1–1,000 |
| `RECOGNITION_IDEMPOTENCY_KEY_CLEAN_UP_INTERVAL_SECONDS` | 86,400 | 0 switches the job off (tests) |
| `RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT` (*added after review*) | 16 | 1 to `RECOGNITIONS_IN_FLIGHT_LIMIT` − 1, so live clips always keep a place (P4-D15) |
| `RECOGNITION_REPLAYS_PER_INSTALL_PER_HOUR` (*added after review*) | 60 | 1–10,000; sends of a key the server already holds (P4-D14) |
| `LISTENER_REREGISTRATIONS_PER_INSTALL_PER_DAY` (*added after review*, A3) | 5 | 1–1,000 (P4-D31) |
| `ENGAGEMENTS_COUNTED_PER_INSTALL_PER_CAMPAIGN_PER_DAY` (*added after review*, Q12) | 5 | 0 switches the cap off; otherwise 1–1,000 (P4-D10). A setting, not a migration, so the user's answer to Q12 never needs a new migration |

The server's allowances are independent of each other: a deferred clip's 429 says nothing about the
follow-up allowance, and a shed clip says nothing about choices or taps. The app can therefore pause
each kind of item on its own (a point for the P6 design's sender).

### 5.12 Scheduled jobs

- `infrastructure/scheduled-jobs/run-job.ts` exports `runJob(name, work)`: a fresh request id per run,
  every log line of the run tagged with it and the job's name, errors caught and logged with the stack,
  and the next run still scheduled (ALL-JOBS-01, -02).
- `ListenerTrafficPartitions` (`infrastructure/database/listener-traffic-partitions.ts`, replacing
  `recognition-event-partitions.ts`) calls `app.create_listener_traffic_partitions(3)` at start-up and
  daily, through `runJob`.
- `RecognitionIdempotencyKeyCleanUp` (`features/recognition/recognition-idempotency-key-clean-up.ts`)
  runs daily through `runJob`: `delete_expired_recognition_idempotency_keys('48 hours', 1000)` in a loop
  until a call deletes fewer than 1,000 or 20 calls have run, logging the count. Captures older than
  24 hours are refused before the claim, so a deleted key can never be needed again (P4-IDEMPOTENCY-19).
- Several API instances running these at once is harmless: each step is idempotent.

### 5.13 Errors, logging and privacy

- **Errors.** Every refusal is a catalogue code in the one envelope, with the request id. Database
  failures on the new routes are caught as database errors first and answered as a generic 500; the
  real error and stack go to the log under the request id (ALL-ERRORS-01 to -05). The functions return
  outcome codes, so no route builds an answer from exception text.
- **Logging.** One info line per follow-up: route, request id, outcome code (for example
  `choice CHOSEN`). One info line per recognition: request id, recognition id, outcome, resolution,
  number of candidates, and `hasStationHint` (true or false). Every line of a listener route, the
  error lines included, carries `actor`: a keyed hash of the install, set by `InstallTokenGuard`
  (*added after review*, ALL-LOGGING-01, -03). Never logged: the install id, the token, the hint's
  value, card contents (they hold business phone numbers), action labels, and request bodies
  (ALL-LOGGING-02, -03; P4-D26). Before the `actor` field is added, the existing recognize and
  install log lines were checked: it is the only new field, a keyed hash, and no level gets louder,
  so no new personal data starts flowing (ALL-LOGGING-07).
- **Privacy.** No new table holds the install; the reports table holds only its keyed hash, for super
  admins. Stations see only their own candidates, engagements and counters, never another station's,
  never the listener (ALL-PRIVACY-01; gap 38). *Amended after review:* gap 38 is now answered in the
  database itself: the API role's column grants on `recognition_events` leave out the install, the
  hint, the idempotency key, the phone's capture time and the clock skew (P4-D30).
- **Security baseline rows** to add or change at the gates: the new tables in §1 (row-level security,
  writes only through definer functions); the listener follow-up routes in §2 and §3 (token, update
  gate, allowance, strict bodies, the cross-site check for cookie requests); "Only an ACTIVE station
  ever answers a listener" now names replays; the station list's private cache; logs never hold card
  contents or the hint, and listener lines carry the hashed install; "Report this" from Planned to
  Built if approved, with the install hash readable by super admins only. *Added after review:* the
  column grants on `recognition_events`; deferred sends' own breaker and share of the places in flight;
  the replay allowance; the re-registration allowance; and an open row, **tap farming by many
  installs**, until device integrity (Play Integrity) is checked in P8.

### 5.14 Files and modules

- `common/listener-authentication/install-token.guard.ts` (version gate; the hashed `actor`);
  `common/rate-limiting/` (`LISTENER_ROUTES` as a matcher; `listener-follow-up-limits.ts`);
  `common/validation/recognition-id.pipe.ts`; `common/errors/error-catalog.ts` (four codes).
- *Added after review:* `features/recognition/recognition-breaker.ts` (two breakers),
  `features/recognition/clip-checks.ts` (`LARGEST_STORED_SKEW_MILLISECONDS` removed; the skew is
  never NULL), `features/listener-installs/listener-installs.controller.ts` (re-registration, A3).
- `config/app-config.ts`; `infrastructure/scheduled-jobs/run-job.ts`;
  `infrastructure/database/listener-traffic-partitions.ts`; the migration and `all-migrations.ts`;
  `infrastructure/job-queues/recognize-queue.ts` (priority, depth).
- `features/recognition/`: `read-recognize-request.ts`, `recognition.controller.ts`,
  `recognition.service.ts`, `resolve-station.ts` (replaces `choose-station.ts`),
  `recognition-records.ts`, `recognition-answers.ts` (building answers and replays, moved out of the
  service), `station-choice.controller.ts`, `recognition-idempotency-key-clean-up.ts`.
- New feature folders, each imported once in `app.module.ts` (ALL-STRUCTURE-03):
  `features/listener-stations/` (Piece 3), `features/recognition-reports/` (Piece 4, if approved),
  `features/engagements/` (Piece 5). No feature imports another feature's folder; what they share is in the
  database functions and in `common/` (ALL-STRUCTURE-04).
- `features/clients/` (default-card route); `features/client-errors/` (`occurredAt` accepted and logged).
- `apps/portal`: the grace wording (Q1) in `schedule-step.tsx` and `plain-words/schedule-words.ts`.
- `services/fingerprinter`: no change.

### 5.15 Development seed and walkthrough scripts

- **Seed** (`scripts/seed-development-data.ts`, `sample-ads.ts`), by name, so a second run adds nothing:
  - Station B, "104.3 FM", city Kitwe, province Copperbelt, ACTIVE, listed, with the same owner as a
    member, so the owner can open both stations' pages; the seed prints both page addresses.
  - At Station B, the client "Brand A" and the ad "Summer service offer" with the same jingle, so it
    shares Station A's recording. Its campaign is a DRAFT with an all-day schedule, so the walkthrough
    publishes it in the portal.
  - Default cards for Brand A at both stations and for Brand B at Station A.
  - Sample numbers from `+447700900001` up (each card its own), and links on `https://example.com/`
    (Q7). The development data already holds cards with the old realistic numbers. Card versions are
    never edited, so the seed adds a new version of each such card with safe numbers and points its ad
    and campaign at it.
  - Every other sample ad gets its own jingle (different notes), so on a fresh database only "Summer
    service offer" is shared between the stations. The existing development data cannot be changed
    that way (only the worker links audio), so before Piece 2's walkthrough I end Station A's other
    sample campaigns on the shared jingle ("Harvest festival", "Weekend sale") with the script below.
    Otherwise one of them could answer instead of "Summer service offer" and confuse the walkthrough.
- **Development-only scripts** (`apps/api/scripts/`, P4-D25). Each refuses to run unless the setup
  database address points at this machine and `NODE_ENV` is not `production`, and prints plain words.
  None prints an install id, a token, card contents or a phone number.
  - `npm run development:set-station-status -- "Station B" SUSPENDED` (or `ACTIVE`).
  - `npm run development:set-campaign-status -- "Station B" "Summer service offer" PAUSED` (or `ACTIVE`, or `ENDED`
    for the shared-jingle campaigns below; a draft is published, and an ended campaign rescheduled, in the portal).
  - *Added after review:* `npm run development:reset-sample-schedule -- "Station A" "Summer service offer"`
    puts back the seed's schedule after a walkthrough changed it in the portal: every day, 00:00 to
    12:00 and 12:00 to 00:00 (the portal's "all day"), with the 10-minute grace.
  - *Added after review:* `npm run development:show-reports` prints the latest reports (if "Report
    this" is approved): time, station, reason, and the first 6 characters of the install hash, so two
    reports from one phone can be seen as such without printing the whole hash.
  - `npm run development:show-recognitions` prints the latest five recognitions, newest first, for
    example:

    ```
    14:32:05  heard 14:32:00, sent at once
              Asked "Which station?": 1. Station A (98.1 FM · Lusaka)  2. Station B (104.3 FM · Kitwe)
              Not chosen yet
    14:30:41  heard 14:30:36, sent at once
              Station A — Brand A, "Summer service offer", the campaign's buttons
              Decided by: the schedule (only Station A had it on air)
    ```

    From Piece 5 it adds taps ("Call — counted, 1 of 2") and reports.

### 5.16 Documents

- **ADR-003** (`docs/adr/ADR-003-shared-audio-and-station-resolution.md`, P4-DELIVERY-01): shared audio
  assets (D7), the resolution rules and values of §5.1, grace, the receipt-time facts, the chooser
  order, replays of suspended stations, the hint (unlisted stations included), limits at the tap, the
  candidates' partition column, engagements without a foreign key to events (A8), the detach runbook
  of §4.6, and the answers to §10.
- `docs/conventions.md`: the partition function's new name; the new tables as examples; *added after
  review:* the rule `<table>_<rule>_unique_index` for a partial unique index (P4-D34).
- `docs/security-baseline.md`: the rows of §5.13. The checklists: ticks with evidence at each gate.

---

## 6. Tests

### 6.1 Rules

- Every test can fail the build: no `|| true`, no swallowed exit code, no skipped suite (ALL-TESTS-01).
  New database tests fail, not skip, when the database is down (ALL-TESTS-02).
- Test data uses only `+447700900NNN` numbers and `https://example.com/` links. New tests build cards
  with a new helper in `test/support/listener-test-kit.ts`; the kit's old `CALL_CARD` waits for the
  sweep (Q7).
- No new test dependency. The property test uses a seeded generator written in the test (P4-D23).
- One file per behaviour (ALL-STRUCTURE-05). The API suites run against the compose Postgres and
  Valkey; route tests use the existing fake worker results (`match`, `noMatch`) unless real workers are
  named.

### 6.2 Database tests

| File | Proves |
|---|---|
| `time-windows-with-grace-database.test.ts` (table-driven) | Grace on both sides: 9 minutes before the start and after the end in, 11 minutes out (10-minute grace); a new campaign's grace is 10 minutes (P4-RESOLUTION-02, -03, P4-TESTS-04). Captured 5 minutes after the end and received 3 hours later: in; captured 3 hours after the end: out (P4-TIMERULE-02). Midnight: a window ending at 00:00:00 exactly, one starting at 00:00:00, an overnight window with grace across midnight (P4-TESTS-01). One case for each ISO day, Monday to Sunday, and a several-day window (P4-TESTS-02). Window start, end, one second before the start and one second after the end; the period's start and end, one second before and after, with an all-day window so the two are not confounded (P4-TESTS-03). Grace never widens the period. |
| `time-windows-property.test.ts` | 1,000 seeded cases per run (the seed is printed, and `LOOKUP_PROPERTY_SEED` repeats one): random days, start and end minutes (overnight included), grace 0, 5, 10, 20 or 60, and moments over three weeks. `app.is_time_window_open_with_grace` equals a plain TypeScript reference in every case, in one query; with grace 0 it also equals `app.is_time_window_open` (P4-TESTS-05). |
| `station-resolution-database.test.ts` | `find_station_candidates`: status filters; a campaign paused before the capture is not a candidate, one paused after it is, with `is_campaign_active` false (P4-TIMERULE-06); `status_changed_at` moves only when the status changes; the slot that started last and ended last; `is_at_engagement_limit`; the period in window with grace; every station that owns the audio with its card and default card (re-pointed evidence of P4-TIMERULE-03); an unlisted station is a candidate like any other (Correction 3); *added after review:* its returned columns equal the list of §4.4 (ALL-DATABASE-07). `finish_recognition`: each resolution stored, refused against the wrong outcome, an unknown value refused (P4-RESOLUTION-11); a two-station chooser writes two candidate rows with the right campaign, card and in-window values, neither chosen (P4-RESOLUTION-12); *added after review:* a single-owner match writes one row, and a schedule-unique match writes a row for each owner with a card, only the winner in window (P4-D8); a hint stored only for a station that exists, none without a hint (P4-RESOLUTION-10). `claim_recognition` (*recreated*): the second claim inserts no row (row counts, P4-IDEMPOTENCY-01); two claims at the same moment leave one row (P4-IDEMPOTENCY-04); a retry keeps the first `received_at` and `captured_at` and returns them (P4-IDEMPOTENCY-16, once Q9 is answered); a re-claim with `is_deferred` true on a row stored false stores true, and true is never turned back to false (P4-DEFERRED-01); `clock_skew_milliseconds` holds the exact skew of a phone 30 days off, beyond the old integer range (P4-CLOCK-04). *Added after review:* `count_recognition_attempts` gives NULL for an unknown key and for another install's key, and the attempt count otherwise (ALL-DATABASE-08). The migration's own test fills a finished `MATCH` and `MATCH_DEFAULT` row before migrating up and finds them with `SCHEDULE_UNIQUE` and `SINGLE_OWNER`, and a later `MATCH` without a resolution is refused (P4-D33). A lookup by recognition id reads at most two monthly partitions (`EXPLAIN`, P4-D32). A direct insert outside the capture-time bounds is refused by `recognition_events_captured_at_check` (P4-CLOCK-08). A limit of 0 is refused (P4-LIMITS-01). `record_station_choice`, `describe_recognition_for_replay`, `list_stations_for_listeners`, `record_engagement` and `record_recognition_report`: every answer code, `ANOTHER_STATION_CHOSEN` included; returned columns equal the documented list (ALL-DATABASE-07). An engagement retried with its recognition in month N and the retry in month N+1: one row, both succeed (P4-ENGAGEMENTS-12). *Added after review:* `record_engagement` on an `UNRESOLVED` chooser records the choice (A4); a report stores the install hash and never the install id. |
| `time-rule-split.test.ts` (P4-TIMERULE-08) | A named table, at the database and `resolveStation`: for each of the six facts, a case where the capture time and the receipt time give different answers — the window, the active period and the candidate set follow the capture time; the limit, the station's suspension and the card version follow the processing time. |
| `database-privileges.test.ts` (extended) | As `lookup_api` in a station's context: `INSERT`, `UPDATE`, `DELETE` refused on the five new tables; `SELECT` refused on the keys and reports tables; each new function runs, pins its search path and is executable only by `lookup_api` (P4-DATABASE-02; ALL-DATABASE-06, -08). *Added after review* (P4-D30; ALL-DATABASE-04): `SELECT` of `listener_install_id`, `hinted_station_id`, `idempotency_key`, `client_captured_at` or `clock_skew_milliseconds` from `recognition_events` is refused with "permission denied", one case per column, and so is `SELECT *`; `id`, `station_id`, `outcome`, `resolution` and `captured_at` stay readable; `lookup_admin_api` still reads every column, and only it reads `recognition_reports`. The internal helpers (`compute_earliest_receipt_time`, `compute_latest_receipt_time`, `record_choice_on_locked_recognition`) are executable by no service role. |
| `station-isolation.test.ts`, `station-isolation-matrix.test.ts` (extended) | Station A's context sees none of Station B's candidate, engagement or counter rows, and its own only; a candidate row cannot point at another station's campaign or card (composite keys); after a choice the chosen station sees the recognition and the other sees only its own unchosen candidate row (P4-DATABASE-01, P4-RESOLUTION-13, P4-CHOICE-06, P4-ENGAGEMENTS-11). |
| `database-scaling.test.ts` (extended) | `recognition_candidates` and `engagement_events` are range-partitioned by month on their arrival column, with current, future and default partitions; the API role cannot reach a partition directly; a month detaches whole in the order of §4.6 (P4-DATABASE-03, ALL-SCALING-07). *Added after review* (A8): with a tap in engagement month N+1 that names a recognition of month N, events month N is detached after candidates month N (detached, then its foreign key dropped) and the tap stays (ALL-SCALING-01). |
| `database-catalogue.test.ts` (extended) | Names follow the conventions; the new policies per role; `engagement_deduplication_keys` on the "deliberately no policy" list; every timestamp `timestamptz`; every foreign key indexed. *Added after review:* every index that does not back a constraint is named `<table>_<columns>_index`, or `<table>_<rule>_unique_index` when it is a partial unique index (ALL-DATABASE-NAMING-11, P4-D34); `engagement_events` has no foreign key to `recognition_events` (A8). |

### 6.3 Unit tests

| File | Proves |
|---|---|
| `station-resolution-rules.test.ts` | `resolveStation`, table-driven: one owner in and out of window; two owners, one in window; two in window with a matching hint, with no hint (a chooser with 2 cards), with a hint outside the set; none in window with a hint that owns it, with several owners (default cards, ordered by the last slot end), with one owner that has a default card; five in window give the first four by the last slot start; owners with no card left out; a chooser left with one gives a `MATCH`; a campaign at its limit or paused after the capture gives the default card; a station's two campaigns fold into one candidate; *added after review:* none in window, with a campaign of another client on the same recording that starts in 3 days: the fold keeps the campaign that was on air last, so the default card is the right client's; a hint naming an unlisted station that is on air gives a `MATCH` by `HINT` (Correction 3); each case's stored outcome, resolution, fallback reason and candidate rows (a row for every station of *S*). Each later rule applies only when the earlier ones leave a choice (P4-RESOLUTION-01, -04 to -09, P4-FALLBACK-01 to -03). |
| `recognition-rules.test.ts` (extended) | The clock correction with a phone 3 hours fast and with an exact clock (P4-CLOCK-01); the skew is never NULL now; the listener routes' matcher covers exactly the six listener routes; `comparisons.json` through `compareListenerAppVersions`. |
| `recognition-breakers.test.ts` (*added after review*) | Ten deferred sends that time out open the deferred breaker and leave the live breaker closed, with no failure counted; live admission is then unaffected, and deferred admission refuses. A live breaker that opens refuses deferred sends too. `INVALID_AUDIO` opens neither (P4-D15). |
| `run-job.test.ts` | A run's lines share one fresh id and the job name; a throwing job logs one error line with the stack and the next run still happens. |
| `startup-checks.test.ts` (extended) | Each new setting: refused out of range, refused when its rule against another fails, the default otherwise (P4-DEFERRED-10). |

### 6.4 Route tests (end to end on the compose stack)

| File | Proves |
|---|---|
| `recognize-station-resolution.test.ts` | Two owners with one in window: its card and `SCHEDULE_UNIQUE` (P4-RESOLUTION-05). Two in window with no hint: always `CHOOSE_STATION` with exactly two candidates and full cards, never a `MATCH` (P4-RESOLUTION-07, -09, P4-CHOOSER-04). Hint among them: `MATCH`, `HINT` (P4-RESOLUTION-06). Hint outside: chooser without it (-08). None in window: hint gives that owner's default card (P4-FALLBACK-01); no hint gives a chooser of default cards, the most recently aired first (P4-FALLBACK-02, -03). Five in window give four (P4-CHOOSER-02). Every answer passes the contract, and every station carries its city (P4-CHOOSER-03). A suspended station's card is never returned: single owner, schedule unique, hint, chooser, default card, a deferred clip, and a replay (P4-RESOLUTION-14). Captured while active, suspended, then sent: no card (P4-TIMERULE-05). Captured in window, campaign paused, then sent: the default card (P4-TIMERULE-06). Captured, card edited, then sent: the new buttons (P4-TIMERULE-07). A hint stored and read back, none without one (P4-RESOLUTION-10). |
| `recognize-replays.test.ts` | Table-driven replays of `MATCH`, `MATCH_DEFAULT`, `NO_MATCH`, `AMBIGUOUS`, `CHOOSE_STATION` (before and after a choice) and `INVALID_AUDIO` (400 again); a `BUSY` re-claim (P4-IDEMPOTENCY-11). A card edited between the send and the replay: the first version (-10). No job and no row change on any replay. *Added after review:* with a `campaign_counters` row seeded at 3 for the matched campaign, a recognition and its replay leave it at 3 (P4-IDEMPOTENCY-09, ticked in Piece 4 and re-run in Piece 5 with a real tap). |
| `recognize-deferred.test.ts` | The flag with a fresh capture time: `is_deferred` true in the answer and on the row (P4-DEFERRED-01). Flag false at 121 seconds: true; at 119: false; answer and row agree (-02). A clip heard 3 hours before it was sent keeps both times, about 3 hours apart (P4-TIMERULE-01). After 10 deferred sends the 11th new key gets 429 while a live send succeeds, and the reverse (-03, -04). A held key resent after a 503 is not counted. Depth between 20 and 50: deferred 503, live processed (-05). Fifty shed answers all within 60–300 and not all equal (-06). A silent worker: deferred answers after about 5 seconds, live after about 2.5 (-09). Changed settings change the behaviour (-10). A phone 3 hours slow matches the right window, stored within seconds of the true time (P4-CLOCK-01, -02). The same expired clip twice: 422 both times, no job (P4-CLOCK-07). Both exact bounds answer as the unit test says (-08). *Added after review:* a clip that went Busy as a live send and is then sent from the outbox is stored and answered with `is_deferred` true (P4-DEFERRED-01). With `RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT` at 2 and a worker that holds jobs, a third deferred send gets 503 with a `Retry-After` in [60, 300] while a live send is still admitted; with every place taken, a deferred send refused for lack of a place gets the deferred `Retry-After`, never 10 (P4-DEFERRED-05, -06; P4-D15). Twenty deferred sends with no worker consuming time out after about 5 seconds each; then a worker starts, and a live send gets 200: the live breaker never opened. A finished key replayed: the 61st send of held keys in an hour gets 429 with the seconds left, and the live bucket is untouched (P4-D14). A send refused for lack of a place is not counted against the listener's allowance. |
| `recognize-request-order.test.ts` | S3-REQUEST-13 re-run with the new order (§5.2 and Correction 1): each refusal before the next step, the update gate after the token, the places in flight and then the per-install count after the fields. An audio part before the fields: 400 `audio_part_before_fields`. A repeated key with an invalid body is refused without a replay; a finished key is replayed while admission refuses new work (P4-IDEMPOTENCY-02). Two sends of one key at the same moment: one job, one 200 and one 409 (-21). |
| `recognize-queue-priority.test.ts` | With no consumer running, a deferred job and then a live job are added; a consumer started afterwards takes the live job first (P4-DEFERRED-07). The deadline of a deferred job is 5,000 ms after it was added (-08). The depth counts prioritised jobs. |
| `fingerprint-workers.test.ts` (extended) | The same order with the real Python worker started after both jobs were added. |
| `station-choice-route.test.ts` | After a chooser, a candidate's id gives 204 (P4-CHOICE-01); the same twice gives 204 twice, one chosen row, no counter moved (-02); a non-candidate gives 422 and changes nothing (-03); `LISTENER_CHOICE` stored (-04); one chosen row (-05); the event's station, campaign and card are the candidate's (-06); no token or a bad one gives 401 (-07); another install's recognition, an unknown id and a `MATCH` give 404; a different station later gives 422 `STATION_ALREADY_CHOSEN`; a malformed id gives 400 `invalid_format`; unknown body fields give 400; the allowance gives 429; the update gate gives 426; a cookie opens nothing. *Added after review:* a cookie-carrying request from a foreign origin gets 403 (ALL-SECURITY-09); after a tap on Station A of an unanswered chooser, a choice of Station B gets 422 `STATION_ALREADY_CHOSEN` (A4). |
| `listener-station-list-route.test.ts` | Four stations (active listed, active unlisted, suspended listed, pending listed): only the first (P6-MYSTATION-03). The order; an empty list; the strong ETag and the 304; `Cache-Control: private, max-age=86400` here and `no-store` on every other listener route; 401, 426, 429. |
| `listener-app-version-gate.test.ts` | An install below the minimum gets 426 on recognize, choice, engagements, stations and report; `/installs` and `/client-errors` never answer 426; after registering again with a new enough version, 200 or 204 (P6-COMPATIBILITY-01). |
| `engagements-route.test.ts` (Piece 5) | A tap on a matched card is stored once; *amended after review:* a table over the five body fields (`recognition_id`, `station_id`, `action_id`, `occurred_at`, `sent_at`): a body missing any one of them gives 400 `VALIDATION_FAILED` naming that field, and stores nothing (P4-ENGAGEMENTS-01). Three posts: one row, three 204s (-02). A time before the recognition is stored as its receipt time; a day in the future as the receipt (-03, -04). A non-candidate station: no row, no counter move (-05). A PENDING or unknown recognition: nothing stored (-06). A second install: nothing stored (-07). No token: 401 (-08). All columns filled, the type from the card (-09). The action id as shown (-10). The same tap three times moves the counter by one (P4-LIMITS-02). Fill the limit, identify again: the default card (-05). A deferred clip captured before the limit was reached and sent after: the default card (P4-TIMERULE-04). One hundred taps at once, on 100 recognitions, against a limit of 10: the counter ends at exactly 10, all 204 (P4-LIMITS-06; the test raises the follow-up allowance). *Amended after review*, one scenario for P4-IDEMPOTENCY-20: send a key, tap Call once, send the key again; the replay has the same `recognition_id`, there is one recognition row, and the campaign's counter is 1 (and P4-IDEMPOTENCY-09 re-run). Taps on a default card never count. *Added after review* (A4): taps on two candidate stations of one chooser recognition: the first gets 204, the second 422 `STATION_ALREADY_CHOSEN`; the event's chosen station is the first, and only its campaign's counter moves. With the per-install cap at 2: one install's third tap that would count on one campaign within 24 hours is stored, not counted, and answered 204; another install's tap still counts (P4-D10). The race test above runs with the cap switched off. A cookie-carrying request from a foreign origin gets 403 (ALL-SECURITY-09). |
| `recognition-reports-route.test.ts` (Piece 4, if approved) | One report per recognition; a repeat with another reason: 204, unchanged; free text refused; the same validity as a tap. *Added after review:* the stored `listener_install_hash` equals the hashed `actor` of the request's log line and is not the install id; a cookie-carrying request from a foreign origin gets 403 (ALL-SECURITY-09). |
| `listener-install-reregistration.test.ts` (*added after review*, A3; Piece 4) | With the per-address registration limit used up, a re-registration carrying the install's own valid token succeeds; the same request without a token gets 429; an install's 6th re-registration in a day gets 429; a token of another install is treated as no token. |
| `client-default-card-route.test.ts` | Setting stores the reference, and an out-of-window recognition returns that card (P4-FALLBACK-04); clearing; another client's card refused; ANALYST 403; another station's client 404; the cross-site check; the audit row. |
| `recognition-idempotency-key-clean-up.test.ts` | Keys older than 48 hours removed, newer kept; batches; under 25 hours refused (P4-IDEMPOTENCY-19). |

### 6.5 Security, leak and log tests

- `error-responses.test.ts` (extended): for each new route, a forced database failure with SQLSTATE
  23505 text and a forced `TypeError` give a generic 500 whose body matches none of the internal-detail
  patterns ("Fatal error" and `Traceback` included), while the log holds the stack and the request id
  (ALL-ERRORS-02 to -04, ALL-TESTS-05). Malformed JSON, an oversized body and unknown fields give their
  envelopes.
- `log-privacy.test.ts` (extended): after exercising recognize with a hint, a chooser, a choice, a tap
  and a report, no log line holds a raw install id, a token, the hint's value, `+447700900`, a card
  label or a request body; each error line has the stack and the request id. *Added after review:*
  each line of a listener route, its error lines included, carries `actor`, and `actor` equals the
  keyed hash of the install (ALL-LOGGING-01, -03).
- `request-security.test.ts` (extended): each new route has its rate limit with `Retry-After`; the
  default-card route has the cross-site check (ALL-SECURITY-07 to -10). *Added after review:* every
  new write route, the listener ones included (choice, engagements, report), refuses a
  cookie-carrying request from a foreign origin with 403, one case per route (ALL-SECURITY-09). The
  listener routes are bearer-token routes, so a cookie never grants anything there either.

### 6.6 Contracts, stand-in and worker

- Contracts: every fixture of contract §2.6 through zod and the emitted schemas; the five envelopes;
  `comparisons.json`; `acknowledgement-rules.json` against `ERROR_CATALOG` (contract R9, server half;
  rows that name only a status class, the defaults the P6 design adds for every status a kind can
  meet, carry no code to look up); `timing-rules.json` equals `listener-outbox-rules.ts`.
- *Added after review* (A5): `RecognitionId` has no registry id, and the emitted JSON Schemas of
  `RecognitionStationChoiceInput`, `RecordEngagementInput` and `ReportRecognitionInput` hold only plain
  string properties, with no nested `$ref`; a contracts test asserts it.
- `apps/mobile/tool/test_fake_listener_api.py`: contract §4's list.
- No Python worker change (§5.3).

### 6.7 Tests that change on purpose

- Contract §2.8's list.
- `engine-hookup-database.test.ts`: the tests of `find_stations_for_audio`, `finish_recognition` and
  `describe_recognition` move to the replacements; "ignores stations that are not active, campaigns
  that are not active…" now expects a campaign paused *after* the capture to be a candidate. The
  ticked evidence of P4-TIMERULE-03, P4-IDEMPOTENCY-05 and -14 is re-pointed to the new test names in
  the same commit. *Amended after review:* the claim's own tests keep their file and names and run
  against the recreated `claim_recognition` (its skew argument now `bigint`), so the ticked evidence
  of P4-IDEMPOTENCY-03, -05, -14 and -15 still names tests that exist; they are re-run in Piece 2, and
  any name that changes is re-pointed in the same commit.
- `recognition-rules.test.ts`: "stores no skew for a phone clock off by weeks, which the column cannot
  hold" becomes "stores the exact skew of a phone clock off by weeks" (`clip-checks.ts`, P4-D18).
- `station-isolation-matrix.test.ts`: still reads only `id`, `station_id` and constants from
  `recognition_events`, which the column grants keep (P4-D30).
- `database-scaling.test.ts`: the partition function's new name.
- `recognition-install-limits.test.ts` and the S3-REQUEST-13 order tests: the count moves after the fields.
- `development-seed.test.ts`: Station B, default cards, no `+260` sample numbers.
- The portal's schedule-step and plain-words tests: the grace wording (Q1).

### 6.8 Gate run order

1. Docker up: contracts, portal and API suites (the API with the real Python workers in
   `fingerprint-workers.test.ts`); `pytest`. Then the Look Up containers are stopped.
2. Docker closed: `flutter analyze`, `flutter test`, `tool/test_fake_listener_api.py`, the emulator
   run (P6 design).
3. Emulator off, Docker up: the phone walkthroughs of §7.
4. The evidence checker: every ticked item names a test that exists.

---

## 7. Pieces, in build order

Each piece ends with every suite green, then a live walkthrough, then its commit. Docker and the
emulator never run at the same time (ALL-BUILD-MACHINE-06), so each walkthrough uses one of two
set-ups.

- **Set-up A, the emulator and the stand-in (Docker closed).** I stop the Look Up containers and you
  close Docker. I start `python apps/mobile/tool/fake_listener_api.py --port 3999` and the
  `lookup_test` emulator with software drawing (`-gpu swiftshader_indirect`, which stopped the
  freezes); the development APK talks to `10.0.2.2:3999` with a 5-second sending delay. The stand-in's
  answers and its "No signal" switch are set from its control page (P6 design §5.0) or by me.
- **Set-up B, your phone and the real stack (emulator closed).** You open Docker; I migrate and seed,
  and start the API on port 3100, both workers and the portal on http://localhost:5180, then the ngrok
  tunnel to port 3100 at your fixed address (ngrok 3.39.11 is already installed). Your phone has the
  development APK built for that address. A new app piece means a new APK, built with Docker closed
  before the session (ALL-BUILD-MACHINE-09). I run the development scripts of §5.15 in a terminal you
  can see.
  *Added after review* (P4-D35): the tunnel puts the whole API on the internet, portal sign-in and
  admin routes included, so:
  - before the first set-up B session I ask you to confirm that the ngrok token you pasted in chat
    was rotated, as you said you would; until then the tunnel is not started;
  - the tunnel runs with an ngrok traffic policy (a local file passed with `--traffic-policy-file`)
    that answers 404 to every path except the listener routes: `POST /api/v1/installs`,
    `POST /api/v1/recognize`, `POST /api/v1/recognitions/<id>/choice` and `/report`,
    `GET /api/v1/stations` (exactly, not `/stations/<id>`), `POST /api/v1/engagements` and
    `POST /api/v1/client-errors`. If your ngrok plan refuses the policy, I tell you before going on.
  - The portal stays on http://localhost:5180 and is never tunnelled.

**How the server pieces pair with the app's pieces.** The P6 design
(`docs/design/phase-6-full-listener-app.md`, §5) builds the app in seven pieces, numbered 0 to 6. The
server work is cut so that each app piece finds what it needs already built:

| This design | Server work | Built with, or before, the P6 design's | Walkthrough |
|---|---|---|---|
| Piece 1 | the shared contract and fixtures, the four catalogue codes, safe seed numbers | Piece 0 (the same commit) | below (set-up A) |
| Piece 2 | the migration and station resolution | before Piece 1 | below (set-up B, the Step 4 app) |
| Piece 3 | the choice route and the station list | Pieces 1 and 2 | below (A, then B) |
| Piece 4 | the deferred rules (places in flight, breakers, replay allowance), the update gate, re-registration (A3), the key clean-up, a queued crash report's time, "Report this" if approved | Pieces 3 and 4 | below (A, then B) |
| Piece 5 | engagements and tap limits | Piece 5 | below (B, and part in A) |
| — | none | Piece 6 | the P6 design's |

The record of P4 gate part 1 (P4-RESOLUTION-16) is made at the end of Piece 4, once every part-1 item
is built; gate part 2 (P4-RESOLUTION-17) at the end of Piece 5. *Amended after review:* gate part 1
can pass at the end of Piece 4 only if the user widens gate part 2 to P4-IDEMPOTENCY-20,
P4-DELIVERY-02 and -04 (Q11), and has seen the deferrals of Q10 and Q13; otherwise part 1 is recorded
with part 2 at the end of Piece 5. Piece 1 needs the answers to Q6, Q7 and Q14; Piece 2 needs Q1–Q5
and Q9, because the one migration holds every table and function (P4-D2); Piece 3 needs Q8; Piece 5
needs Q12.

**Walkthrough timing** (*added after review*, A1). The outbox retries after "no answer" on its own,
from the P6 design's Piece 1: after its n-th failure an item waits `min(5 × 2^(n−1), 1800)` seconds
× a random factor from 0.5 to 1 in the development build (staging and production use 30 in place of 5),
and the app wakes itself at that time while it is open. Turning "No signal" off, or airplane mode
off, therefore does not send at once: the next try comes within a few seconds, a little later after
each failure. The steps below say "within about 30 seconds" in set-up A and "within about a minute" in
set-up B before the P6 design's Piece 3, which adds "send when the network comes back"; if you waited
long with no signal, the wait can grow to a minute or two.

### Piece 1 — Safe sample numbers and the shared contract

**Built:** everything in contract §2 (the schemas, the version comparison, the outbox rules, the reason
codes, the emitted schemas, every fixture, with the 13 response fixtures' numbers and links replaced);
the four new catalogue codes; the seed's sample numbers (Q7). The app and the stand-in read the new
fixtures (the Step 4 app ignores the new `city` field). Built in the same commit as the P6 design's
Piece 0. *Added after review:* `RecognitionId` without a registry id and its contracts test (A5).
Checklist: P4-CHOOSER-01 to -04 (contract halves). Needs Q6 (whether the report schemas and fixtures
are written), Q7 (the numbers) and Q14 (`sent_at` in the tap body).

**Walkthrough (set-up A).**
1. The stand-in's next answer is "Match". You tap "Tap to identify" and let it listen. **Expected:**
   the Result card, "Brand A", "via Station A", with Call, WhatsApp, Map and Link.
2. You tap **Call**. The test emulator has no phone app, so the sheet with "Copy number" opens.
   **Expected:** the number starts `+447700900`: Ofcom's range for drama, which reaches no one.
3. The next answer is "Which station?". You identify again. **Expected:** still "This needs a newer
   Look Up". The sheet arrives with Piece 3.

### Piece 2 — "Which station?" decided on the server

**Built:** the migration (§4); `find_station_candidates`, `resolveStation` and the new finishing
(§4.4, §5.1); the hint stored and used; grace on both sides (Q1); the receipt-time rules, including
O13 (Q3); `CHOOSE_STATION` answers with candidate rows; replays (§5.4); the clock skew as `bigint`;
the default-card route (§5.10); the partition job and `runJob` (§5.12); the portal's grace wording;
the seed's Station B and default cards; the development scripts; ADR-003. Every test of §6.2 and §6.3,
and the resolution and replay route tests of §6.4.

**Walkthrough (set-up B, with the Step 4 app you already have).** This is also the first identify
through the real stack (fact 19). If the jingle is not recognised through the air, we fix that before
going on. Before you start, I end Station A's other sample campaigns that share the jingle (§5.15).
1. **One station.** In the portal, sign in as the Station A owner. Open Ads, then "Summer service
   offer", and press play on its audio near the phone. Tap "Tap to identify". **Expected:** Station
   A's buttons. In the terminal, `show-recognitions` says "Decided by: only one station can answer".
2. **Grace after a slot.** *Amended after review:* the portal offers times in quarter hours only, so
   do this step when the clock shows 1 to 5 minutes past a quarter hour (for example 14:32). In the
   ad's schedule, remove the two "All day" slots (00:00 to 12:00 and 12:00 to 00:00) and add one
   slot, every day, from 00:00 to the quarter hour that has just passed (14:30 in the example). Keep
   the 10-minute grace and save. Identify within 2 minutes. **Expected:** still the campaign's
   buttons: the slot ended 1 to 7 minutes ago, inside the grace. Set the grace to "None" and save;
   identify. **Expected:** Brand A's usual buttons, with the note "These are Brand A's usual contact
   details." (A7; the words follow Q8).
3. **Grace before a slot.** Do this step when the clock shows 7 to 12 minutes past a quarter hour (for
   example 14:39). Change the slot to start at the next quarter hour (14:45) and end at 00:00, with the
   10-minute grace; save. Identify within 1 minute. **Expected:** the campaign's buttons: the slot
   starts in 2 to 8 minutes, inside the grace. Then I run `development:reset-sample-schedule`, which
   puts back the two all-day slots and the 10-minute grace.
4. **Two stations.** Open Station B's pages (the address the seed printed). Publish its "Summer service
   offer". Identify. **Expected on the phone:** "This needs a newer Look Up" (the sheet comes with
   Piece 3). **Expected in the terminal:** `Asked "Which station?": 1. Station A (98.1 FM · Lusaka)
   2. Station B (104.3 FM · Kitwe)`, "Not chosen yet". Both slots started at the same time, so they
   are listed by name.
5. **Suspension.** I run `development:set-station-status -- "Station B" SUSPENDED`. Identify.
   **Expected:** Station A's buttons, "Decided by: only one station can answer". I set it back to ACTIVE.
6. **A paused campaign.** I pause Station B's campaign with the script. Identify. **Expected:** Station
   A's buttons; a campaign paused *before* the clip was heard is not a candidate. ("Paused *after* the
   clip was heard" needs a clip sent later; it is shown in Piece 4.) I set it back to ACTIVE, so both
   stations are live for Piece 3.

**What happened (12 October 2026).** Through the air the identifies mostly came back "No match": the 6 s jingle gave
the phone 1 or 2 matching landmarks, and of the user's own song ("Music test") only 3 of 7 clips reached the
threshold when they were run again in memory. As planned above, we fixed
that before going on: the engine's settings were chosen again from the user's phone recordings (fingerprint version
2, ADR-001 "Real captures, October 2026"), every stored recording is fingerprinted again with them
(`npm run fingerprints:refingerprint -w @lookup/api`), and the seed now gives the sample ads a 20 s jingle with a
melody, chords and a beat (running `npm run database:seed` again gives ads seeded earlier the new one). The
walkthrough resumes at step 2 once an over-the-air check on the real stack passes: identifies of "Music test" and
the new jingle answer with the right ad, and unindexed audio answers "No match". It passed the same day: 6 of 6
identifies answered with the right ad and 5 of 5 unindexed songs "No match" (ADR-001, "Over the air on the real
stack").

### Piece 3 — The chooser's choice and the "My station" list

**Built (server):** the choice route (§5.5), the station list (§5.6), the listener-route matcher and
the follow-up allowance; the stand-in's choice and station-list routes with their scenarios
(contract §4). **Built (app):** the P6 design's Pieces 1 and 2 — the chooser sheet, "Remember my
station", the hint at capture, the outbox with its first kind (`STATION_CHOICE`), the tab bar, History
and Settings with the "My station" picker. Checklist: P4-CHOICE-01 to -07; the server halves of
P6-CHOOSER-07, -10, -14, -15, P6-MYSTATION-02, -03, -05, -06 and P6-TESTS-07.

**Walkthrough, part 1 (set-up A)**, the server-facing steps of the P6 design's Piece 1 and Piece 2
walkthroughs:
1. The next answer is "Which station?". Identify. **Expected:** the sheet "Which station are you
   listening to?", "This ad is on more than one station right now.", the rows "Station A, 98.1 FM ·
   Lusaka" and "Station B, 104.3 FM · Kitwe", "Remember my station — skip this next time" ticked, and
   "Cancel".
2. "No signal" on. Tap **Station B**. **Expected:** at once, the Result "via Station B", with no signal.
3. "No signal" off. **Expected:** within about 30 seconds (the outbox's next try, A1) the stand-in
   shows exactly one choice, for Station B.
4. The next answer is "Match by my station". Identify. **Expected:** no sheet; the Result "via Station
   B"; the stand-in's log shows the hint.
5. Settings, then **My station**. **Expected:** the list shows Station A and Station B. Pick one. Open
   the list again. **Expected:** the stand-in's log shows one list request, not two.

**Walkthrough, part 2 (set-up B, the new APK).** Both stations live, as at the end of Piece 2.
1. Play the jingle and identify. **Expected:** the sheet with Station A and Station B and their real
   frequencies and cities. Keep "Remember my station" ticked, turn on airplane mode, and tap
   **Station B**. **Expected:** "via Station B" at once.
2. Turn airplane mode off and wait up to a minute, with Look Up open (the outbox's next try, A1; the
   app does not yet send the moment the network returns). **Expected in the terminal:** "Decided by:
   the listener's choice — Station B" (P6-TESTS-07, part 3).
3. Identify again. **Expected:** no sheet, "via Station B"; the terminal says "Decided by: My station".
4. Settings, then **My station**. **Expected:** Station A and Station B, as the real API lists them.

### Piece 4 — Clips sent later, the update gate and reports (closes P4 gate part 1)

**Before it starts** (*amended after review*, as the P6 design's correction 3): emulator run 5 passed
all 17 steps and the Step 4 gate record calls run 4's "no match shown as No connection" a one-off
connection drop. What contract §5 point 16 still asks for is kept: the emulator evidence records the
app's no-answer reason (the P6 design's Piece 0) before this piece rewrites that path.

**Built (server):** the reader's fields-first rule, and the places in flight and the per-install count
after the fields; the deferred allowance, the held-key exemption and the replay allowance; the
deferred share of the places in flight and the deferred breaker; shedding, priority and the 5-second
wait (§5.2, §5.3); the idempotency and clock tests; the key clean-up job (§5.12); the update gate and
the hashed `actor` on listener log lines (§5.7); re-registration after an update (A3); `occurredAt` on
crash reports; "Report this" (§5.9) if approved, with its install hash. **Built (app):** the P6 design's Pieces 3 and 4 —
the clip and crash-report outbox kinds, Saved offline, History's waiting rows, the notification, the
background send if its package is approved, "Please update the app", the data saver and the report
sheet. **Gate part 1** (P4-RESOLUTION-16) is recorded at the end: every P4 item outside LIMITS,
ENGAGEMENTS and P4-TIMERULE-04 is ticked with its named test, or deferred with a reason the user has
seen (Q5, Q10, Q13, and P4-DELIVERY-03's supersession). *Amended after review:* P4-IDEMPOTENCY-20,
P4-DELIVERY-02 and -04 can only be ticked in Piece 5, so part 1 passes here only if the user moves
them to part 2 (Q11); otherwise part 1 is recorded with part 2.

**Walkthrough, part 1 (set-up A)**, the server-facing steps of the P6 design's Piece 3 and Piece 4
walkthroughs:
1. "No signal" on. Identify. **Expected:** "Saved — we'll identify it when you're back online" and
   "No signal right now. Your clip stays on this phone for up to 24 hours and is deleted as soon as it's
   sent."
2. Tap **See it in History**. **Expected:** "Waiting for signal", "Clip from today, <time>", "Will
   identify when you're back online", "Pending".
3. "No signal" off. **Expected:** within about 30 seconds the stand-in's log shows the clip sent again
   with `is_deferred=true`, the same key as before and a later `sent_at`; then a notification that
   says only "Look Up", "Your saved clip has been checked. Tap to see the result." (A6), and, after
   tapping it, the Result.
4. *Reordered after review*, so the queued answer cannot be used up by a dropped send: "No signal" on;
   save a clip; only then queue "Busy (shed)" and "Match"; switch "No signal" off. **Expected:** the
   first try gets the shed answer, and the second comes at least 60 seconds after it.
5. *Amended after review* (A2). "No signal" on; save a clip. The stand-in's minimum app version is
   set to 0.2.0; "No signal" off. **Expected:** the clip is refused with 426 and kept (History still
   shows it as Pending). Identify: the app's "Please update the app" screen. The minimum is set back;
   identify again (queue "Match"). **Expected:** the result, and then the saved clip is sent and its
   notification arrives: an answer other than 426 ends the pause.
6. If "Report this" is approved: on a Result, report it as a scam. **Expected:** the stand-in shows one
   report.

**Walkthrough, part 2 (set-up B).** For this session I set the deferred `Retry-After` range to 10–20
seconds in the development settings, so nothing takes five minutes. I pause Station B's campaign
first, so Station A answers alone (your "My station", Station B, is then ignored, as it should be).
1. Put the phone in airplane mode. Play the jingle and identify. **Expected:** Saved offline, and
   Pending in History.
2. I pause Station A's campaign with the script. Turn airplane mode off and open the app.
   **Expected:** a notification saying only "Your saved clip has been checked. Tap to see the result."
   (A6); tap it: Brand A's usual buttons, with the note "These are Brand A's usual contact details."
   (A7): the campaign was live when you heard the ad but is paused now (O13). The terminal says, for
   example, "heard 14:32, arrived 14:35, sent later".
3. I set the campaign back to ACTIVE. Repeat step 1, and before you turn airplane mode off I suspend
   Station A. **Expected:** "no match": a suspended station's card is never shown. I set it back.
4. *Amended after review* (A2). Airplane mode on; play the jingle and identify: Saved. I restart the
   API with the minimum app version set to 0.2.0. Airplane mode off. **Expected:** the saved clip
   stays Pending (refused with 426, kept). Identify: "Please update the app". I restart the API without
   the setting; identify again. **Expected:** the result, and within about a minute the saved clip's
   notification: a live answer other than 426 ends the pause.
5. If "Report this" is approved: report the last result as a scam. **Expected:**
   `development:show-reports` shows one report with that reason, the station, and the first 6
   characters of the phone's anonymous code, and nothing else about you.

### Piece 5 — Taps and tap limits (closes P4 gate part 2)

**Built (server):** the engagements route and the counter (§5.8); `features/engagements`.
**Built (app):** the P6 design's Piece 5 — taps queued in the outbox from Result and saved results.
**Gate part 2** (P4-RESOLUTION-17) is recorded at the end, with P6-OUTBOX-06.

**Walkthrough (set-up B).** Station B stays paused, so Station A answers alone.
1. In the portal, set a **tap limit of 2** on Station A's "Summer service offer" and save.
2. Identify. Tap **Call**: the dialler opens with a number starting `+447700900`. *Amended after
   review:* do not press call; go back from the dialler. From a Zambian SIM that would be an
   international call attempt to the UK, which may be charged; opening the dialler is the tap. Tap
   **WhatsApp**: WhatsApp says the number is not on WhatsApp. Go back. **Expected in the terminal:**
   "Call — counted, 1 of 2", "WhatsApp — counted, 2 of 2".
3. Identify again. **Expected:** Brand A's usual buttons with the note "These are Brand A's usual
   contact details." (A7), because the limit is reached. Tap **Call**, then go back from the dialler.
   **Expected:** "Call — stored, not counted (usual buttons)".
4. Airplane mode on. Open History, the last result, and tap **Get directions** (Maps may still open).
   Airplane mode off. **Expected:** the tap appears once, even if the phone sent it twice.
The same deduplication shows in set-up A (the P6 design's Piece 5 walkthrough): two taps on one button
give one tap at the stand-in, and the "answer lost" scenario still leaves one recognition.

---

## 8. Item map

"Piece" is where the item is built and ticked. "Here?" says whether it can be built and verified on
this machine.

### 8.1 Every P4 item (114)

| Item | Covered by | Piece | Here? |
|---|---|---|---|
| P4-TIMERULE-01 | §5.2; `recognize-deferred` (both times kept, about 3 h apart) | 4 | Yes |
| P4-TIMERULE-02 | §4.3; `time-windows-with-grace-database` | 2 | Yes |
| P4-TIMERULE-03 | Ticked. Kept by §4.4; evidence re-pointed to `station-resolution-database` (§6.7) | 2 | Yes |
| P4-TIMERULE-04 | §5.8; `engagements-route` | 5 | Yes |
| P4-TIMERULE-05 | §4.4, §5.1; `recognize-station-resolution` | 2 | Yes |
| P4-TIMERULE-06 | §4.1 (`status_changed_at`), §4.4, §5.1; database and route tests | 2 | Yes, after Q3 |
| P4-TIMERULE-07 | §5.1; `recognize-station-resolution` | 2 | Yes |
| P4-TIMERULE-08 | `time-rule-split` | 2 | Yes |
| P4-CLOCK-01 | `recognition-rules` (3 h fast, exact); `recognize-deferred` (3 h slow, right window) | 4 | Yes |
| P4-CLOCK-02 | `recognize-deferred` | 4 | Yes |
| P4-CLOCK-03 | Ticked; unchanged | — | Yes |
| P4-CLOCK-04 | §4.1, §4.4 (`bigint` column and the recreated claim; P4-D18, P4-D2); `station-resolution-database` (30 days off), `recognition-rules` | 2 | Yes |
| P4-CLOCK-05 | Ticked; unchanged | — | Yes |
| P4-CLOCK-06 | Ticked; unchanged | — | Yes |
| P4-CLOCK-07 | `recognize-deferred` | 4 | Yes |
| P4-CLOCK-08 | `station-resolution-database` (direct insert); `recognize-deferred` (exact bounds) | 4 | Yes |
| P4-DEFERRED-01 | `recognize-deferred` (also a Busy live send later sent from the outbox); `station-resolution-database` (re-claim keeps `true`) | 4 | Yes |
| P4-DEFERRED-02 | `recognize-deferred` | 4 | Yes |
| P4-DEFERRED-03 | §5.2 (and the replay allowance, P4-D14); `recognize-deferred` | 4 | Yes |
| P4-DEFERRED-04 | §5.2; `recognize-deferred` | 4 | Yes |
| P4-DEFERRED-05 | §5.2, §5.3 (the deferred share of the places in flight, the deferred breaker; P4-D15); `recognize-deferred`, `recognition-breakers` | 4 | Yes |
| P4-DEFERRED-06 | §5.2, §5.3 (every 503 after the fields); `recognize-deferred` | 4 | Yes |
| P4-DEFERRED-07 | §5.3; `recognize-queue-priority`, `fingerprint-workers` | 4 | Yes |
| P4-DEFERRED-08 | §5.3; `recognize-queue-priority` | 4 | Yes |
| P4-DEFERRED-09 | §5.3; `recognize-deferred` | 4 | Yes |
| P4-DEFERRED-10 | §5.11; `startup-checks`, `recognize-deferred` | 4 | Yes |
| P4-DEFERRED-11 | **Proposed for P8** (P4-D22, Q10): the final numbers come from the load test on Render; the plan's example numbers stay the configured defaults. Deferred only once the user has seen Q10 | — | No (k6 is a download; no targets yet, gap 2) |
| P4-DEFERRED-12 | Gate check once -03 to -09 are ticked | 4 | Yes |
| P4-IDEMPOTENCY-01 | `station-resolution-database` (row counts) | 4 | Yes |
| P4-IDEMPOTENCY-02 | `recognize-request-order` | 4 | Yes |
| P4-IDEMPOTENCY-03 | Ticked; unchanged | — | Yes |
| P4-IDEMPOTENCY-04 | `station-resolution-database` (two claims at once) | 4 | Yes |
| P4-IDEMPOTENCY-05 | Ticked; evidence re-pointed (§6.7) | — | Yes |
| P4-IDEMPOTENCY-06 | Ticked; chooser replays added (§5.4, `recognize-replays`) | 2 | Yes |
| P4-IDEMPOTENCY-07 | Ticked; unchanged | — | Yes |
| P4-IDEMPOTENCY-08 | Ticked; unchanged | — | Yes |
| P4-IDEMPOTENCY-09 | §5.4, §5.8; `recognize-replays` (a seeded counter unchanged by a replay; *moved to Piece 4 after review*), re-run in `engagements-route` with a real tap | 4 | Yes |
| P4-IDEMPOTENCY-10 | §5.4; `recognize-replays` | 2 | Yes |
| P4-IDEMPOTENCY-11 | §5.4, P4-D13; `recognize-replays` | 2 | Yes |
| P4-IDEMPOTENCY-12 | Ticked; unchanged | — | Yes |
| P4-IDEMPOTENCY-13 | Ticked; unchanged | — | Yes |
| P4-IDEMPOTENCY-14 | Ticked; evidence re-pointed (§6.7) | — | Yes |
| P4-IDEMPOTENCY-15 | Ticked; unchanged | — | Yes |
| P4-IDEMPOTENCY-16 | §5.1, P4-D5; `station-resolution-database`. *Amended after review:* ticked only once Q9 is answered and the item reworded (or the history built); never on the `received_at` assertion alone | 2 | Yes, after Q9 |
| P4-IDEMPOTENCY-17 | Ticked; unchanged | — | Yes |
| P4-IDEMPOTENCY-18 | Ticked; unchanged | — | Yes |
| P4-IDEMPOTENCY-19 | §5.12; `recognition-idempotency-key-clean-up` | 4 | Yes |
| P4-IDEMPOTENCY-20 | §5.8; `engagements-route` (one scenario: key, tap, replay; same id, one row, counter at 1). Counters move only at a tap (P4-D10), so it is ticked in Piece 5, in gate part 2 if the user agrees (Q11) | 5 | Yes, after Q11 |
| P4-IDEMPOTENCY-21 | `recognize-request-order` | 4 | Yes |
| P4-ADMISSION-01 | Ticked; re-run after §5.3 | 4 | Yes |
| P4-RESOLUTION-01 | §5.1; `station-resolution-rules` | 2 | Yes |
| P4-RESOLUTION-02 | §4.3; `time-windows-with-grace-database` | 2 | Yes, after Q1 |
| P4-RESOLUTION-03 | §4.3; `time-windows-with-grace-database` | 2 | Yes |
| P4-RESOLUTION-04 | §5.1; `station-resolution-rules`, route tests | 2 | Yes |
| P4-RESOLUTION-05 | §5.1; `recognize-station-resolution` | 2 | Yes |
| P4-RESOLUTION-06 | §5.1; rules and route tests | 2 | Yes |
| P4-RESOLUTION-07 | §5.1, §5.4; rules and route tests | 2 | Yes |
| P4-RESOLUTION-08 | §5.1 (a hint for an unlisted candidate is used, Correction 3); rules and route tests | 2 | Yes |
| P4-RESOLUTION-09 | §5.1; `recognize-station-resolution` | 2 | Yes |
| P4-RESOLUTION-10 | §4.4 (`finish_recognition`), P4-D9; database and route tests | 2 | Yes |
| P4-RESOLUTION-11 | §4.1, §5.1; `station-resolution-database` | 2 | Yes |
| P4-RESOLUTION-12 | §4.2, §5.1 (a row for every station that can answer, whatever the outcome; P4-D8 amended); `station-resolution-database` | 2 | Yes |
| P4-RESOLUTION-13 | §4.5; `station-isolation` | 2 | Yes |
| P4-RESOLUTION-14 | §5.1, §5.4; `recognize-station-resolution` per branch, `recognize-replays` | 2 | Yes |
| P4-RESOLUTION-15 | **Expected to be retired** (Q5, P4-D21): O3 fixes one behaviour, so no column is built | — | — |
| P4-RESOLUTION-16 | Gate part 1, at the end of Piece 4 if the user agrees to Q11 and has seen Q10 and Q13; otherwise with part 2 at the end of Piece 5 | 4 | Yes |
| P4-RESOLUTION-17 | Gate part 2, at the end of Piece 5, with P6-OUTBOX-06; its scope widened to P4-IDEMPOTENCY-20, P4-DELIVERY-02 and -04 if the user agrees (Q11) | 5 | Yes |
| P4-FALLBACK-01 | §5.1; rules and route tests | 2 | Yes |
| P4-FALLBACK-02 | §5.1; rules and route tests | 2 | Yes |
| P4-FALLBACK-03 | §4.4 (`last_slot_ended_at`), §5.1; database and route tests | 2 | Yes, after Q4 |
| P4-FALLBACK-04 | §5.10; `client-default-card-route` | 2 | Yes |
| P4-CHOOSER-01 | Contract §2.6 (`choose-station-with-result.json`); route tests | 1–2 | Yes |
| P4-CHOOSER-02 | Contract §2.6 (five candidates); `recognize-station-resolution` (five in window give four) | 1–2 | Yes |
| P4-CHOOSER-03 | Contract §2.1 (`ListenerStation` with city); route tests | 1–2 | Yes |
| P4-CHOOSER-04 | Contract §2.6; route tests | 1–2 | Yes |
| P4-LIMITS-01 | `station-resolution-database` (0 refused) and the existing schedule test | 5 | Yes |
| P4-LIMITS-02 | §5.8 (and the per-install cap, Q12); `engagements-route` | 5 | Yes |
| P4-LIMITS-03 | §4.2; schema test in `database-catalogue` | 5 | Yes |
| P4-LIMITS-04 | §4.4 (the counter statement); code review plus the race test | 5 | Yes |
| P4-LIMITS-05 | §5.8, P4-D10; `engagements-route` | 5 | Yes, after Q2 |
| P4-LIMITS-06 | §5.8; `engagements-route` (100 at once, limit 10) | 5 | Yes |
| P4-CHOICE-01 | §5.5; `station-choice-route` | 3 | Yes |
| P4-CHOICE-02 | §5.5; `station-choice-route` | 3 | Yes |
| P4-CHOICE-03 | §5.5; `station-choice-route` | 3 | Yes |
| P4-CHOICE-04 | §4.4; `station-choice-route` | 3 | Yes |
| P4-CHOICE-05 | §4.2 (one chosen per recognition); `station-choice-route` | 3 | Yes |
| P4-CHOICE-06 | §4.5; `station-isolation` | 3 | Yes |
| P4-CHOICE-07 | §5.5; `station-choice-route` | 3 | Yes |
| P4-ENGAGEMENTS-01 | §5.8; `engagements-route` | 5 | Yes |
| P4-ENGAGEMENTS-02 | §4.2, §5.8; `engagements-route` | 5 | Yes |
| P4-ENGAGEMENTS-03 | §5.8; `engagements-route` | 5 | Yes |
| P4-ENGAGEMENTS-04 | §5.8; `engagements-route` | 5 | Yes |
| P4-ENGAGEMENTS-05 | §5.8 (and A4: a tap on an unanswered chooser is the choice); `engagements-route` | 5 | Yes |
| P4-ENGAGEMENTS-06 | §5.8; `engagements-route` | 5 | Yes |
| P4-ENGAGEMENTS-07 | §5.8; `engagements-route` | 5 | Yes |
| P4-ENGAGEMENTS-08 | §5.8; `engagements-route` | 5 | Yes |
| P4-ENGAGEMENTS-09 | §4.2; `database-catalogue`, `engagements-route` | 5 | Yes |
| P4-ENGAGEMENTS-10 | §5.8; `engagements-route` | 5 | Yes |
| P4-ENGAGEMENTS-11 | §4.5; `station-isolation` | 5 | Yes |
| P4-ENGAGEMENTS-12 | §4.2 (no foreign key to events, A8); `station-resolution-database` (across a month boundary), `database-scaling` (detach) | 5 | Yes |
| P4-DATABASE-01 | §4.2, §4.5; `station-isolation`, `station-isolation-matrix` | 2 | Yes |
| P4-DATABASE-02 | §4.5; `database-privileges` | 2 | Yes |
| P4-DATABASE-03 | §4.6 (the detach runbook, A8); `database-scaling` | 2 | Yes |
| P4-TESTS-01 | `time-windows-with-grace-database` | 2 | Yes |
| P4-TESTS-02 | `time-windows-with-grace-database` | 2 | Yes |
| P4-TESTS-03 | `time-windows-with-grace-database` | 2 | Yes |
| P4-TESTS-04 | `time-windows-with-grace-database` | 2 | Yes |
| P4-TESTS-05 | `time-windows-property` (P4-D23) | 2 | Yes |
| P4-TESTS-06 | **Proposed for P8** (P4-D22, Q10): the load tests on Render, with the target rate and p95 the user gives | — | No (k6 download, no targets) |
| P4-TESTS-07 | **Proposed for P8** with P4-TESTS-06 (P4-D22, Q10) | — | No |
| P4-DELIVERY-01 | §5.16 (ADR-003) | 2 | Yes |
| P4-DELIVERY-02 | §5.14 (`features/engagements`); in gate part 2 if the user agrees (Q11) | 5 | Yes, after Q11 |
| P4-DELIVERY-03 | **Superseded**: the user's reorder of 10 October 2026 (P4-D1); recorded in the checklist as a deferral the user has seen | — | — |
| P4-DELIVERY-04 | §7 order: Piece 5 after Pieces 3 and 4; checked in the commit history; in gate part 2 if the user agrees (Q11) | 5 | Yes, after Q11 |

**Expected to stay open at the P4 gates, with the reason:** P4-DEFERRED-11, P4-TESTS-06 and -07 (k6 is
a download and the user has given no target rate or latency; proposed for P8, P4-D22, and deferred
only once the user has seen Q10); P4-RESOLUTION-15 (retired once Q5 is answered); P4-DELIVERY-03
(superseded by the user's reorder). *Added after review:* at gate part 1 only, P4-IDEMPOTENCY-20,
P4-DELIVERY-02 and -04 (built and ticked in Piece 5, in gate part 2 if the user agrees, Q11) and
P4-RESOLUTION-17 (the second gate itself). Items marked "after Q…" are built on the recommended answer
and changed if the answer differs; an item whose wording the design does not meet (P4-IDEMPOTENCY-16)
is never ticked before the user's answer.

### 8.2 P6 items with a server half

| Item | Server half | Piece |
|---|---|---|
| P6-SCOPE-01 | The order of §7: the chooser (3), then offline capture and History (4), then taps (5) | 3–5 |
| P6-STATE-02, -03 | The chooser answers and fixtures (§5.4, contract §2.6) | 2 |
| P6-CHOOSER-02, -03 | 2–4 candidates; the city in `ListenerStation` | 1–2 |
| P6-CHOOSER-07, -15 | The hint used by the server (`HINT`) | 2–3 |
| P6-CHOOSER-10, -14 | The choice route; no cancel request, the recognition stays `UNRESOLVED` | 3 |
| P6-MYSTATION-02, -03, -06 | The station list route, listed ACTIVE stations only, the one place stations are listed (D8) | 3 |
| P6-MYSTATION-05 | The hint accepted, stored and used | 2 |
| P6-SETTINGS-03 | The station name and frequency from the list | 3 |
| P6-OUTBOX-02, -03 | Each follow-up's natural key (contract R12) | 3–5 |
| P6-OUTBOX-05 | One row per clip, choice and tap however often sent | 3–5 |
| P6-OUTBOX-06 | The engagements route (gate part 2); a tap on an unanswered chooser records the choice (A4) | 5 |
| P6-OUTBOX-07 | The API end-to-end half: the stored row is deferred with a corrected capture time | 4 |
| P6-OFFLINE-04, -05 | 422 `CAPTURE_EXPIRED` after 24 hours, permanent | 4 |
| P6-OFFLINE-13 to -19 | Each code and `Retry-After` of contract §1.2; `acknowledgement-rules.json` against the catalogue; every 503 to a deferred send, the in-flight one included, carries the deferred `Retry-After` (P4-D15) | 4 |
| P6-LISTENING-02 | The same key re-claimed after Busy and from the outbox | 4 |
| P6-RESULT-04, -05 | The report route and table, if approved (Q6), with the install's keyed hash for super admins (P4-D28) | 4 |
| P6-DATASAVER-01 | Out of scope: no image variants until stations can upload images (contract §5, point 15) | — |
| P6-ERRORREPORTING-05 | `occurredAt` accepted and logged | 4 |
| P6-COMPATIBILITY-01 | The update gate (§5.7); re-registration after an update counted per install (A3, P4-D31) | 4 |
| P6-COMPATIBILITY-03 | Met by the gate plus the reader's `schema_version` rule; no card `min_app_version` (P4-D16). *Amended after review:* this departs from the item's wording, so it is ticked only after the user's answer to the P6 design's question on it | 4 |
| P6-STRUCTURE-02 | No server route: `/r/<id>` opens the local History (gap 19) | — |
| P6-TESTS-07 | Part 2: `station-choice-route` (`LISTENER_CHOICE`); part 3: the Piece 3 phone walkthrough | 3 |
| P6-TESTS-09 | Part 2: `recognize-deferred`; the Piece 4 phone walkthrough | 4 |

Other items this phase touches: **S3-REQUEST-13** (its evidence is re-run with the new order),
**S3-RESPONSE-14** and **-17** (no internal ids; the station id as the public reference, kept),
**S4-INSTALLS-02** (registering again on a version change, counted per install, A3).

### 8.3 The ALL rules

| Rule | Where it is met |
|---|---|
| ALL-GATES-01, -02, ALL-CHECKLIST-03, -05, -07 | This file predates the first P4 commit; five pieces; §8 maps every item; open items listed above, each deferred only with a reason the user has seen (Q5, Q10, Q11, Q13) |
| ALL-CHECKLIST-06 | §8.4: the behaviours this design adds become checklist items before Piece 2 (P4-D36) |
| ALL-DECISIONS-02, -03 | §2; every question in §10 has a recommended answer |
| ALL-SECURITY-01 to -10 | §4.5, §5.5–§5.10, §5.13, §6.5; ALL-SECURITY-09 per new write route, the listener ones included (§6.5); the phone walkthrough's tunnel limited to the listener routes (§7, P4-D35) |
| ALL-DATABASE-01 to -13 | §4.1, §4.2, §4.4, §4.5; `database-catalogue`, `database-privileges`; ALL-DATABASE-04 also by the column grants on `recognition_events` (P4-D30); ALL-DATABASE-07, -08 for every new function, `count_recognition_attempts` and `find_station_candidates` included (§6.2) |
| ALL-SCALING-01, -02, -05, -07, -08 | §4.2, §4.6; detaching a month with a later tap on it (A8, `database-scaling`); lookups that prune partitions (P4-D32) |
| ALL-MIGRATIONS-01 to -04 | §4 (one new migration, grants per role, its tests, comments on scaling) |
| ALL-NAMING-01 to -10, ALL-DATABASE-NAMING-01 to -16 | §4 and §5.14 names; the catalogue test, which gains an index-name check; `docs/conventions.md` gains the partial unique index rule (§5.16, P4-D34) |
| ALL-STRUCTURE-01 to -05 | §5.14 |
| ALL-ERRORS-01 to -10 | §5.13, §5.12 (jobs), §6.5 |
| ALL-LOGGING-01 to -07 | §5.13, §6.5; the hashed `actor` on every listener line (§5.7, P4-D26) |
| ALL-JOBS-01, -02 | §5.12 (`runJob`) |
| ALL-TESTS-01 to -05 | §6.1, §6.5 |
| ALL-PRIVACY-01 | §4.2, §4.5, §5.13 |
| ALL-USABILITY-05, -06 | The walkthroughs of §7; the scripts print plain words |
| ALL-BUILD-MACHINE-04, -06, -09 | No download (header); set-ups A and B in §7 |
| ALL-ORDER-01 | Superseded for 5a by the user's reorder (P4-D1) |

### 8.4 New checklist items (added after review; P4-D36)

ALL-CHECKLIST-06 says a new requirement is added to the checklist first, then built. These behaviours
of this design are stated by no checklist-2 item. Each is added to checklist part 2, in the P4
section, before Piece 2's first commit, with "*Source:* this design (the decision named)" and the
"verified by" below. The user sees them in Piece 2's record. Numbers continue each area's last one;
STATIONLIST, UPDATEGATE, INSTALLS, REPORTS and TOOLS are new areas.

| Proposed id | Requirement | Decision | Verified by | Piece |
|---|---|---|---|---|
| P4-DEFERRED-13 | Every text field comes before the audio part; audio first is 400 `audio_part_before_fields`. | P4-D14 | `recognize-request-order` *Amended after review:* a send of a key the install holds (under 5 attempts) is counted against a replay allowance of 60 an hour instead of not at all; a refusal for lack of a place in flight is never counted. | 4 Review finding: a replay of a finished key never claims, so its attempt count never grows, and one install could replay without limit. |
| P4-DEFERRED-14 | A send of a key the install already holds, under 5 attempts, is counted against a replay allowance (60 an hour), not the live or deferred one. | P4-D14 | `recognize-deferred` | 4 |
| P4-ADMISSION-02 | The places in flight are checked when the text fields arrive; deferred sends may hold at most 16 of the 32; a refusal there is never counted against the listener's allowance. | P4-D15 | `recognize-deferred` *Amended after review:* deferred sends get their own circuit breaker (live admission looks only at the live one; deferred admission refuses while either is open) and at most 16 of the 32 places in flight; the places in flight are checked when the text fields arrive, so every 503 to a deferred send carries the 60–300 `Retry-After`. | 4 Review finding: deferred timeouts opened the one shared breaker, and a deferred burst could fill the places before its fields were read, so deferred clips could push live clips out, against P4-DEFERRED-05. `opossum` counts a filtered error as a success, so a filter in the shared breaker was not a safe fix. |
| P4-ADMISSION-03 | Deferred sends have their own circuit breaker; their timeouts never open the live one, and a live breaker that is open refuses deferred sends too. | P4-D15 | `recognition-breakers`, `recognize-deferred` | 4 |
| P4-IDEMPOTENCY-22 | A re-claim stores `is_deferred` as the stored value or the new one, and resolves at the first capture time. | P4-D2 | `station-resolution-database`, `recognize-deferred` *Amended after review:* `claim_recognition` does not stay. It is dropped and created again in the same migration with a `bigint` skew parameter, `is_deferred = stored OR new` on a re-claim, and the stored capture time returned, so a retry is resolved at the first capture moment. `clip-checks.ts` loses `LARGEST_STORED_SKEW_MILLISECONDS`. The claim's tests keep their names, so the ticked evidence of P4-IDEMPOTENCY-03, -05, -14 and -15 still names tests that exist; it is re-run in Piece 2. | 2 Review finding: the claim's `integer` parameter is the column's only writer, so P4-D18 could not work with the claim untouched, and a phone off by more than about 24.8 days would have caused a 500 (SQLSTATE 22003). The contract says the stored `is_deferred` is the computed one, which a re-claim did not honour. |
| P4-TIMERULE-09 | The database records when a campaign's status changed; a campaign paused or ended after the capture still makes its station an owner, with the client's default card. | P4-D4 | `station-resolution-database` *Amended after review:* a station's campaigns fold in this order: in window (the slot that started last), else the slot that ended last within 7 days, else the latest period start not after the capture, else the first to start, then the id. | 2 Review finding: "the latest period start" could pick a campaign of another client that has not started yet (the seed's "Weekend sale"). |
| P4-CHOOSER-07 | Every station in an answer carries its city or null; the database keeps a city null or 1–80 characters. | P4-D27 | `station-resolution-database`, `recognize-station-resolution` | 2 |
| P4-FALLBACK-05 | Station OWNERs and MANAGERs set or clear a client's default card through a portal route, only to a card of that client, with an audit event. | P4-D20 | `client-default-card-route` | 2 |
| P4-CHOICE-08 | Choices, taps and reports share one per-install allowance (60 a minute) with `Retry-After`. | P4-D29 | `station-choice-route`, `engagements-route` | 3 |
| P4-D30 | **The API role reads `recognition_events` through column grants** that leave out `listener_install_id`, `hinted_station_id`, `idempotency_key`, `client_captured_at` and `clock_skew_milliseconds`; `lookup_admin_api` is unchanged. Added after review. | Review finding (gap 38): row policy alone let a station's context read the install and the hint (another station's id when it was ignored); the phone's capture time and skew are a clock fingerprint. No station query reads these columns. ALL-DATABASE-04, ALL-PRIVACY-01. |
| P4-D31 | **Re-registration after an update** (A3): a `POST /installs` with the install's own valid token counts against 5 a day per install, not the 60 an hour per address. Added after review. | Review finding: after a release, many phones behind one carrier address register again within the hour. |
| P4-D32 | **A recognition is found by id with plain bounds** (`received_at >= …` and `<= …`, from two immutable helpers), and a test checks the plan touches at most two partitions. Added after review. | PostgreSQL 16 prunes partitions only with ordering operators, not `<@`. ALL-SCALING-07. |
| P4-D33 | **Old finished rows are given a resolution, then the strict check is added**: `MATCH_DEFAULT` → `SINGLE_OWNER`, `MATCH` → `SCHEDULE_UNIQUE`. Added after review. | A plain check cannot exempt older rows; development data only. P4-RESOLUTION-11. |
| P4-D34 | **A partial unique index is named `<table>_<rule>_unique_index`**, a new rule in `docs/conventions.md`; the report table's unique constraint becomes `recognition_reports_recognition_id_unique`. Added after review. | Unique constraints cannot be partial, and the conventions had no name for these. ALL-DATABASE-NAMING-08, -11; ALL-NAMING-10. |
| P4-D35 | **The phone walkthrough's tunnel answers only the listener routes** (an ngrok traffic policy), and is started only once the user confirms the ngrok token pasted in chat was rotated. Added after review. | Review finding: set-up B otherwise puts the portal sign-in and admin routes on the internet. ALL-SECURITY-01. |
| P4-D36 | **The behaviours of §8.4 become checklist-2 items before Piece 2.** Added after review. | ALL-CHECKLIST-06. |
| P4-D37 | **Deferrals the user must see** (Q13): retention of recognitions, candidates, engagements and reports goes to P8 with O7 and the data-protection review (nothing is detached in P4); how picture addresses stay valid for saved History entries and replays is decided with the picture screens (logos stay `null` until then, S3-D21); crash reports stay logged only, never stored in a table. Added after review. | Checklist-2 gaps 8 and 37, checklist-5 gap 9, checklist-3 gap 46; ALL-CHECKLIST-05. |
| P4-ENGAGEMENTS-13 | A tap on a chooser with no choice yet records that station as the choice; a later tap or choice for another station gets 422 `STATION_ALREADY_CHOSEN`. | P4-D12 (A4) | `engagements-route`, `station-choice-route` | 5 |
| P4-ENGAGEMENTS-14 | One install counts at most the configured number of taps per campaign in 24 hours (if Q12 is approved). | P4-D10 | `engagements-route` *Amended after review:* one install counts at most `ENGAGEMENTS_COUNTED_PER_INSTALL_PER_CAMPAIGN_PER_DAY` taps per campaign in 24 hours (5 recommended, Q12; a setting, so the answer needs no migration); further taps are stored, not counted. A4 makes a tap on an unanswered chooser the choice. The remaining risk, many installs, is an open security-baseline row until device integrity in P8. | 5 Review finding: free installs and up to four chooser stations per answer let one phone use up a campaign's limit. |
| P4-DATABASE-04 | The API role reads `recognition_events` only through column grants that leave out the install, the hint, the idempotency key, the phone's capture time and the clock skew. | P4-D30 | `database-privileges` | 2 |
| P4-DATABASE-05 | Engagements carry no foreign key to recognitions; a month of recognitions can be detached while later taps name it. | P4-D11 (A8) | `database-scaling` | 2 |
| P4-DATABASE-06 | A lookup of a recognition by id reads at most two monthly partitions. | P4-D32 | `station-resolution-database` | 2 |
| P4-STATIONLIST-01 | `GET /stations` answers with a strong ETag and `Cache-Control: private, max-age=86400`, and 304 for a matching `If-None-Match`; every other listener route keeps `no-store`. | P4-D17 | `listener-station-list-route` | 3 |
| P4-UPDATEGATE-01 | Every install-token route answers 426 `APP_UPDATE_REQUIRED` for a registered version below the configured minimum; `/installs` and `/client-errors` never do. | P4-D16 | `listener-app-version-gate` | 4 |
| P4-INSTALLS-01 | A re-registration with the install's own valid token is counted per install (5 a day), not per address. | P4-D31 (A3) | `listener-install-reregistration` | 4 |
| P4-REPORTS-01 | "Report this" (if approved): one report per recognition, four fixed reasons, no free text, a keyed hash of the install, readable only by super admins. | P4-D28 | `recognition-reports-route`, `database-privileges` *Amended after review:* each report stores the keyed hash of the install (the logs' `actor`), readable only by super admins. | 4 Review finding: without it, 500 reports from one phone look like 500 listeners once months of recognitions are detached. |
| P4-TOOLS-01 | The walkthrough scripts refuse to run unless the database is on this machine and `NODE_ENV` is not `production`, and print no install id, token, card content or phone number. | P4-D25 | `development-scripts` (a new test) | 2 |

Checked against the ALL rules, these need no new item: the hashed `actor` (ALL-LOGGING-01, -03), the
cross-site check per route (ALL-SECURITY-09), the naming of partial unique indexes (ALL-NAMING-10).

---

## 9. Decisions

| # | Decision | Why |
|---|---|---|
| P4-D1 | **Five pieces, in the order of §7.** The P4 gate part 1 work is spread over Pieces 2–4, each paired with the P6 app work that makes it visible; gate part 2 is Piece 5. P4-DELIVERY-03 is recorded as superseded by the user's reorder of 10 October 2026; P4-DELIVERY-04 and P6-SCOPE-01 hold. *Amended after review:* P4-IDEMPOTENCY-20, P4-DELIVERY-02 and -04 can only be ticked in Piece 5, so gate part 1 is recorded at the end of Piece 4 only if the user moves them to part 2 (Q11); otherwise part 1 is recorded with part 2. | Checklist conflict 16 split the gate; the user checks every piece by a walkthrough, and a server rule with no screen cannot be walked through. Gap 1. Review finding: as first written, gate part 1 could not pass. |
| P4-D2 | **One migration, `1791600000000-StationResolution`, written whole in Piece 2**, including the engagement, counter and report tables used only in Piece 5. The Step 3 functions `find_stations_for_audio`, `finish_recognition`, `describe_recognition` and `app.create_recognition_event_partitions` are replaced by drop and create inside it; no old migration is edited. `claim_recognition` stays as it is. | Released migrations are checksum-pinned and never edited (ALL-MIGRATIONS-01); a second migration would be needed if Piece 5's tables waited. Keeping the claim untouched keeps its ticked evidence. Gap 35. |
| P4-D3 | **Grace widens each time window on both sides, never the active period**, computed exactly from the slots (§4.3); grace is limited to 0–60 minutes; the portal's wording changes to "before and after". Waits on Q1. | Conflict 8 chose the plan's ± grace; three points on a slot would miss a short window inside the grace; stations must be told the rule the server applies. Gap 22. |
| P4-D4 | **An owner** is a station that is ACTIVE when the clip is processed, with a non-archived ad on the recording and a campaign that is ACTIVE, or PAUSED or ENDED after the capture (`status_changed_at`, which shows the client's default card, O13). A station's campaigns fold into one candidate. A station that is not ACTIVE shows nothing, in every branch. Waits on Q3. | Without a status time the server cannot tell "paused after the listener heard it" from "paused long ago". The seed already has one station with two campaigns on one recording. The baseline wins over "default card for a station no longer active". Gaps 23, 24. |
| P4-D5 | **Receipt-time facts are read when the clip is processed**; a re-claim reads them at the retry, keeping the first `received_at`. No status or card-version history is built. *Amended after review:* this departs from P4-IDEMPOTENCY-16's words ("judged at the first receipt time"), so the item waits on Q9 and is never ticked on the `received_at` assertion alone. | A retry comes seconds or hours later; a history table for each would cost more than the difference is worth. Gap 23; P4-IDEMPOTENCY-16. ALL-CHECKLIST-05: a deviation needs the user's answer. |
| P4-D6 | **The resolution order and values of §5.1**: candidates, schedule, hint, limits. A station that can show no card is not offered. `SINGLE_OWNER` means only one station can answer (with a fallback reason when others own the ad but have no card); `SCHEDULE_UNIQUE`, `HINT`, `UNRESOLVED` and `LISTENER_CHOICE` as in the plan; outcomes without a station hold NULL. | Every case now maps to one value, and limits change only which card is shown. Gaps 25, 27. |
| P4-D7 | **Chooser size and order:** at most 4. On air: the slot that started last first. None on air: the slot that ended last within 7 days first (none: last). Ties by `lower(name)`, then id. The app never reorders. Waits on Q4. | "Most recently aired" needs a definition without air-play data, and a stable order makes replays identical. Gaps 18, 26. |
| P4-D8 | **Candidate rows** are written for a chooser (the shown stations, with positions) and for a hint decision (every station that could have answered, without positions); single-station outcomes write none. The table is partitioned on the recognition's `received_at`. *Amended after review:* a row is written for every station that owns the recording and can show a card, whatever the outcome (one row for a single owner), with positions only for the stations a chooser shows. | The rows hold what analytics needs ("possible") and what replays and the choice need, without doubling the writes of the common one-station case. Gap 47; G12. Review finding: P4-RESOLUTION-12 asks for one row per candidate station, and P7's "possible" counts need the owners that did not answer; one small row per station is cheap. |
| P4-D9 | **The hint** is stored when its station exists and used only when it names a station that can answer; any other hint is ignored, never refused. *Amended after review:* a hint naming an unlisted station is used like any other when that station is a candidate (Correction 3); listing decides only what `GET /stations` shows. | A remembered "My station" can go stale; a foreign key on an unknown id would otherwise be a 500. P4-RESOLUTION-08, -10. Review finding: the contract ignored hints for unlisted stations while the chooser could offer them, so "Remember my station" would not have worked for their listeners. |
| P4-D10 | **Tap limits are counted at the tap**, once per distinct tap, only for campaign cards, by one atomic statement; a recognition reads whether the limit is reached and then shows the default card. A tap past the limit is stored, not counted, and answered 204. Waits on Q2. | The race test counts taps; O4 says "deduplicated engagements"; reserving at every recognition would use the limit up on listeners who never tap. Gaps 28, 31. |
| P4-D11 | **Engagement storage:** partitioned on arrival (`received_at`); the phone's time corrected by `sent_at` and clamped; no install column; the deduplication keys removed together with their recognition's month. *Amended after review* (A8): no foreign key from `engagement_events` to `recognition_events`; `record_engagement` checks the recognition itself. Candidates keep theirs; their detached month's foreign key is dropped before the events month is detached (§4.6). | The clamped time is not an arrival time; the correction mirrors O11; keys must live as long as a tap can be accepted. Gaps 31, 47; ALL-SCALING-08. Review finding: taps arrive up to 30 days after their recognition, so the foreign key would have blocked detaching old months of recognitions. |
| P4-D12 | **Choice rules:** same install only (others 404); the first choice wins (another station 422); no time limit; no cancel request; no counter moves. *Amended after review* (A4): a tap on a chooser with no choice yet records that station as the choice under the same row lock; a later tap or choice for another station gets 422 `STATION_ALREADY_CHOSEN`, and a report does the same. | The outbox needs "drop" or "retry" for each answer; a deferred chooser can be answered hours later. Gaps 28, 30. Review finding: one chooser answer could otherwise count taps for up to four stations. |
| P4-D13 | **Replays:** a station no longer ACTIVE is withheld (a `MATCH` becomes `NO_MATCH` with the same id; a chooser loses it); `INVALID_AUDIO` stays 400; a chooser replays identically even after a choice. | "A suspended station's card is never returned" outranks "replay the stored result"; the app treats 400 `INVALID_AUDIO` as final either way. Gap 13; P4-RESOLUTION-14. |
| P4-D14 | **The deferred allowance** is chosen by the `is_deferred` field, counted after the text fields and before the audio; held keys under 5 attempts are not counted; invalid fields count as live; an audio part before the fields is refused. | The flag is unknown when the body has not been read; automatic retries after Busy must not lock a listener out. Gap 21. |
| P4-D15 | **Deferred clips are shed first and wait longer:** depth threshold 20, a random `Retry-After` of 60–300 on every 503 after the fields, BullMQ priority 10, a 5-second deadline and wait; the depth counts waiting and prioritised jobs. | The plan's step 4–6 values; BullMQ 6.3.11's waiting count leaves prioritised jobs out (fact 9). Gap 18. |
| P4-D16 | **The update gate uses the version stored at registration**; the guard answers 426 on every install-token route; registration and crash reports never answer 426; the minimum defaults to `0.0.0`. No card `min_app_version` field: P6-COMPATIBILITY-03 is met by this gate plus the reader's `schema_version` rule. | The guard already reads the install row; no header is added to every request. Gaps 32 and 37 (part 3). |
| P4-D17 | **The station list** is install-token only, lists listed ACTIVE stations with their city, sorted, at most 1,000, with no paging, a strong ETag and `Cache-Control: private, max-age=86400` as the one exception to `no-store`. | The app caches it for 24 hours; 1,000 stations is far above Zambia's count. Gaps 7, 33. |
| P4-D18 | **`clock_skew_milliseconds` becomes `bigint`**, so the skew is always stored exactly. *Amended after review:* written through the recreated `claim_recognition` (P4-D2); `clip-checks.ts` never stores NULL. | Removes the NULL case of P4-CLOCK-04 at no cost. The column alone could not hold what its writer could not pass. |
| P4-D19 | **Scheduled jobs run through `runJob`**; idempotency keys are cleaned daily after 48 hours, in batches; one function tops up the partitions of the three listener-traffic tables. | ALL-JOBS-01, -02; captures over 24 hours are refused before the claim, so 48 hours is safe; ALL-SCALING-07. Gap 37. |
| P4-D20 | **The default-card route is built now; its portal control waits for P5B**; the seed sets default cards for the walkthroughs. | P4-FALLBACK-04 needs an API route; the user asked for the listener app first. |
| P4-D21 | **No out-of-window policy column.** P4-RESOLUTION-15 is retired with this reason, recorded in ADR-003. Waits on Q5. | O3 fixes one behaviour and no other value exists. Gap 29. |
| P4-D22 | **The k6 load tests and the final deferred numbers move to the P8 load tests on Render**; the plan's example numbers are the configured defaults until then. *Amended after review:* a phase-home change the user must see: it waits on Q10, and P4-DEFERRED-11, P4-TESTS-06 and -07 stay open at the P4 gates only once the user has seen it. | k6 is a download, no target rate or latency is given, and this 4-processor machine cannot stand in for Render. Gaps 2, 18; O14. Checklist-2 gaps 1 and 2; ALL-CHECKLIST-05. |
| P4-D23 | **Property tests use a seeded generator written in the test**, compared with a plain reference. | No new package (fast-check is not installed); a printed seed makes a failure repeatable. P4-TESTS-05. |
| P4-D24 | **Safe sample data:** `+447700900NNN` and `https://example.com/` in every new and edited fixture, test and the seed; the other files wait for the sweep. Waits on Q7. | The user asked whose the sample numbers are; no reserved fictional range is known for Zambia. |
| P4-D25 | **Walkthrough tools are development-only scripts** that refuse to run against anything but this machine and print plain words without identifiers or numbers. | Pausing and suspending have no screens until P5B and 5a, and the user checks every piece live. |
| P4-D26 | **Logs of the new routes** hold outcome codes and the request id, never the install, the token, the hint's value, card contents or bodies. *Amended after review:* `InstallTokenGuard` puts a keyed hash of the install on every line of a listener request as `actor`; error lines carry it too. | Card contents hold business phone numbers; the hint plus a time is a listening habit. Gap 38; ALL-LOGGING-02. ALL-LOGGING-01 requires a hashed actor on every error line; only `SignedInGuard` set one. |
| P4-D27 | **The database checks the station's city** (NULL or 1–80 characters). | The city now reaches every listener's phone; a longer one would make an answer fail its own contract check. |
| P4-D28 | **"Report this"**, if approved: one report per recognition, four fixed reasons, no free text, no listener identity, read only by super admins. Waits on Q6. | Every result must carry the link (G15); free text would invite personal data. Gap 5. |
| P4-D29 | **Follow-up requests** (choice, taps, reports) share one per-install allowance of 60 a minute, answer 204 with no body, use 404 and 422 for permanent refusals and keep 409 for "in progress" only. | One rule for the outbox on every route ("409 means wait"). Gaps 30, 31, 43 (part 3). |

---

## 10. Questions only the user can answer

Each has a recommended answer. The build goes ahead on the recommendation unless the user says
otherwise, and the decision it changes is named. *Amended after review:* each question now names the
checklist items that depend on it; Q9 to Q14 are new; **Q6, Q7 and Q14 are needed before Piece 1**.
Three questions are shared with the P6 design and must get one answer in both: Q6 (its Q6), Q8 (its
Q15, and the default-card note of A7) and Q14 (its Q16); Q7 matches its Q13.

1. **Grace period: both sides of a slot, or only after it?** *(Needed before Piece 2; P4-D3.)*
   The plan says the buttons keep working "± grace" around each slot. The portal tells stations "Keep
   giving the buttons after a slot ends".
   **Recommended:** both sides, as the plan says. A listener whose clock or radio delay puts them a few
   minutes early still gets the buttons. The portal's wording changes at the same time to "Keep giving
   the buttons before and after each slot".
   *Depends on it:* P4-RESOLUTION-02, -03, P4-TESTS-04, P4-TIMERULE-02.

2. **What does a tap limit count, and when does it stop the campaign's buttons?** *(Needed before
   Piece 2; P4-D10.)*
   **Recommended:** count each distinct button tap once (the same tap sent again counts once), only on
   the campaign's own buttons, at the moment of the tap. When a listener identifies the ad and the
   limit is already reached, show the client's usual buttons instead. Taps on the usual buttons are
   stored for analytics but never counted. A tap past the limit is stored, marked "not counted", and the
   phone is told "done" so it stops resending. This rewords P4-LIMITS-05 ("reserved at the receipt
   time") and P4-IDEMPOTENCY-20 ("counters incremented once"): a recognition moves no counter.
   *Depends on it:* P4-LIMITS-02 to -06, P4-TIMERULE-04, P4-IDEMPOTENCY-09, -20.

3. **May campaigns get a "status changed at" time?** *(Needed before Piece 2; P4-D4.)*
   A clip heard while a campaign was live may arrive after the station paused it. Today such a
   listener gets "no match".
   **Recommended:** yes. A campaign paused or ended *after* the clip was heard shows the client's usual
   buttons; one paused before it is not a candidate at all.
   *Depends on it:* P4-TIMERULE-06, and the new P4-TIMERULE-09.

4. **Which stations does the "Which station?" sheet show, and in what order?** *(Needed before Piece 2;
   P4-D7.)*
   **Recommended:** at most 4. When several stations have the ad on air: the station whose current slot
   started most recently first. When none has it on air: the station whose last slot ended most
   recently first (looking back 7 days). Ties in name order. Stations with no buttons to show are left
   out; if only one is left, its buttons are shown without the sheet.
   *Depends on it:* P4-FALLBACK-03, P4-CHOOSER-02, P4-RESOLUTION-07.

5. **Drop the "out-of-window policy" column from the plan?** *(Needed before Piece 2; P4-D21.)*
   The plan's data model gives campaigns such a column, but O3 fixes one behaviour (the client's usual
   buttons) and no other choice exists.
   **Recommended:** drop it and retire P4-RESOLUTION-15, with the reason in ADR-003.
   *Depends on it:* P4-RESOLUTION-15.

6. **What should "Report this" do?** *(Needed before Piece 1, because the shared contract's report
   schemas and fixtures are written there, and its table is in Piece 2's migration; P4-D28. The same
   question as the P6 design's Q6.)*
   **Recommended:** a small sheet with four fixed reasons — wrong or misleading buttons, a number or
   link that doesn't work, it looks like a scam, something else — and no free text (the sheet's exact
   words are in the P6 design). One report per phone per result, stored with the station and an
   anonymous code for the phone (a keyed hash, never the install id), for super admins to read in the
   5a console, so many reports from one phone can be told apart from many listeners. No station sees
   the code. If declined, the "Report this" link needs another answer before the P6 gate.
   *Depends on it:* P6-RESULT-04, -05, the new P4-REPORTS-01.

7. **Which phone numbers may sample data use?** *(Needed before Piece 1; P4-D24. Matches the P6
   design's Q13.)*
   **Recommended:** `+44 7700 900 001` to `900 999` (Ofcom's drama range, never given to any phone
   company) in every new and edited fixture, test and the seed. And yes to a separate, mechanical change
   replacing the remaining realistic numbers in 45 fixture files and 49 source, test and script
   files (recounted after review: in every written form, local and grouped forms included), with the
   full test suites run afterwards. That includes the portal's phone-number hint, which every station
   user sees: it becomes a pattern with no real digits ("Like 09XX XXX XXX"). `+260` stays only in the
   tests of how a Zambian number is displayed. Five documents also quote the old numbers; they are
   changed in the same sweep.
   *Depends on it:* ALL-DECISIONS-03 for the sweep; the fixtures of contract §2.6.

8. **Two sentences on the listener's screens.** *(Needed before Piece 3; shared with the P6 design's
   Q15 and A7.)*
   - When the "Which station?" sheet offers only the stations' usual buttons (none has the ad on air),
     the wireframe's "This ad is on more than one station right now." is not true.
     **Recommended:** "This ad is played on more than one station."
   - The usual-buttons note said "This ad isn't on air right now, so these are [client name]'s usual
     contact details." From P4 the usual buttons also appear when a campaign reached its tap limit or
     was paused, while the ad may still be on air. A7 already replaces it.
     **Recommended:** keep A7's "These are [client name]'s usual contact details." for every case.
   *Depends on it:* P4-FALLBACK-02 (app half), P4-LIMITS-05, P4-TIMERULE-06 (what the listener reads).

9. **May P4-IDEMPOTENCY-16 be reworded to what is built?** *(Added after review. Needed before Piece 2,
   where it would be ticked; P4-D5.)*
   The item says a retry keeps the first receipt time "so limits, statuses and card version are still
   judged at the first receipt time". The design keeps the first receipt time and the first capture
   time, but reads the station's and the campaign's status, the tap limit and the card version when the
   retry is processed: nothing keeps a history of statuses or card versions.
   **Recommended:** reword it to "A re-claim keeps the first `received_at` and `captured_at`; station
   and campaign status, the tap limit and the card version are read when the attempt is processed." A
   retry comes seconds or hours later, and a status and card-version history would cost more than the
   difference is worth; the receipt-time rules for deferred clips (P4-TIMERULE-04 to -07) are unchanged.
   If you want the history, it is a larger change to Piece 2.
   *Depends on it:* P4-IDEMPOTENCY-16 (never ticked before the answer).

10. **May the k6 load tests and the final deferred numbers move to P8?** *(Added after review. Needed
    before the gate part 1 record at the end of Piece 4; P4-D22.)*
    The plan asks for a k6 run at a target rate and p95 latency in this phase, but gives no target, k6
    is a download, and this 4-processor machine cannot stand in for Render.
    **Recommended:** move them to the P8 load tests on Render. Until then the plan's example numbers
    stay the configured defaults (deferred 10 an hour, depth 20 against 50, `Retry-After` 60–300,
    5 seconds). Either give a target rate and p95 now, or set them at the start of P8.
    *Depends on it:* P4-DEFERRED-11, P4-TESTS-06, -07 (deferred with this reason once you have seen it).

11. **May three items move from gate part 1 to gate part 2?** *(Added after review. Needed before the
    gate part 1 record at the end of Piece 4; P4-D1.)*
    Gate part 1 needs every P4 item outside tap limits and taps ticked. Three can only be ticked once
    taps exist: P4-IDEMPOTENCY-20 (a replay moves counters once, and counters move only at a tap),
    P4-DELIVERY-02 (the engagements module) and P4-DELIVERY-04 (taps built after the chooser and the
    outbox, checked in the commit order).
    **Recommended:** widen P4-RESOLUTION-17 (gate part 2) to these three, and record that in checklist
    part 2 before Piece 4's gate. P4-IDEMPOTENCY-09 (a replay leaves counters alone) is ticked in
    Piece 4 already. If declined, gate part 1 is recorded together with part 2 at the end of Piece 5.
    *Depends on it:* P4-RESOLUTION-16, -17, P4-IDEMPOTENCY-20, P4-DELIVERY-02, -04.

12. **May one phone count only a few taps per campaign per day?** *(Added after review. Needed before
    Piece 5; P4-D10.)*
    Installs cost nothing to make, and one install may identify about 300 times a day, so one phone
    could use up a campaign's tap limit, and everyone would then get the usual buttons: something a
    competitor could do on purpose.
    **Recommended:** yes: at most **5 counted taps per phone, per campaign, in 24 hours**. Further taps
    are still stored and answered "done", just not counted. It is a setting, so the number can change
    without a new migration. Many phones from many addresses remain a risk, recorded in the security
    baseline, until device checks (Play Integrity) arrive in P8.
    *Depends on it:* P4-LIMITS-02, -06 (the race test runs with the cap off), the new P4-ENGAGEMENTS-14.

13. **Three more things to decide later, or now?** *(Added after review. Needed before the gate part 1
    record at the end of Piece 4; P4-D37.)*
    - **How long recognitions, candidates, taps and reports are kept.** **Recommended:** decide in P8
      with O7 and the data-protection review; nothing is deleted or detached in P4.
    - **How picture addresses stay valid** for saved History entries and replays, once stations can
      upload logos and banners. **Recommended:** decide with the picture screens; addresses must then
      be stable or re-signed. Logos stay empty until then.
    - **Crash reports from the app.** **Recommended:** keep them logged only (as Step 4 built), never
      stored in a table.
    *Depends on it:* checklist-2 gaps 8 and 37, checklist-5 gap 9, checklist-3 gap 46; P4-DATABASE-03's
    "old months detached" (the runbook exists, nothing runs it yet).

14. **May each button tap carry the time it was sent (`sent_at`) as well as the time it happened?**
    *(Added after review. Needed before Piece 1, where the tap body's schema and fixtures are written;
    the same question as the P6 design's Q16.)*
    **Recommended:** yes. The server corrects a wrong phone clock the same way it does for clips, before
    clamping the time to the recognition's receipt and the present. If declined, the field and the
    correction are dropped from both sides together.
    *Depends on it:* P4-ENGAGEMENTS-01, -03, -04 (and contract §5 point 4).

---

## The user's answers (11 October 2026)

- **Every recommended answer is accepted**, as presented to the user in one list of 29 (the server design's Q1–Q14 and the app design's Q1–Q20, with the four shared questions asked once). Each is decided as this design recommends it; a checklist item that one of them rewords is changed in the checklist, with this date as its source, before it is ticked.
- **Download approved:** `workmanager` 0.10.10 with its Android libraries (3,174,229 bytes, at most 3,262,830), for sending saved clips with the app closed. It is downloaded when the P6 design's piece 3 starts, not before.
- **The ngrok token pasted in chat on 10 October 2026 is not rotated yet.** The tunnel stays off, and no phone walkthrough (set-up B) starts, until the user confirms it is rotated and has added the new token in their own terminal.
- **The ngrok token (11 October 2026, later the same day):** the user chose to keep using the token pasted in chat on 10 October, "as long as it's working", instead of rotating it first. Set-up B may start with it; the traffic policy and the rule that the portal is never tunnelled still apply.
