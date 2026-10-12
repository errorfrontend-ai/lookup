# ADR-003: Shared audio assets and station resolution

- **Status:** Accepted (built in phase 4, Piece 2; the routes that use it follow in Pieces 3 to 5)
- **Date:** 11 October 2026
- **Deciders:** the project owner (the master plan's D7; the answers of 11 October 2026 to the P4 design's
  questions), with the P4 design (`docs/design/phase-4-station-resolution-and-engagements.md`)

## Context

Several Zambian stations air the same advert: a national brand books one recording on many stations. A
listener's clip is matched against the fingerprints of recordings, not of stations, so a match tells us which
recording was heard, never which station played it. Step 3 answered only when exactly one station could have
aired it, and "no match" otherwise. Phase 4 has to decide whose buttons a listener gets when several stations
own the recording, without guessing, and has to keep doing so when the clip reaches the server hours after it
was heard (offline capture), when a campaign changes in between, and when the listener taps a button days later.

Facts that shape the design:

- Air-play monitoring (knowing what each station is playing right now) does not exist until phase 9.
- A clip can be heard in one moment and processed hours later; the phone's clock can be wrong (O11).
- No history of station statuses, campaign statuses or card versions is kept.
- The busiest tables are partitioned by month, and old months must stay detachable whole.
- PostgreSQL 16 prunes partitions only with a partition key's ordering operators (`=`, `<`, `<=`, `>=`, `>`).

## Decision

1. **One recording, many owners (D7).** A recording (`fingerprints.audio_assets`) names no station. Each
   station's ad points at it, and the link is set only by the ingest worker's function, so a station can never
   attach its buttons to another station's audio (ADR-002). A station *owns* a matched recording when it is
   ACTIVE when the clip is processed, has a non-archived ad on the recording, and has a campaign for it that is
   ACTIVE, or PAUSED or ENDED after the clip was heard (`campaigns.status_changed_at`, which only the database
   sets). An owner's campaign that was paused or ended after the clip was heard shows the client's default card
   (O13). Being listed in the app decides only whether a station appears in the "My station" list: an unlisted
   station is an owner like any other.
2. **On air with grace.** A clip heard at local moment *m* is on air in a campaign when the campaign's period
   `[start, end)` contains the capture moment and some slot of one of its weekly windows, `[slot start, slot
   end)`, has `slot start − grace ≤ m < slot end + grace`. Grace widens each slot on **both sides** (the user's
   answer to Q1), never the period, and is 0 to 60 minutes (10 by default; the portal offers 0, 5, 10 and 20).
   The rule has one home, `app.list_time_window_slots_on_air`; `app.is_time_window_open_with_grace` and
   `recognition.find_station_candidates` both read it, and with a grace of 0 it equals `app.is_time_window_open`,
   which the portal's "Live now" badge keeps using. Times are compared in the station's own wall-clock time.
   Zambia has no daylight saving; a station elsewhere could be an hour out on the night its clocks change (gap 22).
3. **Which time decides what.** The moment the clip was heard (corrected by the phone's clock skew) decides the
   window, the period and the set of owners. The moment the clip is processed decides the station's status, the
   campaign's status, the tap limit and the card version. A retry of the same key keeps the first receipt and
   capture times, and reads the statuses, the limit and the card version when it is processed (the user's answer
   to Q9; P4-IDEMPOTENCY-16 reworded).
4. **Resolution, in the plan's order: candidates, schedule, hint, limits.** Each owner becomes one candidate:
   a station's several campaigns on the recording fold into the one in window whose slot started last, else the
   one whose slot ended last within 7 days, else the latest period start not after the capture, else the first
   to start, then the campaign id (each rule breaking the ties of the one before). Its card is the campaign's card when the campaign is in window, ACTIVE, below
   its tap limit and has a card; otherwise the client's default card; a station with no card to show is no
   candidate. With *S* the candidates and *W* those in window:

   | Case | Answer | Resolution stored |
   |---|---|---|
   | *S* is empty | `NO_MATCH` | none |
   | one station in *S* | `MATCH` (`MATCH_DEFAULT` for a default card) | `SINGLE_OWNER` |
   | several in *S*, exactly one in *W* | `MATCH` | `SCHEDULE_UNIQUE` |
   | several in *W*, the listener's hint among them | `MATCH` | `HINT` |
   | several in *W*, no usable hint | `CHOOSE_STATION` | `UNRESOLVED`, `LISTENER_CHOICE` once chosen |
   | *W* empty, the hint in *S* | `MATCH_DEFAULT` | `HINT` |
   | *W* empty, several in *S*, no usable hint | `CHOOSE_STATION` of default cards | `UNRESOLVED`, then `LISTENER_CHOICE` |

   The server never guesses between stations on air: without a usable hint it asks. A hint is used only when it
   names a candidate (of *W*, or of *S* when none is on air), listed or not; any other hint is ignored silently,
   and stored only when its station exists. The database refuses a resolution that does not fit the outcome
   (`recognition_events_resolution_outcome_check`).
5. **The chooser.** At most 4 stations (the user's answer to Q4). On air: the slot that started last first. None
   on air: the slot that ended last within 7 days first (none in those days: last). Ties by `lower(name)`, then
   id. The app never reorders. Every candidate's card travels inline, so a choice made with no signal shows its
   buttons at once. When every shown station offers only its default card, the sheet says "This ad is played on
   more than one station." (the user's answer to Q8).
6. **Candidates are kept.** `app.recognition_candidates` holds a row for every station of *S*, whatever the
   outcome, with the card version it would show, whether it was in window, its place in a chooser, and the
   listener's choice. It is partitioned by month on the **recognition's** receipt time (`recognition_received_at`),
   so a month of candidates belongs to a month of recognitions, and keeps its foreign key to them. A station sees
   only its own candidate rows, so it never learns which other stations were offered.
7. **Replays.** A finished recognition is answered again from what was stored: the same id, status, card version
   and, for a chooser, the same stations in the same order, also after the choice. A station suspended since is
   left out: a match becomes `NO_MATCH` with the same id, and a chooser loses it (one left gives a `MATCH`, none a
   `NO_MATCH`). `INVALID_AUDIO` stays 400.
8. **The choice.** One station per recognition: the first choice wins, the same station again changes nothing,
   another one gets 422 `STATION_ALREADY_CHOSEN`. There is no time limit and no cancel request. A tap on a chooser
   nobody has answered records that station as the choice, under the same row lock (A4), so one chooser answer
   can never count taps for several stations.
9. **Tap limits at the tap** (the user's answer to Q2). A campaign's limit counts distinct taps on its own card
   (one per recognition and action), when the tap arrives, in one atomic statement with the limit in its `WHERE`
   clause. A recognition moves no counter; a recognition processed when the limit is reached shows the client's
   default card. Taps on default cards, and taps past the limit, are stored and never counted, and every tap is
   answered alike. One install counts at most 5 taps per campaign in 24 hours (a setting; the user's answer to
   Q12); many installs from many addresses stay an open risk until device integrity is checked in P8.
10. **Taps name their recognition without a foreign key (A8).** `app.engagement_events` is partitioned by month
    on the tap's own arrival (`received_at`); a tap arrives up to 30 days after its recognition, so a foreign key
    would stop old months of recognitions from being detached. The function that records a tap checks the
    recognition itself. One tap per (recognition, action) holds across months in the small unpartitioned
    `app.engagement_deduplication_keys`. Reports ("Report this", approved) hold no foreign key either, and keep
    only the API's keyed hash of the install, readable by super admins alone.
11. **A recognition is found by its id, between bounds from the id.** The API makes a recognition's UUID version 7
    id once the clip is read, so its receipt time lies within a minute before the id's own time. Two immutable
    helpers bound it from 5 minutes before to 1 minute after, and every lookup is written
    `received_at >= earliest AND received_at <= latest`, so it reads one or two monthly partitions; a range test
    (`<@`) would read them all.
12. **No out-of-window policy column** (the user's answer to Q5). O3 fixes one behaviour, the client's default card,
    and no other value exists, so campaigns get no such column and P4-RESOLUTION-15 is retired.

## Detaching an old month (the runbook)

Nothing is detached in P4: how long recognitions, candidates, taps and reports are kept is decided in P8 with O7
and the data-protection review (the user's answer to Q13). When it is, month *N* goes in this order, as the schema
owner:

1. Detach `recognition_candidates` month *N*
   (`ALTER TABLE app.recognition_candidates DETACH PARTITION app.recognition_candidates_YYYY_MM`).
2. Archive and drop that table, or drop its foreign key to recognitions
   (`ALTER TABLE app.recognition_candidates_YYYY_MM DROP CONSTRAINT recognition_candidates_recognition_foreign_key`).
   PostgreSQL keeps the key on a detached partition as a constraint of its own, and it would block step 3.
3. Detach `recognition_events` month *N*. Detaching it first is refused while candidates still refer to it.
4. In the same step, delete the tap keys of that month of recognitions
   (`DELETE FROM app.engagement_deduplication_keys WHERE recognition_received_at` in month *N*): a key lives exactly
   as long as a tap on its recognition can be accepted.

Taps (`engagement_events`) and reports are detached or deleted on their own schedule: a tap of month *N + 1* that
names a recognition of month *N* never blocks step 3. A partition of `recognition_events` cannot be dropped while
attached, because candidates hold a foreign key on each month; detach it first.

## Consequences

- A listener of a station whose ad is shared still gets that station's buttons when it is the only one on air, or
  when "My station" names it; otherwise one tap on the chooser. Nothing is guessed.
- A clip heard on air and sent hours later is judged where it was heard, but never shows a station suspended since,
  a campaign card past its limit, or an old card version.
- Stations learn nothing about each other or about listeners: candidates, taps and counters are row-level-security
  isolated, and the API role cannot read a recognition's install, hint, idempotency key, phone capture time or clock
  skew (P4-D30).
- The tables that grow with listener traffic are detachable by month; a month of candidates goes with its month of
  recognitions, by the runbook above.
- What phase 7's analytics count ("resolved" and "possible", taps per button) is already stored.

## How it is proven

| Rule | Test |
|---|---|
| Grace on both sides, midnight, every ISO day, boundary instants, period not widened | `apps/api/test/time-windows-with-grace-database.test.ts` |
| The window rule against a reference over 1,000 seeded cases | `apps/api/test/time-windows-property.test.ts` |
| Owners, paused after the capture, slots that started and ended last, limits, cities, finishing with resolution, hint and candidates, replays, the recreated claim, lookups by id, the tables' own checks | `apps/api/test/station-resolution-database.test.ts` |
| Which time decides each of the six facts, in the database and through `resolveStation` | `apps/api/test/time-rule-split.test.ts` |
| The choice, the station list, taps and their limits, reports, the key clean-up | `apps/api/test/listener-follow-ups-database.test.ts` |
| Grants, definer functions, column grants on recognitions | `apps/api/test/database-privileges.test.ts` |
| Station isolation of candidates, choices, taps and counters | `apps/api/test/station-isolation.test.ts`, `apps/api/test/station-isolation-matrix.test.ts` |
| Partitions, the detach order with a later tap (A8) | `apps/api/test/database-scaling.test.ts` |
| Names, policies, no foreign key from taps to recognitions | `apps/api/test/database-catalogue.test.ts` |
| The migration up and down, and the backfill before the strict check | `apps/api/test/station-resolution-migration.test.ts` |
| Whose buttons, table by table and with no database: one candidate per station, its card, the seven cases, the chooser's order and size | `apps/api/test/station-resolution-rules.test.ts` |
| The same through `POST /api/v1/recognize`: the schedule, the hint (unlisted stations included), choosers, usual cards, suspended stations in every branch, a campaign paused after the clip was heard, cities | `apps/api/test/recognize-station-resolution.test.ts` |
| Replays: the same id, status, cards and order, a chooser after its choice, stations suspended since left out; a retry resolved at the first capture time and kept deferred | `apps/api/test/recognize-replays.test.ts` |
| Setting and clearing a client's usual card (owners and managers, that client's cards only, audited) | `apps/api/test/client-default-card-route.test.ts` |
