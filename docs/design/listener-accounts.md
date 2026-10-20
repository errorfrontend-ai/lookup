# Listener accounts: design

Status: draft for build, 20 October 2026. Decision: [ADR-005](../adr/ADR-005-listener-accounts.md). Requirements:
[checklist 6](../requirements/checklist-6-listener-accounts.md) (`LA-…`). The approved plan is in the owner's plan
file (`so-our-platform-does-luminous-stonebraker.md`).

## 1. What the code does today (facts checked on 20 October 2026)

1. The listener app is Flutter (`apps/mobile`). It has one flow, **Tap to identify**, plus History and Settings. There is
   no search page and no screen that lists ads (S4-SCOPE-06).
2. A listener is an **install**: a random id the app makes, registered with `POST /api/v1/installs`, which stores only a
   keyed hash in `app.listener_installs` and returns a 30-day install token. `InstallTokenGuard` is the single place
   every listener route learns who is calling (and applies the 426 update gate).
3. `POST /api/v1/recognize` claims the clip's idempotency key, matches it, **records the outcome** with
   `recognition.finish_recognition`, and returns the answer. A finished key is answered again from storage by
   `replay()`. Both paths end in `recognition-answers.ts`.
4. The answer is a strict union `RecognizeResponse`: `MATCH`, `NO_MATCH`, `CHOOSE_STATION`
   (`packages/contracts/src/recognition/recognize-schemas.ts`). The app parses it strictly and its
   `RecognitionState` is sealed, so a new status cannot compile without a screen.
5. A clip the phone could not send live goes to the outbox and is sent later (`is_deferred`); its answer is written to
   History and a generic notification is posted. No screen is open then.
6. Stations read their own recognitions through row-level security. `lookup_api` is column-barred from
   `recognition_events.listener_install_id`, so a station can never tell which listener did what (P4-DATABASE-04).
7. The email infrastructure exists: `NotificationQueue` → `EmailSender` (nodemailer, Brevo in production, Mailpit
   locally). The station sign-up's 6-digit code (`phone-verification-codes.ts`) is the pattern for ours.

## 2. Decisions

| Id | Decision |
|---|---|
| LA-D1 | The gate is **on the server**. The answer for an ad scan from an install with no account is `ACCOUNT_REQUIRED`: `status`, `recognition_id`, `request_id`, `is_deferred`, `captured_at` and nothing else. |
| LA-D2 | Only ads are gated (`MATCH`, `CHOOSE_STATION`). `NO_MATCH` and every error are unchanged. |
| LA-D3 | The recognition is **recorded and counted exactly as before** (`finish_recognition` runs first). The station's totals do not depend on whether the listener signed up. |
| LA-D4 | An install is linked to an account by `app.listener_installs.listener_account_id`. One install, at most one account; one account, many installs. Statistics join through this link live; nothing is copied onto events. |
| LA-D5 | No password. The listener proves the email with a 6-digit code, for sign-up and for signing in on a new phone. |
| LA-D6 | After a right code for a **new** email, the server returns a **ticket** (HMAC-signed, 10 minutes, bound to this install and this email, nothing stored). The account is created with the ticket, so the code is never asked twice and no half-made account exists. |
| LA-D7 | Gender is one of `FEMALE`, `MALE`, `ANOTHER`, `PREFER_NOT_TO_SAY`. Age is a whole number from 13 to 99; the server stores `birth_year` = current year − age. 12 or less is refused with a kind message (`ACCOUNT_AGE_TOO_YOUNG`). |
| LA-D8 | Consent: the sign-up shows one consent line and the account stores `consent_text_version` and `consent_given_at`. The server accepts only the current version (`LISTENER_CONSENT_TEXT_VERSION`, in the contracts). |
| LA-D9 | Age bands for statistics: under 18, 18–24, 25–34, 35–44, 45–54, 55 and over, worked out from `birth_year` at query time. |
| LA-D10 | Stations see **groups of at least 10**, two separate breakdowns (gender; age band), never a gender × age grid (§7). |
| LA-D11 | The email is stored sealed (AES-256-GCM, account id bound in) beside a keyed hash. Nothing in v1 reads the sealed email back except to show a masked form in Settings; the platform keeps the ability to. |
| LA-D12 | `GET /recognitions/:recognitionId` (**reveal**) gives the signed-in owner the full answer; anyone else gets an unknown-recognition 404. |
| LA-D13 | The station choice and the report routes answer an install **with no account** like an unknown recognition (404) once the switch is on, because their answers (`NOT_A_CANDIDATE`, `CHOSEN`) would otherwise tell an account-less install which stations own the withheld recording. A button tap needs an action id from a card, which the install never received, so taps are unchanged. |
| LA-D14 | Rollout is behind `LISTENER_ACCOUNT_REQUIRED` (default `false`) and the existing `LISTENER_MINIMUM_APP_VERSION` gate. |
| LA-D15 | **Known limits, said plainly:** a shared phone is one person; signing out leaves that phone's earlier scans "not known yet" until the account signs in again; a phone later signed in by someone else attributes its earlier scans to them; typed gender and age are not checked. |

## 3. The listener's journey

### 3.1 Screens

| Screen | Route | Contents |
|---|---|---|
| Gate | `/account` | Heading "One more step to see your result". One sentence: "Stations use your gender and age to see who their adverts reach. They never see your name or email." **Create account** (primary), **I already have an account**, **Not now**. |
| Your email | `/account` (a step inside the gate's screen) | Email field (email keyboard, autofill), **Send me a code**. Plain errors (not an email, too many tries, no connection). |
| Enter the code | `/account` (a step inside the gate's screen) | 6 digit boxes (one-time-code autofill), "We sent a code to a\*\*\*@gmail.com", **Send a new code** with a 60-second countdown, **Change email**. Wrong, expired and locked each have their own words. |
| About you | `/account` (a step inside the gate's screen) | Gender chips (4), **Age** number box (13–99), consent checkbox with a **How we use this** sheet that opens over the form (the Privacy screen would leave the form and lose what was typed), **Create account** pinned above the keyboard. Only for a new email. |
| Settings → Account | `/settings/account` | Signed in: masked email, **Sign out**, **Delete my account** (confirm sheet naming what is erased). Signed out: **Create account**, **Sign in**. |

All words come from `app_en.arb`. Targets are 48 dp; the layout works from 320 dp, in light and dark, with the
600 dp column on tablets; the primary button is never behind the keyboard; reduced motion switches animation off.
Errors never show server text (the app shows its own words and, for a request that failed, the existing reference
code).

### 3.2 Flow

1. Identify as today. The answer is `ACCOUNT_REQUIRED` → state `AccountRequiredState(recognitionId)` → route `/account`.
2. **Create account** → email → code → (new email) about you → the app calls **reveal** → the answer becomes the usual
   `MatchedState`, `FallbackState` or `ChooseStationState`. History saves it as it does today.
3. **I already have an account** → email → code → straight to reveal (details are already stored).
4. **Not now** → Home. History keeps a row "Sign up to see this result" (no card, because none was received). Tapping it
   reopens the gate for that recognition.
5. **Offline clip:** the deferred sender gets `ACCOUNT_REQUIRED` as a final answer (the clip is deleted, no retry), History
   gets the same "Sign up to see" row, and the generic notification is posted as today. The tap opens `/r/:id`, which
   shows the gate.
6. **No connection** at any account step: the step says so and nothing is lost; the scan stays in History.
7. After sign-up, **every later ad scan** is answered normally. The app keeps a local "signed in" flag only as a hint
   for Settings; the server decides.

### 3.3 Flutter structure

- New sealed state `AccountRequiredState` in `recognition_state.dart`. The compiler then requires its route
  (`AppRoute.forState`), its screen (`RecognitionStatePage`), `RecognitionFlow._routePathOf` and
  `isLiveIdentifyUnderWay` (false).
- `recognize_response_parser.dart` reads `ACCOUNT_REQUIRED`; `SendPolicy.decide` maps it to a `FinishedOutcome`.
- New feature folder `lib/features/account/` (presentation, domain, data) with `test/structure/feature_folders_test.dart`
  changed to allow it, and the layer-import rules kept.
- `deferred_result_handler.dart`, `saved_result_page.dart` and the History store learn the "needs an account" row.

## 4. API (all listener routes: install token, then the 426 gate, then the route's allowance)

| Route | Request | Success | Errors |
|---|---|---|---|
| `POST /api/v1/listener-account/code` | `{ email }` | 202 `{ resend_after_seconds }` | 400 `VALIDATION_FAILED`; 429 `RESEND_TOO_SOON` (+ `Retry-After`) / `RATE_LIMITED`; 503 when the code store is down |
| `POST /api/v1/listener-account/verify` | `{ email, code }` | 200 `{ status: 'SIGNED_IN', email_masked }` or `{ status: 'DETAILS_NEEDED', ticket }` | 400 `LISTENER_CODE_INCORRECT` / `_EXPIRED` / `_LOCKED`; 409 `ALREADY_SIGNED_IN` (this install has a different account) |
| `POST /api/v1/listener-account` | `{ email, ticket, gender, age, consent_text_version }` | 201 `{ status: 'SIGNED_IN', email_masked }` | 400 `VALIDATION_FAILED` (field paths and reasons only), `ACCOUNT_TICKET_NOT_VALID`; 422 `ACCOUNT_AGE_TOO_YOUNG`; 409 `ALREADY_SIGNED_IN` |
| `GET /api/v1/listener-account` | | 200 `{ is_signed_in, email_masked }` | |
| `POST /api/v1/listener-account/sign-out` | | 204 | |
| `DELETE /api/v1/listener-account` | | 204 (also when there is no account) | |
| `GET /api/v1/recognitions/:recognitionId` | | 200 `RecognizeResponse` | 404 `NOT_FOUND` (unknown, or another install's) |

- Bodies are strict zod objects from `packages/contracts` (unknown fields refused). `email` is trimmed and lower-cased,
  at most 254 characters, one `@`, no spaces. `code` is exactly six digits.
- `code` always answers 202 for any well-formed email, known or not, so the answer never says whether an account exists.
  The one-a-minute cooldown is kept per email hash for every address alike.
- If a ticket is valid but the email got an account in the meantime, the install is linked to that account and the
  answer is `SIGNED_IN` (the ticket proves ownership of the address).
- `ACCOUNT_REQUIRED` is a **status of the 200 answer**, not an error. New error codes are added to
  `error-catalog.ts` with fixtures and, for the ones the outbox sees, rows in `listener-outbox-rules.json`.
- Allowances (configuration, all per rolling window, counted in Valkey by keyed hash): codes 3 an hour per email, 10 a
  day per install; code checks 20 an hour per install (5 wrong tries lock a code); creations 5 a day per install;
  sign-out, delete, `GET` and reveal share the follow-up allowance (60 a minute). Routes are added to
  `LISTENER_ROUTES` (per-address ceiling), and a portal cookie opens none of them.
- The code store being down refuses the request (503); a code is never sent or accepted unchecked.
- Mail: `NotificationQueue` template `listener_email_code` ("Your Look Up code is 123456. It works for 10 minutes. If
  you didn't ask for it, ignore this email."). Five tries, a 10-minute delivery deadline like the station codes.

## 5. Database (migration `1791900000000-ListenerAccounts`; the audience figures of §7 get their own, later migration)

- `app.listener_accounts`: `id`, `email_hash bytea` (32-byte HMAC, unique), `email_sealed bytea`, `gender`,
  `birth_year smallint`, `consent_text_version`, `consent_given_at`, `created_at`, `last_signed_in_at`. Checks on gender
  and a plausible birth year. Row-level security on, **no policy and no grant for `lookup_api`**; `lookup_admin_api` none
  in v1.
- `app.listener_installs.listener_account_id uuid` (nullable, `ON DELETE SET NULL`, indexed). `lookup_api` cannot write it.
- Definer functions (schema `listener_accounts`, owner `lookup_schema_owner`, `search_path` pinned, granted to `lookup_api`
  only): link an install to an existing account; create an account and link; unlink an install; delete an account;
  describe an install's account (sealed email, for the masked display); the station and per-ad mix reads (§7);
  describe a recognition for reveal (by id and install). Each returns only what its caller needs.
- Names follow `docs/conventions.md`. The new binary columns are added to the catalogue test's allowed list, with
  S3-PRIVACY-01's wording updated to say so.

## 6. Security, errors and logs

- Two layers (the standing rule): callers see short plain messages from the catalogue and the request id; the private log
  has the detail and stack. No `error.message` ever reaches a response.
- Never logged anywhere: the email, the code, the ticket, gender, age or birth year. The redaction list gains
  `*.gender`, `*.age`, `*.birthYear`, `*.ticket`, `*.typedCode` and `*.emailAddress` (not `*.code`, which would hide a database
  error's SQLSTATE from the developers); the log `actor` stays the keyed hash of the install.
- The sealed email is bound to the account id (an attacker who can write rows cannot move a sealed email to another
  account). The key comes from `LISTENER_EMAIL_ENCRYPTION_SECRET`, validated at start-up like the install pepper
  (missing, short, placeholder or reused → the API will not start, and the message never prints the value). The email
  hash and the ticket signature use their own purpose keys in `DerivedKeys`.
- The email sender's job data holds the address while the job waits; jobs are removed when done or failed (checked at
  build, as for the station codes).
- Abuse not solved here: scripted sign-ups from many installs (device integrity is P8). Per-recipient and per-install
  limits stop email bombing and code guessing.

## 7. Statistics

- `listener_accounts.read_listener_mix_for_station(range_days)` and `…_for_ad(ad_id, range_days)` run as the current
  station (they read `current_station_id()`; the ad one also checks the ad belongs to it → else 404). They join
  `app.recognition_events` (counted outcomes, captured in range) → `app.listener_installs` → `app.listener_accounts` and
  return **distinct-listener counts**: known listeners by gender, by age band, and the number of installs not yet known.
  A person with two installs counts once.
- **Suppression (LA-D10)**, done by a pure function in the API, tested at 9, 10 and 11:
  1. If known listeners < 10: no breakdown; the panel says "Not enough listeners yet to show groups."
  2. Otherwise, for each breakdown: a group with 1–9 listeners is *small*; groups with 0 or ≥ 10 are shown.
  3. All small groups are merged into **Other groups**. While Other groups came from exactly one group, or is under 10,
     the smallest shown non-zero group joins it.
  4. A zero is shown as 0 (it names no one).
- Contract `listener-mix-schemas.ts`: `{ range, firstDay, lastDay, listeners, knownListeners, notKnownYetListeners,
  genders: Group[] | null, ageBands: Group[] | null }`, `Group = { group, listeners }`. No identifier of any kind.
- Routes: `GET /stations/:stationId/listener-mix?range=1d|7d|30d` and
  `GET /stations/:stationId/ads/:adId/listener-mix?range=…`, next to `listener-figures`, same guards, same ranges.
- Portal: a **Who is listening** section on Overview and a block on each ad's Overview tab: gender and age-band bars with
  the Chart/Table switch used by the by-hour chart, the range switch, "People we don't know yet: N", the under-10 text,
  loading and error states, keyboard and screen-reader friendly, one column on a phone.
- Deleting an account, or signing out, moves that phone's scans to "not known yet". P7's rollups and CSV will take these
  groups later; this change reads live from the events like `listener-figures`.

## 8. Rollout on the live showcase

1. Add `LISTENER_EMAIL_ENCRYPTION_SECRET` in Render; deploy with `LISTENER_ACCOUNT_REQUIRED=false`.
   (The new routes are live; every answer is unchanged.) Migration runs in the pre-deploy step as usual.
2. Build the new APK pointing at the deployed address; walk through it with the switch on in a local stack first.
3. Set `LISTENER_ACCOUNT_REQUIRED=true` and raise `LISTENER_MINIMUM_APP_VERSION` to the new build, so an old app meets the
   existing "please update" screen and never an answer it cannot read.
4. Privacy wording, the Play data-safety form and the privacy notice list email, gender and age (P8-DATA-PROTECTION).

## 9. Requirement map

Every item is in [checklist 6](../requirements/checklist-6-listener-accounts.md). Areas: `LA-DECISION` (this record),
`LA-GATE` (§1, §2, §4), `LA-ACCOUNT` and `LA-ROUTES` (§4), `LA-DATABASE` (§5), `LA-PRIVACY` (§6), `LA-STATS` (§7),
`LA-APP` (§3), `LA-ROLLOUT` (§8).

## 10. Open items for the owner

- The consent wording and the Privacy screen text (drafted in the build; the owner reads them at the walkthrough).
- Whether the list of genders should change (the four above are the default).
- The Phase 8 legal work (controller registration, privacy notice, Play data-safety form, s.70 and Frankfurt).
