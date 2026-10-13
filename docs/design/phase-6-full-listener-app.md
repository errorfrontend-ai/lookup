# Phase 6 — Listener app (full): design

*Drafted 10 October 2026, and revised the same day after two critics checked it against the checklists
and the code (47 findings; the contract amendments A1–A8 that came out of that review follow the
contract in §10). Not yet approved: the questions in §8 wait for the user's answers, and every place
that depends on one names it. This file decides how the full listener app is built; the build follows
it, and a decision that changes during the build is changed here first.*

**Scope.** Phase 6 of the approved plan ("6. Flutter app": everything in §Mobile A–C), built together
with Phase 4 on the server (the user's order of 10 October 2026: the full listener app next, P4 and P6
together, before 5a). This file is the app half: the station chooser and "My station", the tab bar,
History, Settings, offline capture with the outbox, notifications, the data saver, "Report this", the
update gate, the dark theme, languages, tablet layouts, golden images and the APK size budget. The
server half (resolution, the choice, station-list and engagements routes, the deferred allowance, the
426 gate) is the P4 design; the two meet at the interface contract, which is the last part of this
file, copied verbatim (§10).

**Requirements.** Every `P6-` id in `docs/requirements/checklist-3-listener-app.md` — **156 ids: 143
items and 13 retired ids** — is mapped in §6, with the section that builds it and the piece that
delivers it. "Rules from the ALL part that bind the listener app" in that file, the ALL section of
`checklist-5-analytics-hardening-and-every-phase.md`, `docs/conventions.md` and the error, logging and
test rules in the user's CLAUDE.md apply throughout.

**Sources read.**
- Checklist 3: how to read it, conflicts 1–19, the whole P6 section, the ALL rules for the app, gaps
  1–50. Checklist 2: the P4 section and its gaps (what the server will give). Checklist 5: the ALL
  section.
- The approved plan, "Reference — master implementation plan": D5, D7, D8, the Data model, the
  Recognition flow steps 1–9, the listener's station choice, Engagements, Mobile design patterns A–C,
  Phases rows 4 and 6, the End-to-end verification, open decisions O3, O4, O10–O15.
- The wireframes in `c:\tmp\lookup-workflows\wireframes\`: Main, Chooser, Offline, History, Settings,
  Result, Result320, NoMatch, Busy, Error, Listening, Permission, and the canvas notes. Their wording
  below is copied from the boards.
- `docs/design/step-3-engine-hookup.md`, `docs/design/step-4-listener-app.md` (all of it, with its
  gate record and the 10 October phone check), `docs/conventions.md`, `docs/security-baseline.md`.
- The app as built: `recognition_state.dart`, `recognition_answer.dart`, `recognition_outcome.dart`,
  `send_policy.dart`, `captured_clip.dart`, `recognize_response_parser.dart`, `recognition_result.dart`,
  `api_client.dart`, `app_router.dart`, `app_route.dart`, `app_providers.dart`,
  `client_error_reporter.dart`, `app_version.dart`, the Android manifest, `pubspec.yaml`,
  `tool/fake_listener_api.py` and `tool/run_emulator_tests.py`.
- `packages/contracts`: `recognize-schemas.ts`, `action-card-schema.ts`, `station-schemas.ts`, the
  error-envelope fixture test and the fixtures. The API: `error-catalog.ts`,
  `limit-requests-per-client-address.ts`, `app-config.ts`, the stations controller,
  `scripts/sample-ads.ts`.
- The interface contract and the app map handed to this design (package facts measured on 10 October
  2026 from pub.dev and Google Maven), and the installed SDK and pub cache, read from disk only.

**What this design settles.** 52 decisions (§7, P6-D1 to P6-D52; P6-D35 onwards were added after the
review, and amended ones say so), each with its reason and the gap it answers, and 20 questions only
the user can answer, each with a recommended answer, the items that depend on it and the piece that
waits for it (§8). The work is cut into **7 pieces** (§5, pieces 0 to 6), each ending with a live
walkthrough.

**Facts found while reading that change the work.**
1. **The server side the chooser needs is not built.** Today the API answers "several stations on
   air" with `NO_MATCH` (S3-D19), ignores `station_hint`, and has no choice, station-list or
   engagements route, no 426 and no deferred allowance. Until the P4 gate's first part is built, the
   chooser can be shown only on the emulator against the stand-in API, which already has a
   `choose-station` scenario.
2. **The app's answer reader drops what P6 needs.** `recognition_id`, `captured_at` and the
   `CHOOSE_STATION` candidates are not kept (`ChooseStationAnswer` carries only the request id).
   History, choices, taps and `/r/<recognition_id>` all need the reader changed first.
3. **Navigation follows the state everywhere.** `AppRouter`'s redirect sends every location to the
   route of the current state (S4-D5). Tabs, History, Settings, the picker and `/r/<id>` need a shell
   route and a redirect that forces the flow's route only while an identify is under way (§3.7).
4. **Step 4 tests assert that P6 parts are absent** and must be rewritten on purpose:
   `home_screen_test` ("no station chip, no bottom navigation…"), `result_screen_test` ("no "Saved to
   History" and no "Report this""), `permission_screen_test` (no offline bullet),
   `feature_folders_test` (exactly `identify` and `result`), `pubspec_test` (exact pins),
   `android_project_test` (exactly `INTERNET` and `RECORD_AUDIO`), `recognition_state_test` (nine
   states) and `recognition_outcome_test` ("429 … clip deleted (no outbox before Phase 6)"). The
   security baseline's rows "no other permission is asked for", "the token is sent only to the
   recognize route" and "the clip is kept in memory only" change with them.
5. **Step 4 behaviour P6 reverses.** T19 (`CHOOSE_STATION` shows "newer app") becomes the chooser; T24
   (429 deletes the clip) and T27/T37 ("No connection" with "Send again") become Saved offline; T31
   (Busy paused while hidden) moves the clip to the outbox. `SendPolicy` clamps `Retry-After` to
   1–60 s, while shed deferred clips are told 60–300 s and a deferred 429 up to an hour. The clip file
   sits in `getTemporaryDirectory()/clips`, which is swept at start and on Home, so the outbox must
   live under `getApplicationSupportDirectory()`.
6. **`ApiClient` has only `postJson` and `postMultipart`** and sends the install token only to
   `recognize`. Its relative-path rule (`^[a-z0-9-]+(/[a-z0-9-]+)*$`) already admits
   `recognitions/<uuid>/choice`, so only the token matcher and a GET method are new.
7. **The stand-in refuses fields it does not know.** Its `CLIENT_ERROR_FIELDS` lacks `occurredAt`, so
   it must change in the same commit as the app, or every queued crash report fails the emulator run.
   (Corrected after review: `station_hint` is already accepted and checked as a UUID —
   `fake_listener_api.py` lines 125 and 140 — so only logging its value is new.) It also refuses any
   registration that carries a token (`handle_install`), which amendment A3 now asks the app to send
   on a re-registration, so that rule changes too.
8. **No `integration_test`** (S4-D33: the debug engines are not cached). Items that say "integration
   test" become widget tests with fakes plus the adb and uiautomator run of the release APK. These
   commands are proved on the `aosp_atd` Android 13 image in piece 0, before any journey depends on
   them: airplane mode through `adb shell cmd connectivity airplane-mode enable|disable`, and, as the
   fallback, `adb shell svc wifi disable` plus `svc data disable` (and `enable`); a notification read
   through `adb shell dumpsys notification`; and whether that image has a notification shade. The
   stand-in's "No signal" switch only closes connections: the emulator stays connected, so it never
   makes Android report a lost or regained network (§4.8). The emulator's active network is its
   virtual Wi-Fi, which is unmetered; `svc wifi disable` leaves the metered mobile network. On Android
   13 nothing is posted until `POST_NOTIFICATIONS` is granted. **A force-stopped app runs no
   WorkManager job**, so the background step must end the app with `am kill`, never `am force-stop`.
9. **Two Dart engines share the outbox.** WorkManager runs Dart in a second engine inside the app's
   process. Dart's `RandomAccessFile.lock` takes POSIX record locks, which belong to the process and
   so do not keep two engines of one process apart. The outbox, History and data-use files need their
   own lock (an exclusively created lock file that names its owner: the process id and the engine) and
   a hand-off to the foreground engine (§3.8, §3.10). A lock must never be judged stale by its age: a
   live engine can be slow (garbage collection, slow flash, a long 2G run), and file times follow the
   wall clock, which the listener can move. The same goes for `shared_preferences`: the app uses the
   cached `SharedPreferences` class (`listener_install_store.dart`), and each engine keeps its own
   cached copy, so a value one engine writes is stale in the other until it reloads (§3.12).
10. **Golden images need no download.** Roboto and the Material icons are in
    `C:\tools\flutter\bin\cache\artifacts\material_fonts` and load with `FontLoader` in
    `flutter_test_config.dart`. The file names there are all lower case (`materialicons-regular.otf`,
    `roboto-regular.ttf` and so on); Windows hides a wrong case, Linux does not. The full matrix is
    about 29 states × 4 sizes × 2 text scales × 2 themes, about 460 images, drawn on Windows and
    regenerated on Linux at P8. `golden_toolkit` has no version for this SDK; `alchemist` is not
    needed.
11. **Localisation needs no download.** `flutter_localizations` ships with the SDK and pins `intl`
    0.20.2, which is in the pub cache. About 100 user-visible literals in `lib/` move to an ARB file.
    Bemba (`bem`) and Nyanja (`ny`) are not among the locales whose Material texts
    `flutter_localizations` ships (checked in the SDK: `material_zu` exists, no `material_bem` or
    `material_ny`), so "add an ARB file, no code change" (P6-LOCALISATION-03) needs a fallback Material
    localisation delegate from the start. Nor does `intl` 0.20.2 have date symbols for them (its
    `locale_list.dart` has `nyn`, not `ny` or `bem`): `DateFormat('E', 'bem')` throws `ArgumentError`,
    so History's day names fall back to English date symbols (§2.9, P6-D47). Piece 0's scratch build
    confirms both, and piece 2 extends it to open History.
12. **The dark theme's values exist** (`LookUpTokens.dark`), but `look_up_app.dart` and `bootstrap.dart`
    force the light theme, and contrast is tested only for the light pairs.
13. **The APK budget fails today.** The x86_64 release APK is 19.9 MB (libflutter 12.6 MB + libapp
    5.8 MB, stored uncompressed); an arm64 per-ABI APK is about 19 MB. Compressing native libraries
    meets 15 MB, but Android then unpacks them at install, so the app takes more storage on the phone
    (Q10).
14. **An in-repo notification plugin needs no Gradle download** if it uses only the Android framework
    (`Notification.Builder`, `NotificationManager`, `ConnectivityManager`, `PendingIntent`), with no
    AndroidX. `flutter_local_notifications` 22.3.1 would add core-library desugaring (a 6.1 MB jar)
    and about 8.4 MB in all.
15. **`workmanager_android` merges foreground-service permissions and a service** into the manifest;
    they are removed with `tools:node="remove"`. Its Dart runs in a background engine, so any
    hand-written Kotlin must be a plugin package (registered in every engine), never code in
    `MainActivity`.
16. **Drift, the plan's choice, is heavy**: about 22 MB of packages, SQLite binaries fetched from
    GitHub at build time, and code generation, which Step 4 ruled out (S4-D3).
17. **No banner or logo is ever sent today**: the portal cannot set them, so `header_image` and `logo`
    are always null. The picture items (P6-DATASAVER-01, -05, -06) can be shown only with the
    stand-in's `match-with-images` fixture. Its pictures point at `https://images.lookup.invalid/…`,
    which does not resolve, and the app loads only `https` pictures (`HttpsImageProvider`, the
    reader's `_isHttpsAddress` and the contract's `PublicImage`), so on the emulator, whose stand-in is
    plain `http://10.0.2.2:3999`, no picture can ever load. The pictures are shown on the user's phone
    instead, through the `https` ngrok tunnel to the stand-in (§5.0 (c), P6-D49).
18. **The development seed has one station.** A real-stack chooser walkthrough needs a Station B with
    the same sample audio; there is no sign-up before 5a, so the seed adds it, as the P4 design's
    §5.15 defines it (§3.23).
19. **Three items are built and tested but unticked**: P6-RESULT-03 ("More options", S4-D18),
    P6-LOCALISATION-04 (+260 display) and P6-TESTS-06 (the address builders refuse bad input). They are
    ticked with that evidence, re-run, at the P6 gate.
20. **Realistic sample numbers** `+260977123456` and `+260966123456` sit in **112 tracked files** in
    one form or another (counted again 10 October 2026 after review: E.164, grouped `+260 97 712 3456`,
    local `0977 123 456`, bare `977123456`, and the `wa.me` digits `260977123456`): **58 fixture
    files** (54 of them in E.164 form) and **54 other files** — 49 code and test files and 5 documents.
    The other files include words a person reads: the portal's hint "Like 0977 123 456." in
    `apps/portal/src/features/ad-buttons/button-row.tsx` and three messages in
    `apps/portal/src/plain-words/button-words.ts`, which every station user sees; and code comments in
    `apps/mobile/lib` (`ui_action.dart`, `launch_failure_sheet.dart`, `phone_number_display.dart`),
    `packages/contracts/src/phone-numbers/zambian-phone-numbers.ts` and
    `apps/mobile/tool/run_emulator_tests.py`. Every fixture P6 adds or edits uses numbers that reach
    nobody (P6-D29); the rest is the sweep of Q13.
21. **Step 4 emulator run 4** showed "No connection" for a "no match"; run 5 passed all 17 steps and the
    gate record calls run 4 a one-off connection drop. P6 rewrites exactly that no-answer path, so
    piece 0 first makes the emulator evidence record the app's no-answer reason.
22. **Tablet and landscape layouts can be shown on the existing `lookup_test` device** with
    `adb shell wm size 800x1280` and `wm density`; no new system image.
23. **Home says "about 25 KB"; measured uploads are 27–31 KB.** S4-D31 revisits the wording only above
    35 KB, and Settings repeats the same figure.
24. **The stand-in's control routes would be public during a phone check**: the ngrok tunnel forwards
    every path, so `/__fake/*` must refuse forwarded requests (P6-D30). They are also open to any web
    page in the user's browser: `read_body` parses JSON whatever the `Content-Type`, so a page can POST
    `text/plain` to `http://127.0.0.1:3999/__fake/*` without a preflight (P6-D50).
25. **Added after review — the outbox would not retry by itself.** As first drafted, a run that ended
    on "no answer" scheduled nothing: the next run waited for a start, a resume, a new item or a
    network event. With the stand-in's "No signal" switch the network never drops, and on a real
    phone a network that looks connected but carries nothing (a tower with no backhaul during load
    shedding, captive Wi-Fi) fires no event either, so waiting clips, choices and taps stayed until the
    next resume. Amendment A1 fixes it, from piece 1 (§3.9, P6-D35).
26. **`MainActivity` is exported** (`android:exported="true"`, needed for the launcher), so any app can
    start it with the notification's extra `zm.lookup.recognition_id`. The draft's "no other app can
    open a route" was wrong; §3.15 now honours only ids the app itself notified (P6-D41).
27. **Two notifications can open the same result.** Android treats two `PendingIntent`s with the same
    request code and filter-equal intents as one (extras are ignored), so each notification needs its
    own request code (§3.15).
28. **A 426 could freeze an outbox for good** (before amendment A2), and **a re-registration after an
    update could be refused** by the per-address registration limit when many listeners share a
    carrier address (before amendment A3). Both are changed in the contract amendments; the app's
    halves are in §3.9 and §3.12.

---

## 1. The phase at a glance

```
            ┌──────────────── tab bar: Identify · History · Settings ────────────────┐
            │                                                                        │
Home ── "Tap to identify" ──► Listening ──► Identifying ── answer ──┬► Result ── "Saved to History" ✓ · "Report this"
  │ "My station: Station A"                  │ 5 s, no answer:     ├► Which station? ── tap a row ──► Result of that station
  │  chip → Settings                         │ "Still working…"    │      (choice queued in the outbox; "Remember" sets My station)
  │                                          │                     ├► No match / Error / "Please update the app"
  │                                          │                     ├► Busy ── 4th busy, or app hidden ──┐
  │                                          │                     └► no answer, or 429 ────────────────┴► Saved offline
  │                                                                                                         │ clip in the outbox
  ▼                                                                                                         ▼
History: "Waiting for signal" (Pending) and "Earlier" ◄── result, notification ◄── outbox sender (start, resume,
  └ tap a row → /r/<recognition_id> (saved result, works without data)               back online, its own wake-up
                                                                                      after a wait, background job)
Settings: My station picker (GET /stations, cached 24 h) · Data · Language · Privacy · About
```

What the listener can do after Phase 6: everything from Step 4, plus read a short "How Look Up works"
note the first time the app opens, pick the station when an ad is on more than one ("Which station
are you listening to?"), have the app remember it, identify with no signal and get the result later
with a notification, find every result again in History (and use its buttons with no data), set "My
station", see and limit data use, report a bad ad, and use the app in the dark theme, on a tablet or
sideways.

Server dependencies (the P4 design): the chooser, the hint, the choice route, the station list and the
426 gate come with the P4 gate's first part (P4-RESOLUTION-16); the engagements route comes with its
second part (P4-RESOLUTION-17). The P4 design builds them in its pieces 2 and 3 (resolution, then the
choice route and the station list), 4 (deferred clips, the 426 gate, reports) and 5 (engagements).
Every piece can be shown on the emulator against the stand-in before the server part exists; the
phone walkthroughs against the real stack wait for the P4 piece that builds what they use (§5).

---

## 2. Screens and states

### 2.1 Rules every new screen follows

Step 4's rules hold unchanged (step 4 design §2.1): the safe-area frame that scrolls at large text, a
48 dp Back or Close at the top left, full-width footer buttons (primary 52 dp, secondary 48 dp),
design values only from the generated tokens (the nearest token where the wireframe falls between
two), every target at least 48 × 48 dp with 8 dp gaps, the app's own words only (never the API's
`message`), system back doing what the screen's own Back or Close does, no motion when the phone asks
for less, and no ads list anywhere (D8). Added in Phase 6:
- **Every word comes from the language file** (`lib/l10n/app_en.arb`, §3.17). Text in double quotes
  below is the English value, shown exactly.
- **Tab screens** (Home, History, Settings) show the tab bar (§2.2); **flow screens** (Permission,
  Listening, Identifying, Which station?, Result, No match, Busy, Error, Saved offline) and **pages
  opened from a tab** (the picker, Privacy, About, a saved result) are full screen, as the wireframes
  draw them.
- **Both themes.** Every screen is built and tested in the light and the dark theme (§3.18).
- **Window sizes.** Compact layouts are the wireframes; medium and expanded layouts follow §3.19.
- **Lists of stations appear in exactly two places**, the chooser sheet and the "My station" picker
  (D8, P6-MYSTATION-06).

### 2.2 The tab bar

Wireframes *Main*, *History* and *Settings* (`nav aria-label="Main"`).

| Part | Content | Behaviour |
|---|---|---|
| Bar | White surface (dark: surface), 1 dp line border on top, three equal columns, at least 64 dp tall and taller as the text grows (labels are never cut off at text scale 2.0) | Shown on Home, History and Settings only |
| Identify | Microphone icon (22 dp) above "Identify" (12, 600) | Opens the Identify tab (Home) |
| History | Clock icon above "History" | Opens the History tab |
| Settings | Sliders icon (`Icons.tune`) above "Settings" | Opens the Settings tab |
| Current tab | Accent icon and label, label weight 700, and an accent-soft indicator pill behind the icon | Not colour alone: bold label and the pill shape (gap 36; P6-ACCESSIBILITY-04) |

Semantics (P6-ACCESSIBILITY-06): the bar is one container named "Main"; each item is a button with its
label and the selected flag on the current one ("Identify, selected, tab 1 of 3"). System back on
History or Settings goes to the Identify tab; on Identify it leaves the app. At medium and expanded
widths the same three destinations sit in a navigation rail at the left (§3.19). The bar is the app's
own widget (`MainNavigationBar`), not Material's `NavigationBar`, whose fixed 80 dp height cuts labels
at large text and does not match the wireframe's 64 dp.

### 2.3 Home: the "My station" chip and the first-open note

Wireframe *Main*, header. Everything else on Home is unchanged from Step 4, except the one-time note
below.

| Part | Content | Behaviour |
|---|---|---|
| Chip | At the top right, beside "Look Up": radio icon (16 dp) and "My station: Station A" (13, 600); white fill, line border, pill radius, 48 dp tall (the wireframe's 44 px is raised, conflict 11) | Opens the Settings tab (P6-NAVIGATION-04). Label "My station: Station A", hint "Opens Settings" |
| No station set | "My station: Not set" (proposed; Q8, gap 2) | Same |
| Long names and large text | The name is cut with "…" to keep the chip within half the header; at text scale 2.0 the header wraps and the chip moves under "Look Up" | The full name is read out |

**The first-open note** (added after review; ALL-USABILITY-04, gap 44; no wireframe, so the words are
proposed, Q20). Step 4 let Home's instruction line stand for the "how it works" note, but that line
shows on every launch, and the rule asks for a note on the first open and not on later launches.

| Part | Content | Behaviour |
|---|---|---|
| Card | Under the header, above "Heard an ad on the radio?": surface fill, line-soft border, radius lg, 16 dp padding, an info icon (22 dp, accent) | A group named "How Look Up works" for screen readers |
| Title | "How Look Up works" (15, 700) | Heading |
| Text | "Tap Identify while an ad plays on the radio, and Look Up shows the advertiser's buttons: call, chat, directions or website." and "Ads you identify are saved in History, so their buttons work even without data." (13, muted; the About page's sentence, reworded so it does not repeat the heading under it) | — |
| Control | Text button "Got it" (48 dp, accent, 600) at the card's bottom right | Hides the card for the rest of this launch |

It shows on the first launch only. The flag `how_it_works_note_shown` (`shared_preferences`, written
by the foreground engine only) is set as soon as the card has been drawn once, not only when "Got it"
is tapped, so a later launch never shows it, whether or not it was dismissed. Home keeps its thumb
zone: on short screens and at text scale 2.0 the frame scrolls (Step 4's rule), and the card never
pushes "Tap to identify" off a 320 × 640 screen at text scale 1.0. At medium and expanded widths it
sits at the top of the Identify pane. The Step 4 instruction line stays as it is.

### 2.4 Permission: the offline promise

Wireframe *Permission*, list item 2, now true (P6-PERMISSION-01): green tick + "No signal? The clip
waits on your phone and is deleted once it's sent — never kept longer than 24 hours." It sits between
Step 4's items 1 and 3; the tick is hidden from screen readers. The 24-hour promise holds even if the
app is never opened again only with the background job (§3.10); without it, the clip is deleted at the
next start (§3.8), and the Privacy page says so (§2.13). It also holds when the phone's clock is moved
back after the capture (amended after review, §3.8, P6-D37).

### 2.5 Identifying: slow upload (no wireframe; P6-LISTENING-01)

The Step 4 Identifying screen, plus a slow variant (P6-D18, gap 4):

| When | Line of text | Bar |
|---|---|---|
| The first 5 seconds of a send | "This usually takes a few seconds." | Indeterminate (Step 4) |
| 5 s with no answer, clip still uploading | "Still working — the connection is slow." | Determinate: the share of the clip sent, with "Clip [n]% sent" under it, e.g. "Clip 40% sent" |
| 5 s or more, clip fully sent, no answer yet | "Still working — the connection is slow." | Full, with "Clip sent — waiting for the answer" |

The "Still working" line is a polite live region announced once. The layout keeps the room of the
longest line, so nothing jumps (as S4's `ListeningLayout`). "Cancel" behaves as in Step 4 (T28).

### 2.6 Which station? — state `chooseStation`, route `/choose-station`

Wireframe *Chooser*. Shown when the answer is `CHOOSE_STATION` (live), or when a saved
`CHOOSE_STATION` recognition is opened from History or its notification.

| Part | Content | Behaviour |
|---|---|---|
| Behind | The Identifying layout as it stood (ring still), under a scrim of the ink colour at 55% (the wireframe's `rgba(28, 25, 23, 0.55)`, computed from the token) | Hidden from screen readers (the barrier blocks the semantics behind it); a tap on it does nothing, so a stray tap never throws an identify away |
| Sheet | Material `BottomSheet` on the surface colour, top corners radius xl (24; the wireframe's 20 falls between two tokens), 16 dp sides, 24 dp bottom, 12 dp between groups; at most 90% of the screen's height, scrolling inside; at most 640 dp wide, centred | Modal: its semantics scope a route and are named by the title (P6-ACCESSIBILITY-07). Dragging it down, a downward fling, or system back = "Cancel" |
| Handle | 40 × 4 dp, radius 2, line colour, top centre (P6-CHOOSER-12) | Hidden from screen readers |
| Title | "Which station are you listening to?" (cardTitle 22/28, 700) | Heading; the sheet's accessible name |
| Text | When at least one candidate is a campaign card: "This ad is on more than one station right now." (P6-CHOOSER-13). When every candidate is the advertiser's default card: "This ad is played on more than one station." (proposed; Q15, contract §5.6). Amended after review: the rule is "every candidate is a default card", not "out of window". The answer does not say why a card is a default card, and from P4 an in-window candidate is one too when its campaign reached its tap limit or was paused after the capture; on the wire that answer is identical to an out-of-window one, and the second sentence is true in both cases (P6-D42) | — |
| Rows | One per candidate, 2 to 4, **in the answer's order** (the app never reorders); a group with a line-soft border, radius lg (16), a line-soft rule between rows. Each row at least 64 dp tall (the wireframe; the checklist's minimum is 56), 12 dp padding: the station logo 40 dp (radius md) or its first letter in the surface colour on ink, muted or accent by the row's position; the name (16, 700); "98.1 FM · Lusaka" (caption, muted) — just "98.1 FM" when the city is null; a chevron | Each row is one button, read as "Station A, 98.1 FM, Lusaka". A tap is T44 |
| Remember | Checkbox (22 dp drawn, accent), **ticked when the sheet opens**, and "Remember my station — skip this next time" (15) | The whole 48 dp row toggles it (P6-CHOOSER-06); read as a checkbox with that label and its state. The tick lives in the sheet; it is read when a row is tapped |
| Cancel | Text button "Cancel", full width, 48 dp, ink, 600 | T46 / T47 |

**After a tap (T44)**: the Result of that candidate appears at once, from the data already received,
with no request (P6-CHOOSER-09); its client row reads "via Station B · 104.3 FM"; the haptic tick
fires as for any result (gap 29). In the background, and never delaying the screen: the choice goes to
the outbox (§3.8; P6-CHOOSER-10), "My station" is set to that station if "Remember" was ticked
(P6-CHOOSER-07, -08), and the result is saved to History (P6-HISTORY-01).

**Cancel (T46)** closes the sheet and returns Home. Nothing is queued and nothing is saved in History;
the server keeps the recognition `UNRESOLVED` (gap 28; contract §1.3). From a saved recognition (T47)
Cancel returns to History, where the row still asks for a station.

### 2.7 Result: what changes

Wireframe *Result*, footer. Everything from Step 4 §2.6–§2.7 stays.

| Part | Content | Behaviour |
|---|---|---|
| Footer, left | Green tick (success colour, 16 dp) + "Saved to History" (13, muted) | Appears once the History store has written the result (P6-HISTORY-14); a failed write leaves it out and is reported |
| Footer, right | Flag icon + "Report this" (13, 600, accent), a 48 dp target at the bottom right (the wireframe's 44 px raised) | Opens the report sheet (§2.14). After a report: flag + "Reported" (muted text, no longer a control). Only when the user approves "Report this" (Q6); otherwise the footer has no right part and P6-RESULT-04/-05 stay open |
| From the chooser | "via [the tapped station] · [frequency]" | Same layout and haptic tick |
| A saved result (§2.10) | Header "Saved result" instead of "Found it"; Back returns to where it was opened | No haptic tick |
| Buttons (piece 5) | As Step 4 | A tap also queues the engagement (§3.8; T54) |
| Data saver | With pictures off on mobile data: no banner box at all and the client's first letter instead of a logo, decided before the first frame so nothing moves (§3.16) | — |
| Default-card note (amended after review; contract amendment A7) | When `result.kind` is `CLIENT_DEFAULT`: "These are [client name]'s usual contact details." It replaces Step 4's "This ad isn't on air right now, so these are [client name]'s usual contact details.", which is no longer true: from P4 a default card also shows when the campaign was paused after the clip was heard, or reached its tap limit, while the ad is still on air. ARB key `defaultCardNote`, with the client name as its one placeholder. Wording pending the shared question (Q15) | Same place and style as Step 4's note |

At medium and expanded widths the result sits in a side panel beside Home (§3.19).

### 2.8 Saved offline — state `savedOffline`, route `/saved-offline`

Wireframe *Offline*. Shown whenever the live flow keeps a clip for later (T21′, T24′, T27′, T31′).

| Part | Content | Behaviour |
|---|---|---|
| Header | Close ×, label "Close" (P6-OFFLINE-23) | → Home; the clip stays queued (T48) |
| Icon | 88 dp circle; per reason below | Decorative |
| Heading | Per reason below (headline 28/34) | Announced as a status (live region; P6-OFFLINE-25) |
| Body | Per reason below | — |
| Oldest clip note | Only when the sixth clip pushed out the oldest (P6-D6): "You had 5 clips waiting, so the oldest one was deleted." | — |
| Bell panel | Surface, border, radius lg, 16 dp padding, bell icon (22 dp, accent) and text per the notification state below | — |
| Primary | "OK" (P6-OFFLINE-28) | → Home (T48) |
| Secondary | "See it in History" (P6-OFFLINE-29) | → the History tab, where the clip shows as Pending (T49) |

| Reason | When | Icon | Heading | Body |
|---|---|---|---|---|
| No connection | No answer (T27′) | Crossed-out signal, ink on line-soft (P6-OFFLINE-24) | "Saved — we'll identify it when you're back online" | "No signal right now. Your clip stays on this phone for up to 24 hours and is deleted as soon as it's sent." |
| Busy | The 4th busy answer (T21′), or the app hidden during Busy (T31′) | Refresh, warning on warning-soft | "Saved — we'll identify it when Look Up is less busy" | "Lots of people are listening right now. Your clip stays on this phone for up to 24 hours and is deleted as soon as it's sent." |
| Too many tries | 429 (T24′) | Clock, warning on warning-soft | "Saved — we'll identify it a little later" | "You've identified a lot in a short time. Your clip stays on this phone for up to 24 hours and is deleted as soon as it's sent." |

| Notification state | Panel text | Control |
|---|---|---|
| Allowed (Android below 13 with notifications on, or 13 and later granted) | "You'll get a notification with the result, including the station's buttons." (P6-OFFLINE-27) | — |
| Android 13 or later, never asked | "Allow notifications to hear when the result is ready." | Text button "Allow notifications" (48 dp): asks the system (T50; Q4). The panel then follows the answer |
| Refused, turned off for the app, or iOS (no notifications in this version) | "Notifications are off for Look Up, so the result will wait in History." (bell-off icon, muted) | — |

### 2.9 History — route `/history` (History tab)

Wireframe *History*.

| Part | Content | Behaviour |
|---|---|---|
| Header | "History" (title 24/30; the wireframe's 26 rounded to the token) | Heading (P6-HISTORY-03) |
| Section 1 | "Waiting for signal" (13, 700, muted, upper case as drawn) — only while at least one clip waits (P6-HISTORY-04, -06) | Heading |
| Waiting row | At least 72 dp, white card with a line-soft border, radius lg: a 40 dp warning-soft square with the crossed-out signal icon (warning); "Clip from today, 14:32" (15, 700); a subtitle; a "Pending" badge (warning-soft pill, warning text, 12, 700) (P6-HISTORY-05) | Not a button (there is nothing to open yet). Read as one item: "Clip from today, 14:32. Will identify when you're back online. Pending" |
| Waiting subtitle | "Will identify when you're back online" (the wireframe; after no answer). After a busy or limited answer: "Look Up is busy — will try again soon". While the update gate holds the sender: "Waiting for a newer version of Look Up" | The badge always says "Pending" in words (P6-ACCESSIBILITY-04) |
| Section 2 | "Earlier" — every saved entry, newest first by the phone's capture time (P6-HISTORY-07; contract §5.14) | Heading |
| Result row | At least 72 dp (P6-HISTORY-10): the client's logo or first letter (40 dp circle; ink, muted or accent by position); "Brand A — Summer service offer" (15, 700); "via Station A · Today, 09:12" (13, muted); chevron (P6-HISTORY-08) | A button; opens `/r/<recognition_id>` (P6-HISTORY-11) |
| Waiting for a choice | A saved `CHOOSE_STATION` (§3.11): radio icon on accent-soft; "Clip from today, 14:32"; "Choose your station to see the buttons"; chevron | Opens the chooser for that recognition (T51) |
| Not identified | Magnifying glass, muted on line-soft; "Clip from today, 14:32"; one of "Not recognised", "Not sent within 24 hours — deleted", "Couldn't be checked — deleted" (§3.11) | Not a button |
| Note | Under the list, when at least one result row exists: "Saved results keep working without data — call, chat or get directions any time." (P6-HISTORY-12) | — |
| Empty | With no entry and no waiting clip (P6-HISTORY-13; no wireframe, gap 4): an 88 dp line-soft circle with a clock icon; heading "No results yet"; "Ads you identify are saved here, so their buttons work even without data." | Reviewed as a screenshot at the gate |
| Tab bar | History current (P6-NAVIGATION-05) | — |

**Days and times** (P6-HISTORY-09): 24-hour `HH:mm` in the phone's time zone; "Today", "Yesterday",
the short weekday ("Mon") for two to six days ago, then day and short month ("3 Oct"). Inside the
waiting row's sentence the first two are lower case ("Clip from today, 14:32"), as drawn. "Today" and
"Yesterday" come from the ARB file. The weekday and month names come from `intl` for the current
language when `intl` has date symbols for it, and from English otherwise (amended after review):
`DayLabel` formats with `Intl.verifiedLocale(locale, DateFormat.localeExists, onFailure: (_) => 'en')`,
because `intl` 0.20.2 has no symbols for Bemba or Nyanja and `DateFormat` would throw (fact 11,
P6-D47). English names in a Bemba screen are a known limit until `intl` or the app carries Bemba
and Nyanja date names.

### 2.10 A saved result — route `/r/<recognition_id>`

The Result screen (§2.7) filled from the History store, with no request (gap 19; P6-STRUCTURE-02).
Opened from a History row and from a result notification. Header "Saved result" with Back (label
"Back"), which returns to History, or to Home when it was opened from a notification. The buttons work
with no data where the target app needs none (P6-HISTORY-02): Call opens the dialler, and the copy
sheet still offers the number. An id that is malformed or no longer in History leads to the History
tab with a snackbar "That result is no longer saved on this phone." No other install can open it: the
route reads only this phone's store. It is an internal route, not a link anyone can share or open
from outside the app: there is no URL scheme and no intent filter (P6-D13). The checklist calls it a
"deep link" (P6-STRUCTURE-02); whether that word may be narrowed to "an internal route, opened from
History and from a notification" is Q18.

### 2.11 Settings — route `/settings` (Settings tab)

Wireframe *Settings*. Section headings as in History (13, 700, muted, upper case); rows in white
cards with a line-soft border, radius lg, line-soft rules between rows.

| Section | Row | Content | Behaviour |
|---|---|---|---|
| Header | — | "Settings" (title) | Heading (P6-SETTINGS-01) |
| "Listening" (P6-SETTINGS-02) | My station | "My station" (15, 700) and under it "Station A · 98.1 FM — used when an ad is on more than one station" (13, muted); with none set, "Not set — used when an ad is on more than one station"; chevron; at least 64 dp (P6-SETTINGS-03, -04) | Opens the picker (§2.12) |
| "Data" (piece 4) | Each identify uses | "Each identify uses" / "about 25 KB" (P6-DATASAVER-02; S4-D31) | Not a control |
| | Used this month | "Used this month" / e.g. "86 KB" or "1.2 MB" (1 KB = 1,000 bytes, one decimal from 1 MB) (P6-DATASAVER-03; Q11) | Not a control |
| | Pictures | "Load ad pictures on mobile data" (15, 700) and "Turn off to save data; buttons still work" (13, muted), with a switch; on by default; at least 64 dp | The whole row toggles it (P6-DATASAVER-04); read as a switch with its label, state and note |
| "App" | Language | "Language" / "English" (P6-SETTINGS-05) | Not a control while there is one language; with Bemba or Nyanja it opens a language list |
| | Privacy | "Privacy" + chevron | Opens the Privacy page (P6-SETTINGS-06) |
| | About Look Up | "About Look Up" + chevron | Opens the About page (P6-SETTINGS-07) |
| | Clear history (only if approved, Q7) | "Clear history" in the danger colour | A dialog "Clear history?" / "Saved results and any clips waiting to be sent are deleted from this phone." / "Clear" (danger) and "Cancel"; then a snackbar "History cleared" |
| Tab bar | — | Settings current (P6-NAVIGATION-06) | — |

The Data section appears in piece 4, when its switch works; until then it is absent, never dead.

### 2.12 The "My station" picker — route `/settings/my-station` (no wireframe; gap 4)

| Part | Content | Behaviour |
|---|---|---|
| Header | Back (label "Back") and "My station" (title) | Back → Settings |
| Lead | "Used when an ad is on more than one station." (body, muted) | — |
| Search | Only when the list has more than 10 stations (gap 33): a field labelled "Search stations", hint "Name, frequency or city" | Filters on the phone; no request |
| First row | "No station" / "Look Up will ask each time" with a radio | Clears "My station" |
| Station rows | Radio, logo or first letter (40 dp), name (16, 700), "98.1 FM · Lusaka" (13, muted); at least 56 dp (the token `listRowStation`) | A tap stores that station and returns to Settings |
| Kept station no longer listed | At the top, selected, with "Not in the current list" | The app never clears it by itself (contract §5.8) |
| Loading, nothing cached | A progress indicator and "Loading stations…" | — |
| Refresh failed, list cached | Above the list: "Couldn't refresh the list. These are the stations saved on [Today, 09:12]." | — |
| Failed, nothing cached | "Couldn't load the stations." and a button "Try again" | Fetches again |
| Empty list | "No stations are listed in Look Up yet." | — |

The list is exactly what `GET /api/v1/stations` returned (P6-MYSTATION-02), in its order. Logos follow
the data-saver rule.

### 2.13 Privacy and About (interim; Q9, O15)

**Privacy** (`/settings/privacy`): header Back + "Privacy"; then, as a list with ticks hidden from screen
readers:
- "Look Up listens only when you tap Identify, for about 8 seconds."
- "The clip is sent to Look Up to find the ad, and is not kept after it has been checked."
- "With no signal, the clip waits on this phone for up to 24 hours and is deleted once it's sent."
- "Radio stations see how many people used their buttons — never who you are."
- "Your History stays on this phone." (plus " You can clear it in Settings." if Q7 approves "Clear
  history")
- (Only if "Report this" is approved, Q6; added after review to match the server design.) "If you
  report an ad, the report is kept with an anonymous code for this phone, so Look Up can tell many
  reports from one phone apart from reports by many people. Only Look Up's own team can see it;
  stations never do."
- Footer line: "This is a short summary. The full privacy notice comes before Look Up's public
  release."

**About** (`/settings/about`): header Back + "About Look Up"; "Look Up" (title); "Version 0.1.0
(build 1)" from `AppVersion.current`; "Heard an ad on the radio? Tap Identify while it plays, and Look
Up shows the advertiser's buttons: call, chat, directions or website."; and "Message support on
WhatsApp" when the build has the support number (the S4-D32 rule).

### 2.14 Report this (sheet; only if approved, Q6)

A modal bottom sheet over the Result, built like the chooser's sheet (handle, drag down or back =
Cancel):

| Part | Content |
|---|---|
| Title | "Report this ad" |
| Text | "What's wrong? Stations never see who reported it." (true: the server keeps the report with only a keyed hash of the install, which super admins alone can read; the Privacy page says so, §2.13) |
| Choices (radio rows, 48 dp, whole row selects) | "The buttons are wrong or misleading" (`WRONG_OR_MISLEADING_BUTTONS`), "A number or link doesn't work" (`NUMBER_OR_LINK_DOES_NOT_WORK`), "It looks like a scam" (`LOOKS_LIKE_A_SCAM`), "Something else" (`SOMETHING_ELSE`) |
| Primary | "Send report" — enabled once a choice is made |
| Secondary | "Cancel" |

"Send report" queues the report (§3.8), closes the sheet and shows a snackbar "Thanks — we'll check
this ad."; the footer then reads "Reported". No free text is collected or sent. It works with no
signal, through the outbox. The report names the result's station (the chosen one after a chooser);
a report naming another station than the chosen one gets 422 `STATION_ALREADY_CHOSEN` from the
server (delete plus report, as for a tap under amendment A4), which the app never causes.

### 2.15 Error: what changes

| Variant | Phase 6 |
|---|---|
| **Please update the app** (new) | 426 `APP_UPDATE_REQUIRED` (T26′). Icon: update arrow, accent on accent-soft. Heading "Please update the app" (status). Body "This version of Look Up is too old to identify ads." No code panel. Primary "Back to home". No store button until a listing exists (Q14; ALL-USABILITY-05). These are the screen's words; the contract's live column ("This version of Look Up is too old. Please update the app.") only summarises them (§10, correction 9) |
| No connection | **Retired**: no answer now leads to Saved offline (T27′), and "Send again" goes with it (T37 removed) |
| Too many tries | **Retired**: a 429 keeps the clip and leads to Saved offline, "a little later" (T24′) |
| Newer app needed | Stays for an answer status the app does not know; its several-stations wording goes, because `CHOOSE_STATION` is now the chooser |
| Server failure, phone failure, recording unusable | Unchanged |

### 2.16 Notifications (Android; Q3, Q4; amended after review by contract amendment A6)

One channel, "Saved clip results" ("When a clip saved with no signal has been checked"), default
importance. One notification per recognition, with an id derived from the recognition id, so a replay
after a lost answer updates it instead of adding a second (contract R13).

**The words never name the brand, the ad, the station or the outcome**, in any version (A6). Android
shows the full text of a private notification on the lock screen unless the listener has chosen to
hide sensitive content, so the draft's "private notification with a public version" would have shown
"Found it: Brand A" on most locked phones. Every notification therefore carries only:

| Outcome of a saved clip | Title | Text | Tap opens |
|---|---|---|---|
| `MATCH` (campaign or default card) | "Look Up" | "Your saved clip has been checked. Tap to see the result." | `/r/<recognition_id>` (P6-OFFLINE-21) |
| `CHOOSE_STATION` | "Look Up" | the same | The chooser for that recognition (T51) |
| `NO_MATCH`, `INVALID_AUDIO` | "Look Up" | the same | The History tab, where the row says "Not recognised" |
| Deleted unsent (24 hours, 422) | — no notification — | | |

The brand, the ad, the station and the buttons appear only inside the app, after the tap. Because the
words carry nothing private, the notification is the same on the lock screen (public visibility; no
separate public version). The Saved screen's panel keeps the wireframe's "You'll get a notification
with the result, including the station's buttons." (P6-OFFLINE-27): the notification's tap opens the
result with its buttons. A notification is posted whether or not the app is open. A test checks that
the title and text passed to the plugin never contain a client, ad or station name (§4.2).

### 2.17 The state machine: what changes

Eleven top-level states (P6-STATE-01): Step 4's nine plus `chooseStation` and `savedOffline`. Rows
of the Step 4 table (step 4 design §2.12) not listed here are unchanged.

| # | From | Event | Condition | To | What the app does |
|---|---|---|---|---|---|
| T1′ | idle | "Tap to identify" | microphone allowed | recording | as T1, and reads "My station": its id becomes the clip's hint, fixed at capture (P6-MYSTATION-05; contract §5.8) |
| T19′ | uploading | 200 `CHOOSE_STATION` with 2–4 readable candidates, each a different station | — | chooseStation(candidates, recognition id, live) | deletes the clip |
| T19″ | uploading | 200 `CHOOSE_STATION` otherwise (fewer than 2 readable, a station twice, more than 4); 200 with an unknown status | — | error(server failure, reported); error(newer app needed) | deletes the clip |
| T21′ | uploading | 502, 503 or 504 on the 4th send | — | savedOffline(busy) | writes the clip to the outbox: same key, audio, capture time and hint (contract R1) |
| T24′ | uploading | 429 `RATE_LIMITED` (also to the registration before it) | — | savedOffline(too many tries) | writes the clip to the outbox |
| T26′ | uploading | 426 `APP_UPDATE_REQUIRED` | — | error(please update the app) | deletes the clip (contract §1.2) |
| T27′ | uploading | no answer (also when the registration before it gets none) | — | savedOffline(no connection) | writes the clip to the outbox (P6-STATE-04) |
| T31′ | busy | app hidden | — | savedOffline(busy) | stops the countdown; writes the clip to the outbox (P6-LISTENING-02) |
| T37 | — | — | — | — | **removed** with the "No connection" variant |
| T42 | uploading | 5 s since the send started, no answer | — | uploading(taking long, share sent) | — |
| T43 | uploading(taking long) | more of the clip sent | — | uploading(taking long, new share) | — |
| T44 | chooseStation | a row | — | matched or fallback, by that candidate's kind | the candidate's result; haptic tick; queues the choice; sets "My station" if "Remember" is ticked; saves to History |
| T46 | chooseStation (live) | "Cancel", drag down, system back | — | idle | nothing queued, nothing saved (gap 28) |
| T47 | chooseStation (saved) | the same | — | idle, History tab | — |
| T48 | savedOffline | "OK", Close ×, system back | — | idle | the clip stays queued |
| T49 | savedOffline | "See it in History" | — | idle, History tab | — |
| T50 | savedOffline | "Allow notifications" | — | unchanged | asks the system; the panel follows the answer |
| T51 | idle | a saved `CHOOSE_STATION` opened from History or its notification | — | chooseStation(saved) | from the History store; no request |
| T52 | matched or fallback, at medium or expanded width | "Tap to identify" in the identify pane | allowed / not allowed | recording / permissionNeeded | as T1 / T2; the result stays in History |
| T53 | matched or fallback | "Report this" → "Send report" | Q6 approved | unchanged | queues the report; the footer reads "Reported" |
| T54 | matched or fallback | an action button | piece 5 | unchanged | opens the address (Step 4) and queues the tap |

Rules the table adds: writing a clip to the outbox finishes before Saved offline shows, so "Saved" is
always true; if the write fails, the state is error(phone failure), reported, and the clip is dropped.
When five clips already wait, the oldest is deleted first and the state says so (P6-D6). Only `idle`
accepts a new identify, except T52 where the identify pane is visible beside a result. Every row has a
unit test (§4.2).

---

## 3. Architecture

### 3.1 Folders

New and changed files only; Step 4's tree is in step 4 design §3.1. Every file is named after its one
main type, in full words.

```
apps/mobile/
  l10n.yaml                              gen-l10n settings (§3.17)
  packages/
    device_services/                     in-repo Flutter plugin, path dependency (§3.15; no download)
      lib/device_services.dart           DeviceServices: notifications, launch recognition id, metered network, network events
      android/src/main/kotlin/zm/lookup/device_services/DeviceServicesPlugin.kt
      ios/Classes/DeviceServicesPlugin.swift   stub: reports "not supported" (iOS later; gap 32)
  lib/
    l10n/       app_en.arb, app_localizations*.dart (generated, committed), fallback_localizations.dart
    app/
      app_router.dart                    shell route, flow routes, the narrowed redirect (§3.7)
      app_route.dart                     + chooseStation, savedOffline, history, settings, myStation,
                                           privacy, about, savedResult
      app_shell.dart                     the tab shell; panes at medium and expanded widths (§3.19)
      main_navigation_bar.dart, main_navigation_rail.dart
      pending_destination.dart           where to land after a flow ends ("See it in History", notification)
      saved_result_page.dart             composes Result with a History entry (/r/<id>)
      outbox_run_scheduler.dart          starts outbox runs: start, resume, network back, new item, and
                                           the wake-up after a wait while in the foreground (§3.9)
      deferred_result_handler.dart       implements identify/domain's DeferredResultSink: History, then
                                           the notification (§3.9, §3.11)
      engine_identity.dart               this engine's id, for the lock files (§3.8)
      background_entry_point.dart        the WorkManager dispatcher (§3.10; only if approved)
    core/
      outbox/   outbox_item.dart, outbox_item_kind.dart, outbox_item_group.dart (clips, follow-ups, crash
                reports), outbox_store.dart, outbox_index_file.dart, outbox_sender.dart,
                outbox_item_sender.dart (one interface per kind), outbox_send_answer.dart,
                outbox_acknowledgement_policy.dart, outbox_action.dart, outbox_timing_rules.dart,
                outbox_background_job.dart
      files/    owned_lock_file.dart (lock files naming their process and engine; outbox, History, data use)
      network/  listener_route.dart (which paths carry the token), api_client.dart (+ getJson, ETag,
                upload progress, data-use metering)
      data_use/ data_use_meter.dart, data_use_store.dart (a locked file, not shared_preferences; §3.16)
      device/   notification_permission.dart, network_watcher.dart (wrap device_services)
      layout/   window_size_class.dart
      theme/    look_up_theme.dart (+ dark())
      error_reporting/  client_error_reporter.dart (+ queue on no answer), client_error_report_sender.dart
      listener_install/ listener_install_repository.dart (+ registered app version)
    features/
      identify/
        presentation/  choose_station_screen.dart, station_choice_row.dart, saved_offline_screen.dart,
                       notification_panel.dart, recognition_flow.dart (changed), identifying_screen.dart (slow),
                       how_it_works_note.dart (Home's first-open note)
        domain/        recognition_state.dart (+2), recognition_failure.dart (±), saved_clip_reason.dart,
                       chooser_origin.dart, captured_clip.dart (+ hint), send_policy.dart (changed),
                       recognition_answer.dart (candidates, ids), deferred_result_sink.dart (interface)
        data/          recognize_request_builder.dart (deferred, hint), recognize_response_parser.dart
                       (candidates, ids, city), deferred_clip_sender.dart, station_choice_sender.dart,
                       how_it_works_note_store.dart
      result/
        presentation/  result_screen.dart (footer, saved header), report_sheet.dart
        domain/        recognition_result.dart (+ recognition id, station city), recognition_report_reason.dart
        data/          engagement_recorder.dart, engagement_sender.dart, recognition_report_sender.dart,
                       https_image_provider.dart (data saver, metering)
      history/
        presentation/  history_screen.dart, history_entry_row.dart, waiting_clip_row.dart, history_empty_state.dart
        domain/        history_entry.dart (sealed), history_view.dart, day_label.dart, history_limits.dart
        data/          history_store.dart, history_repository.dart, history_providers.dart
      settings/
        presentation/  settings_screen.dart, settings_section.dart, settings_row.dart,
                       my_station_picker_screen.dart, privacy_screen.dart, about_screen.dart
        domain/        listener_station.dart, station_list.dart, data_saver_rule.dart, data_use_month.dart
        data/          my_station_store.dart, station_list_repository.dart, station_list_cache.dart,
                       data_saver_store.dart, settings_providers.dart
  test/goldens/         one folder per state; flutter_test_config.dart loads the SDK's fonts (§4.6)
  tool/                 fake_listener_api.py (routes, panel), check_apk_sizes.py, run_emulator_tests.py
```

The features are `identify`, `result`, `history` and `settings`, each with exactly `presentation`,
`domain` and `data` (P6-STRUCTURE-01). The outbox lives in `core/`, because clips (identify), choices
(identify), taps and reports (result) and crash reports (core) all use it; each feature supplies the
sender for its own kind, so `core/` never imports a feature (§3.8). A deferred clip's outcome reaches
History and the notification through `DeferredResultSink`, an interface in `identify/domain` that
`lib/app/deferred_result_handler.dart` implements and `appServiceOverrides` wires, so
`identify/data` never imports `history/data` (added after review, P6-D46).

### 3.2 Layer rules

Step 4's table (S4-D2) holds, with two additions checked by `layer_imports_test`:
- A feature's `domain` may import another feature's `domain` (Step 4 allowed it; P6 uses it:
  `history/domain` and `identify/domain` read `result/domain` and `settings/domain`).
- A feature's `presentation` may import another feature's `domain` and its `*_providers.dart` file,
  never another feature's screens. Screens of two features are composed only in `lib/app/` (the shell,
  the saved-result page).
- A feature's `data` never imports another feature's `data`. Where one feature's data must reach
  another's, the first declares an interface in its `domain` and `lib/app/` implements it (the
  deferred outcome: `DeferredResultSink`). `layer_imports_test` fails on a planted
  `identify/data` → `history/data` import.

`dart:io`, `path_provider`, `shared_preferences`, `device_services` and `workmanager` stay out of
`presentation` and `domain`, as Step 4's packages do.

### 3.3 Packages and downloads

Recommended: **one download, for one item** (P6-OFFLINE-08), if the user approves it (Q2). Everything
else uses the SDK, the pub cache or code in this repository. Package facts were measured on 10 October
2026; every package named was published before 26 September 2026 and supports Flutter 3.41.9 / Dart
3.11.5.

| Need | Items | Recommended | No-download way | Package if chosen (version, published, size) |
|---|---|---|---|---|
| Outbox and History storage | P6-OUTBOX-01 to -03, P6-HISTORY-01 | **No package**: app-private files with a JSON index, written atomically, on `path_provider` 2.1.6 (already pinned) (P6-D3, Q1) | (this) | `drift` 2.35.0 (2026-09-09) with `drift_flutter`, `sqlite3` 3.6.0 and code generation: about 21.9 MB, plus SQLite binaries fetched from GitHub at every fresh build. `sqflite` 2.4.2+1 (2026-04-22): 194,572 bytes |
| Sending with the app closed | P6-OFFLINE-08 (and the 24-hour deletion when the app is never opened, gap 17) | **`workmanager` 0.10.10** (2026-09-07; SDK ≥ 3.5.0, Flutter ≥ 3.38.0): 208,277 bytes for it and its five platform parts; Gradle then fetches 13 Android libraries and their metadata, 2,965,952 bytes: **3,174,229 bytes in all, at most 3,262,830** (measured in full after review; the table below; Q2) | Send only at start, resume and while open: P6-OFFLINE-08 stays open and clips wait for the next open | — |
| Result notifications and their taps | P6-OFFLINE-20, -21, -27 | **No package**: the in-repo `device_services` plugin, Kotlin on the Android framework only (P6-D15, Q3) | (this) | `flutter_local_notifications` 22.3.1 (2026-09-13): 1,651,410 bytes with its parts, plus `desugar_jdk_libs` 2.1.4 (6,168,439 bytes; desugaring switched on) and `androidx.media` 1.1.0 + `gson` 2.12.0 (599,467 bytes): about 8.4 MB |
| Mobile data or Wi-Fi; back online while open | P6-DATASAVER-05, -06; P6-OFFLINE-07 trigger | **No package**: the same plugin (`ConnectivityManager`; normal permission `ACCESS_NETWORK_STATE`) | (this) | `connectivity_plus` 7.3.1 (2026-07-23): 430,796 bytes |
| Notification permission on Android 13+ | P6-OFFLINE-20 | **`permission_handler` 12.0.3, already pinned** | — | — |
| Languages, weekday names | P6-LOCALISATION-01 to -03, P6-HISTORY-09 | **`flutter_localizations` (SDK) and `intl` 0.20.2** (the version the SDK pins; already in the pub cache) | — | — |
| Golden images | P6-TESTS-01 to -04 | **`flutter_test` only**, fonts from the SDK cache | — | (`golden_toolkit` has no version for this SDK; `alchemist` not needed) |
| Window sizes, dark theme, size check | P6-RESPONSIVE, P6-THEME-01, P6-TESTS-12 | No package | — | — |

`pubspec.yaml` after Phase 6 adds `flutter_localizations` (SDK), `intl: 0.20.2`, `device_services`
(path `packages/device_services`) and, if approved, `workmanager: 0.10.10`; `generate: true` under
`flutter:`. `pubspec_test` pins exactly that list; `flutter pub get` must succeed on 3.41.9 with no
override (S4-STACK-09).

**The WorkManager download, sized in full** (added after review; ALL-BUILD-MACHINE-04). Read on
10 October 2026 from the Gradle module files and POMs on Google Maven (`dl.google.com/android/maven2`)
and Maven Central (`repo.maven.apache.org/maven2`), and from pub.dev's package API. Nothing was
downloaded: the sizes are the servers' `Content-Length`. What the app resolves today comes from its
last release build's dependency report (`build/app/intermediates/metadata_library_dependencies_report`),
and what is already on this machine from the Gradle cache
(`C:\Users\Luckson\.gradle\caches\modules-2\files-2.1`).

*Flutter packages (pub.dev), none in the pub cache:* `workmanager` 0.10.10 (2026-09-07) 22,940 bytes;
`workmanager_android` 0.10.9 (2026-09-07) 47,830; `workmanager_platform_interface` 0.10.5 (2026-09-07)
21,462; `workmanager_apple` 0.9.11 (2026-09-07) 71,928; `workmanager_web` 0.2.0 (2026-08-04) 25,411;
`workmanager_linux` 0.1.1+1 (2026-08-03) 18,706. **Total 208,277 bytes.** Their own dependencies
(`plugin_platform_interface`, `meta`, `flutter_web_plugins`) are already in the app's lock file.

*Android libraries.* `workmanager_android` 0.10.9 asks for `androidx.work:work-runtime` 2.11.2 and
`androidx.concurrent:concurrent-futures` 1.1.0 (its `build.gradle`). Their runtime closure, after
Gradle picks the highest version each library is asked for, adds these 13, none of them in the Gradle
cache (artifact plus its POM and Gradle module file, in bytes):

| Library | Version (published) | Artifact | POM + module | Total |
|---|---|---|---|---|
| `androidx.work:work-runtime` | 2.11.2 (2026-03-25) | 1,915,957 | 5,195 + 12,803 | 1,933,955 |
| `androidx.room:room-runtime` (points to the Android variant) | 2.7.0 (2025-04-09) | — | 6,126 + 35,597 | 41,723 |
| `androidx.room:room-runtime-android` | 2.7.0 (2025-04-09) | 593,135 | 7,516 + 22,360 | 623,011 |
| `androidx.room:room-common` (points to the JVM variant) | 2.7.0 (2025-04-09) | — | 4,968 + 36,274 | 41,242 |
| `androidx.room:room-common-jvm` | 2.7.0 (2025-04-09) | 63,047 | 4,795 + 15,061 | 82,903 |
| `androidx.sqlite:sqlite` (points to the Android variant) | 2.5.0 (2025-04-09) | — | 2,889 + 22,007 | 24,896 |
| `androidx.sqlite:sqlite-android` | 2.5.0 (2025-04-09) | 39,449 | 3,184 + 6,541 | 49,174 |
| `androidx.sqlite:sqlite-framework` (points to the Android variant) | 2.5.0 (2025-04-09) | — | 3,149 + 21,466 | 24,615 |
| `androidx.sqlite:sqlite-framework-android` | 2.5.0 (2025-04-09) | 50,435 | 3,434 + 7,416 | 61,285 |
| `androidx.lifecycle:lifecycle-service` (2.6.2 asked for; the app's lifecycle 2.7.0 aligns it) | 2.7.0 (2024-01-10) | 6,103 | 5,275 + 22,716 | 34,094 |
| `androidx.concurrent:concurrent-futures-ktx` | 1.1.0 (2020-08-19) | 5,605 | 2,143 + 4,112 | 11,860 |
| `androidx.tracing:tracing-ktx` | 1.2.0 (2023-11-29) | 6,007 | 2,200 + 3,967 | 12,174 |
| `org.jetbrains.kotlinx:kotlinx-coroutines-android` (Maven Central) | 1.9.0 (2024-09-13) | 19,247 | 2,220 + 3,553 | 25,020 |
| **13 libraries** | | **2,698,985** | **266,967** | **2,965,952** |

*Already in the Gradle cache, so not downloaded:* `kotlinx-coroutines-core` and `-core-jvm` 1.9.0 (the
1,463,587-byte jar), `kotlinx-coroutines-bom` 1.9.0, `kotlin-stdlib-common` 2.2.20,
`kotlin-stdlib-jdk7` and `-jdk8` 1.8.20, and everything the app already uses: `concurrent-futures`
1.1.0, `startup-runtime` 1.1.1, `tracing` 1.2.0, `listenablefuture` 1.0, `jspecify` 1.0.0,
`annotation-experimental` 1.4.1, `core` 1.17.0, the lifecycle 2.7.0 libraries, `arch core-runtime`
2.2.0, `collection` 1.4.2 and `annotation` 1.9.1.

*Possibly, metadata of versions Gradle reads and then discards* (it may read a lower version's POM
before choosing the higher one): `lifecycle-service` 2.6.2, `annotation` 1.8.1, `core` 1.12.0,
`kotlin-stdlib` 1.3.71, 1.8.21 and 2.0.0, `kotlinx-coroutines-core` 1.3.4: at most **88,601 bytes**,
no artifacts.

**Total for Q2: 3,174,229 bytes (208,277 + 2,965,952), and at most 3,262,830 bytes.** Every package
and library was published at least two weeks before 10 October 2026 (the newest, `workmanager`
0.10.10, on 7 September). **No build tool changes:** the Android Gradle Plugin stays 8.11.1, Kotlin
2.2.20, Gradle 8.14, `compileSdk` 36, `minSdk` 24 and Flutter 3.41.9. WorkManager needs `compileSdk`
33 or higher and `minSdk` 23 (its release notes). `workmanager_android`'s build file has no
`buildscript` block, so it loads no other Android Gradle Plugin, and it applies Kotlin, which the app's
`settings.gradle.kts` already pins to the cached 2.2.20. The one library version that moves is the
app's coroutines runtime, from 1.8.1 to 1.9.0 (cached except its 19 KB Android part). Before the
dependency is added, `gradlew :app:dependencies --offline` in a scratch copy confirms the list: it
names the missing libraries without downloading them. The libraries add code to the APK; piece 3's
size check measures it against the 15 MB budget (Q10).

### 3.4 The recognition state

```dart
// features/identify/domain/recognition_state.dart — eleven subclasses, all in this library.
final class UploadingState extends RecognitionState {
  const UploadingState({this.isTakingLong = false, this.sentFraction = 0});
  final bool isTakingLong;        // 5 s or more without an answer (T42)
  final double sentFraction;      // 0 to 1, the share of the clip uploaded (T43)
}
final class ChooseStationState extends RecognitionState {
  const ChooseStationState({required this.recognitionId, required this.candidates, required this.origin});
  final String recognitionId;                 // UUID version 7, from the answer
  final List<RecognitionResult> candidates;   // 2 to 4, each a different station, in the answer's order
  final ChooserOrigin origin;                 // liveIdentify or savedRecognition
  // Amended after review: named for what the app can know. Every candidate a default card means out of
  // window, or in window with every campaign at its limit or paused after the capture (P6-D42).
  bool get areAllCandidatesDefaultCards =>
      candidates.every((candidate) => candidate.kind == RecognitionResultKind.clientDefault);
}
final class SavedOfflineState extends RecognitionState {
  const SavedOfflineState({required this.reason, required this.wasOldestClipDeleted});
  final SavedClipReason reason;               // noConnection, busy, tooManyTries
  final bool wasOldestClipDeleted;
}

// features/identify/domain/recognition_failure.dart
final class AppUpdateRequiredFailure extends RecognitionFailure { const AppUpdateRequiredFailure(); }
// Removed: ConnectionFailure (Saved offline), TooManyTriesFailure (Saved offline);
// NewerAppNeededFailure loses isSeveralStations.
```

- `RecognitionResult` (result/domain) gains `recognitionId` and `stationCity` (nullable), so the
  Result screen can queue taps and reports, and History can key its entries.
- `CapturedClip` gains `stationHintId` (nullable), read from "My station" at T1′ and never re-read.
- `RecognitionAnswer` changes: `MatchAnswer`, `NoMatchAnswer` and `ChooseStationAnswer` carry the
  recognition id and the answer's `captured_at`; `ChooseStationAnswer` carries its candidates.
- The "Remember" tick is not part of any state: it is the sheet's own widget state, passed to the
  notifier with the tapped station (`chooseStation(stationId, isRemembered)`).
- Every screen selector stays an exhaustive switch with no default branch (S4-STATE-09).

### 3.5 Answers to states (live identify)

The Step 4 table (step 4 design §3.11) holds, except these rows:

| Answer | Step 4 | Phase 6 | Clip |
|---|---|---|---|
| 200 `CHOOSE_STATION`, readable | error, newer app needed | chooseStation (T19′) | deleted |
| 200 `CHOOSE_STATION`, unreadable | (not possible) | error, server failure, reported (T19″) | deleted |
| 426 `APP_UPDATE_REQUIRED` | error, newer app needed | error, please update the app (T26′) | deleted |
| 429 `RATE_LIMITED`, to the clip or its registration | error, too many tries | savedOffline(too many tries) (T24′) | **to the outbox** |
| 502–504, the 4th send | error, server or phone failure | savedOffline(busy) (T21′); no report | **to the outbox** |
| No answer, to the clip or its registration | error, no connection | savedOffline(no connection) (T27′) | **to the outbox** |
| Busy, then the app hidden | Busy paused | savedOffline(busy) (T31′) | **to the outbox** |

Live `Retry-After` stays clamped to 1–60 s (Busy's countdown); outbox waits use 1–3,600 s (§3.9).
500, 409 past its limit, 401 past its limit and 422 keep the Step 4 behaviour (contract §5.9).

### 3.6 Providers (Riverpod 3.3.2)

New providers; Step 4's are unchanged (step 4 design §3.5). Every provider has Riverpod's retry
switched off (S4-D4), and tests replace them only through overrides (S4-TESTS-01).

| Provider | Kind | Holds | Overridden in tests |
|---|---|---|---|
| `engineIdentityProvider` | `Provider<EngineIdentity>` | this engine's id (a version-4 UUID made at start) and the process id, written into lock files | yes |
| `outboxStoreProvider` | `Provider<OutboxStore>` | the index file and the clip files | yes (temporary folder) |
| `outboxTimingRulesProvider` | `Provider<OutboxTimingRules>` | the numbers of `timing-rules.json`; the development overrides of the sending delay and the backoff base (A1) | yes |
| `outboxRandomProvider` | `Provider<Random>` | the run's wait, the backoff's jitter and the deferred clips' busy wait | yes (seeded) |
| `outboxSenderProvider` | `Provider<OutboxSender>` | one run at a time per engine | — (what is tested) |
| `outboxItemSendersProvider` | `Provider<Map<OutboxItemKind, OutboxItemSender>>` | the five kind senders, wired in `appServiceOverrides` | yes |
| `outboxRunSchedulerProvider` | `Provider<OutboxRunScheduler>`, created at start-up | lifecycle, network and new-item triggers, and the one wake-up timer at the earliest `next_attempt_at` while in the foreground (A1) | yes |
| `deferredResultSinkProvider` | `Provider<DeferredResultSink>` | History first, then the notification, for a deferred clip's outcome | yes |
| `howItWorksNoteProvider` | `NotifierProvider<HowItWorksNote, bool>` | whether Home shows the first-open note in this launch | yes |
| `liveIdentifyUnderWayProvider` | `Provider<bool>` from `recognitionFlowProvider` | true while recording, uploading or busy (no outbox send starts) | — |
| `historyRepositoryProvider` | `Provider<HistoryRepository>` | the History file | yes |
| `historyViewProvider` | `StreamProvider<HistoryView>` | waiting clips (from the outbox) and saved entries, re-emitted on every write | — |
| `myStationProvider` | `NotifierProvider<MyStationSetting, ListenerStation?>` | the chosen station | yes |
| `stationListRepositoryProvider` | `Provider<StationListRepository>` | GET, ETag, 24-hour cache | yes |
| `stationPickerProvider` | `AsyncNotifierProvider<StationPicker, StationPickerView>` | the list shown, its fetch time, refresh | — |
| `deviceServicesProvider` | `Provider<DeviceServices>` | the in-repo plugin | yes (fake) |
| `notificationPermissionProvider` | `Provider<NotificationPermission>` | permission_handler's notification permission | yes |
| `dataUseMeterProvider` | `Provider<DataUseMeter>` | the month's byte count | yes |
| `dataSaverSettingProvider` | `NotifierProvider<DataSaverSetting, bool>` | "Load ad pictures on mobile data" | yes |
| `engagementRecorderProvider`, `recognitionReportRepositoryProvider` | `Provider` | queue taps and reports | yes |

The station picker uses an `AsyncNotifier` because its screen shows loading and failure; the
recognition flow stays a plain `Notifier` over its sealed state (S4-D4).

### 3.7 Routes and navigation (go_router 17.5.0)

| Route | Path | Screen | Navigator |
|---|---|---|---|
| `home` | `/` | Home (Identify tab) | shell branch 1 |
| `history` | `/history` | History | shell branch 2 |
| `settings` | `/settings` | Settings | shell branch 3 |
| `myStation`, `privacy`, `about` | `/settings/my-station`, `/settings/privacy`, `/settings/about` | full-screen pages | root, over the shell |
| `savedResult` | `/r/:recognitionId` | a saved result | root |
| Step 4's flow routes | `/permission`, `/listening`, `/identifying`, `/result`, `/no-match`, `/busy`, `/error` | as Step 4 | root |
| `chooseStation`, `savedOffline` | `/choose-station`, `/saved-offline` | §2.6, §2.8 | root |

- **The shell** is a `StatefulShellRoute.indexedStack` around Home, History and Settings, so each tab
  keeps its scroll position (P6-NAVIGATION-01). The tab bar calls `goBranch`; rows and the chip call
  `context.go` or `push`.
- **The redirect** (P6-D14): (1) while the state is not `idle`, every location goes to the state's
  route, exactly as S4-D5 (an exhaustive switch in `AppRoute.forState`); (2) while `idle`, a flow
  route goes to the pending destination if one is set (consumed once), else `/`; (3) while `idle`,
  shell locations, the settings pages and `/r/<id>` are allowed; (4) an unknown path goes to `/`.
- **Flow screens still never navigate**; they call the notifier and the route follows. "See it in
  History", Cancel on a saved chooser and a notification tap set `PendingDestination` (a
  `ValueNotifier` in `lib/app/`) before the notifier moves to `idle`, so the redirect lands there in one
  step, with no flash of Home.
- **A notification tap during an identify** keeps its destination pending until the flow returns to
  `idle`; the identify under way is never interrupted.
- Page transitions stay a fade over motion.base, none when animations are off.

### 3.8 The outbox: items and storage

**Where.** `<getApplicationSupportDirectory()>/outbox/` — Android's app-private `files` folder,
outside the cache that the system may clear and outside the Step 4 sweep (P6-OFFLINE-03). Never
shared or external storage. Android backup is already off for everything, so nothing in it reaches
another phone.

```
outbox/
  index.json          the queue: format version, the pauses (per group, and the 426 pause), items (below)
  index.json.writing  the next index while it is written; renamed over index.json (atomic)
  index.lock          held by whoever is reading-modifying-writing the index (exclusive create)
  sending.lock        held by the engine that is running the sender
  clips/<idempotency key>.m4a
```

Each lock file holds one line of JSON naming its owner: `{"process_id": …, "engine_id": "…",
"taken_at": "…"}` (`pid` from `dart:io`; the engine id from `engineIdentityProvider`).

**Item kinds** (P6-OUTBOX-02; contract §3): `DEFERRED_CLIP`, `STATION_CHOICE`, `ENGAGEMENT`,
`RECOGNITION_REPORT`, `CLIENT_ERROR_REPORT`. Every item has `item_id` (a version-4 UUID),
`kind`, `queued_at` (UTC), `attempt_count`, `next_attempt_at` (or null) and `last_problem` (`NO_ANSWER`,
`BUSY`, `LIMITED`, `UPDATE_REQUIRED` or null, for the History subtitle). Then, by kind:

| Kind | Fields | Idempotency key (contract R12) |
|---|---|---|
| `DEFERRED_CLIP` | `idempotency_key`, `captured_at` (the phone's, UTC), `clip_duration_milliseconds`, `codec`, `station_hint_id` (or null), `audio_file`, `audio_size_bytes`, `saved_reason` | `idempotency_key`, made at capture (P6-OUTBOX-03) |
| `STATION_CHOICE` | `recognition_id`, `station_id` | `recognition_id` |
| `ENGAGEMENT` | `recognition_id`, `station_id`, `action_id`, `occurred_at` (the first tap's phone time) | `(recognition_id, action_id)`; a second tap of the same button changes nothing |
| `RECOGNITION_REPORT` | `recognition_id`, `station_id`, `reason` | `recognition_id`; one per recognition |
| `CLIENT_ERROR_REPORT` | the scrubbed `ClientErrorReport` fields, with `occurredAt`, and `report_id` | `report_id`, a version-4 UUID made when the report is queued and sent as its `X-Request-Id` on every attempt (amended after review, P6-D43). The API already takes a caller's well-formed `X-Request-Id` (`assign-request-id.ts`) and only logs reports, so a report whose answer was lost appears twice in the log under one id, and is read as one |

No item holds a phone number, a label, a link, free text, the install id or the token.

**Limits and expiry** (`timing-rules.json`): at most 5 clips — a sixth deletes the oldest waiting
clip first (P6-OFFLINE-04; P6-D6); at most 200 follow-up items and 20 crash reports; a clip is deleted
unsent 24 hours after its phone capture time (P6-OFFLINE-05), a follow-up item 7 days after it was
queued. Expiry runs at start, at resume, before every send and in the background job. An expired clip
leaves a History entry "Not sent within 24 hours — deleted" (§3.11).
- **When the 200 follow-ups are full** (amended after review, P6-D44): the oldest `ENGAGEMENT` goes
  first, then the oldest `RECOGNITION_REPORT`, then the oldest `STATION_CHOICE` — and never a choice
  while a tap of the same recognition is still queued, so a recognition is not left without its
  listener's choice while its taps wait. Crash reports: the oldest goes first.
- **A phone clock moved back** (amended after review, P6-D37). The 24 hours are counted on the
  phone's clock, which the listener or a network time update can move. So a clip is also deleted as
  expired when its `captured_at` is **more than 2 minutes ahead** of the phone's clock (the clock went
  back after the capture; the server would refuse it as `CAPTURE_TIME_INVALID` anyway), with the
  History entry "Couldn't be checked — deleted". And a clip is deleted **2 minutes before** its 24
  hours (at `captured_at` + 23 h 58 min), so a clock moved back by less than 2 minutes cannot stretch
  it past 24 hours of real time either. A clock moved forward only deletes a clip sooner.

**Writes.** Every change is read–modify–write of `index.json` under `index.lock`: the lock file is
created exclusively (fails if it exists) and removed after the write. The new index is written to
`index.json.writing`, flushed, then renamed over `index.json`, so a power cut leaves the old or the new
index, never half of one. A clip file is written and flushed before its item is added; on start, clip
files with no item and items with no file are deleted (the second with a crash report). An index that
cannot be read is moved aside, its clip files deleted, and a crash report sent: a waiting clip is
lost, but the app keeps working and no recording lingers.

**Locks are never taken over by age** (amended after review, P6-D36). The draft took `index.lock` over
after 30 seconds and `sending.lock` after 10 minutes; a slow but live engine could then lose an
update, and a lost clip item is worse than a lost answer, because the start-up sweep then deletes its
clip. Now a lock that exists is judged by its owner:
- **Another process id**: the process that wrote it has ended (an app process keeps one id for its
  whole life, and only this app writes in its private folder), so the lock is taken over.
- **This process id and an engine that is still attached**: a live engine of this process holds it,
  however long it takes. It is never taken over. The waiter retries every 50 ms. If the live flow
  cannot take `index.lock` within 10 seconds, its write counts as failed (§2.17: error, phone failure,
  reported), and nothing is taken over.
- **This process id and an engine that is no longer attached** (for example WorkManager stopped the
  background job when the network went, and its engine was destroyed mid-run): the lock is taken
  over. `device_services` keeps the process-wide set of attached engines: each engine registers its
  id at start, and the plugin removes it in `onDetachedFromEngine` (§3.15). On iOS there is no
  second engine, so a lock of this process naming another engine is taken over. Unit tests use
  `FakeDeviceServices`, whose set of attached engines the test controls.
- **How a lock is taken over**: the plugin, inside one process-wide lock, checks that the file still
  holds exactly the content that was judged dead, renames it to a unique name and deletes that; only
  then does the engine create its own lock exclusively. A lock someone else took in the meantime is
  never removed, and no take-over is ever delete-and-create.
The History file (§3.14) and the data-use file (§3.16) use the same lock files and rules.

**Who writes.** The live flow (clips, choices), the Result screen (taps, reports), the crash reporter
(reports) and the sender (outcomes). All go through `OutboxStore`, which also orders its own calls
with an internal queue, so one engine never interleaves two writes.

### 3.9 The outbox sender

One `OutboxSender` sends every kind (contract §3), one request at a time (P6-OFFLINE-10). Items fall
into three **groups**, by the server allowance they use: **clips** (`DEFERRED_CLIP`, the recognize
route), **follow-ups** (`STATION_CHOICE`, `ENGAGEMENT`, `RECOGNITION_REPORT`, which share the server's
follow-up allowance) and **crash reports** (`CLIENT_ERROR_REPORT`, the public `/client-errors` route).

1. **A run starts** on app start (after the first frame), on resume, when the network comes back
   while the app is open (the plugin's network events, from piece 3), when an item is queued, in the
   background job (P6-OFFLINE-07; contract R6), and — amended after review, contract amendment A1 —
   **by itself after a wait**: while the app is in the foreground, `OutboxRunScheduler` keeps one
   timer set for the earliest `next_attempt_at` of the items left (and for the end of a group's
   pause), so a run starts again without a restart, a resume or a network event. A run already under
   way picks new items up; a second never starts beside it. This is built in piece 1, with the first
   item kind.
2. **It takes `sending.lock`**, judged by its owner, never by its age (§3.8, P6-D36). In the
   background engine it first offers the run to the foreground engine (§3.10).
3. **It expires** clips and items (§3.8), then stops if nothing is left.
4. **It honours the pauses**:
   - **A group's pause** for a `Retry-After` (stored in the index, so a restart keeps it) holds only
     that group: its items are skipped and a wake-up is set for the pause's end, while the other
     groups go on (amended after review, P6-D38). A deferred clip's 429 can ask for up to an hour, and
     a shed 503 for up to five minutes; neither should hold back a choice, a tap or a crash report,
     which use other server allowances.
   - **The 426 pause** holds every group (the gate refuses every install-token route). It ends at the
     first of these (contract amendment A2): `AppVersion.current` differs from the version stored at
     the pause; a live identify gets any answer other than 426; or a **probe** — while paused, the
     sender sends one item at each app start and every 6 hours (a timer while the app is open, and
     the background job's six-hourly run when WorkManager is approved), choosing the oldest follow-up
     or crash report if there is one, else the oldest clip. Any answer to the probe other than 426
     resumes sending; a 426 keeps the pause. Expiry continues throughout.
5. **It waits once**: a random whole number of seconds from 0 to 120 (`outboxRandomProvider`), drawn
   once per run, not before each item (P6-OFFLINE-12; gap 17); 0 to 10 when the item that started the
   run was queued after the last run had emptied the queue. A wake-up after a `Retry-After` or a
   backoff draws no new wait (that wait was already jittered). The development flavour may lower the
   maximum (`LOOKUP_OUTBOX_SENDING_DELAY_MAXIMUM_SECONDS`, contract §4); staging and production refuse
   any value but 120 at start-up.
6. **It registers if needed**: the install's registered app version must equal `AppVersion.current`
   (contract §1.1); a re-registration carries the install's own valid token (amendment A3, §3.12). No
   answer to the registration counts as no answer for the item the run was about to send (point 9).
7. **It sends, oldest first**: clips by capture time, other items by queued time (P6-OFFLINE-11); items
   whose own wait has not ended, and items of a paused group, are skipped; a choice always goes before
   taps of its recognition (contract R7). No send starts while a live identify is recording,
   uploading or busy (`liveIdentifyUnderWayProvider`); the run waits for it to end. While Android
   reports **no network at all** (airplane mode, or Wi-Fi and data both off; the plugin's network
   state, from piece 3), no send is tried, so no failure is counted; the run ends and the
   network-back event starts the next one.
8. **It applies the acknowledgement** of each answer through `OutboxAcknowledgementPolicy.decide(kind,
   status, code, retryAfterSeconds)`, which returns one of: delete (with or without a crash report),
   keep with the item's own wait, pause the item's group, pause until the app version changes (with
   probes), register again and resend (once per run; contract R10), or keep and count a failure. The
   table is contract §3's, and every row of `fixtures/listener-outbox/acknowledgement-rules.json` is a
   unit test (P6-OFFLINE-13 to -19). Amended after review (P6-D39): the table also has a **default row
   for every kind and every class of status** the table leaves as "—" (another 2xx, another 3xx,
   another 4xx, another 5xx, and 409 on any kind), so `decide` has an action for every status from 200
   to 599 for every kind, and a test walks all of them. A second test, table-driven over the same
   file, runs the whole `OutboxSender` with a temporary folder and a fake `ApiClient` and checks, for
   each row, whether the clip file and the index item remain afterwards and when the next attempt is
   due (P6-OFFLINE-06, -13 to -17, -19).
9. **Waits** (contract R8 and amendment A1; P6-OUTBOX-04):
   - A `Retry-After` is honoured exactly, clamped to 1–3,600 s. Without one, the n-th failure of an
     item waits `min(30 × 2^(n−1), 1800) s × a random factor from 0.5 to 1.0`.
   - **No answer** (no connection, a timeout or a dropped connection) is a failure of the item that
     was being sent: it waits as above, the run ends, and the wake-up of point 1 starts the next run
     (A1). The development flavour uses a 5-second base instead of 30
     (`LOOKUP_OUTBOX_BACKOFF_FIRST_WAIT_SECONDS`); staging and production refuse any value but 30 at
     start-up, and a test proves it.
   - **When Android reports the network back** (piece 3), the waits that came from "no answer" are
     cleared, because their reason has gone, and the run draws its 0–120 s wait (point 5). Waits the
     server asked for (`Retry-After`, a 5xx backoff, a pause) are never cleared. Without this, a phone
     that tried a few times in airplane mode could wait up to half an hour after the signal returned.
   - 429 and 503 pause the item's group; 409 and 500 hold only their item.
   - **A deferred clip's busy wait** (amended after review, P6-D38): a 502, 503 or 504 answer to a
     `DEFERRED_CLIP` that carries **no** `Retry-After` pauses the clips group for a random 60–300 s
     (`deferred_shed_retry_after_minimum_seconds` and `…_maximum_seconds` of `timing-rules.json`,
     drawn from `outboxRandomProvider`), not the short item backoff. Since the server design's
     Correction 1 every 503 the API itself gives a deferred send carries a 60–300 s `Retry-After`, so
     such an answer comes from something in front of the API (a proxy's 502 or 504); without this,
     every phone's saved clips would come back within seconds exactly when the service is struggling
     (P4-DEFERRED-06's intent). A `Retry-After` that arrives is honoured as it is, whatever its value,
     so the development settings' shorter ranges still work.
   - A wall-clock wait more than an hour away (the phone's clock moved back) is cut to one hour.
10. **Deferred clip fields** (P6-OUTBOX-07; contract R2): `is_deferred` `"true"`; the stored
    `captured_at` and `idempotency_key`; `sent_at` taken just before each attempt; `station_hint` from
    the item, or absent; every text field before the audio part. `RecognizeRequestBuilder` gains an
    `isDeferred` parameter and builds both live and deferred requests, so the two cannot drift.
11. **The background run stops starting sends after 8 minutes** (added after review): WorkManager
    allows about 10 minutes per job, so a run in the background engine starts no new send after 8
    minutes, releases `sending.lock` and asks WorkManager to run it again. If WorkManager stops the job
    sooner (for example because the network went), its engine is destroyed and its locks are taken
    over by the rule of §3.8.

The kind senders (`DeferredClipSender` and `StationChoiceSender` in `identify/data`, `EngagementSender`
and `RecognitionReportSender` in `result/data`, `ClientErrorReportSender` in `core/error_reporting`)
each turn one item into an `ApiAnswer` and return an `OutboxSendAnswer` (status, code, `Retry-After`,
no answer, or a phone fault). `DeferredClipSender` also reads a 200 with `RecognizeResponseParser` and
hands the outcome to `DeferredResultSink` (§3.2, §3.11). **Order of a deferred outcome** (amended after
review): the History entry is written first, with the clip's idempotency key, and the outbox item is
deleted after it. A crash between the two leads to a resend, which the server answers with a replay
of the same recognition id, so History, keyed by that id, gains nothing twice; until the item is
deleted, the History view hides a waiting row whose key already has an entry, so the listener never
sees both.

### 3.10 Sending in the background (only if approved; Q2)

- **Android, with `workmanager` 0.10.10** (P6-OFFLINE-08): when an item is queued, and when the app is
  hidden with items waiting, the app enqueues the unique one-off work `look-up-outbox-send` (keep the
  existing one) with the constraint "network connected" and an exponential backoff from 30 s. While a
  clip waits, or while the 426 pause holds, the unique periodic work `look-up-outbox-expiry` runs
  every 6 hours with no network constraint, so a clip is deleted on time even if the app is never
  opened again (gap 17), and the 426 pause sends its six-hourly probe (§3.9 point 4, A2); it is
  cancelled when the outbox empties.
- **The dispatcher** (`background_entry_point.dart`, a top-level `@pragma('vm:entry-point')`
  function) checks the build's configuration as `bootstrap()` does (doing nothing if it is refused),
  builds a `ProviderContainer` with the same services and no UI, and looks up the port
  `look-up-outbox` in `IsolateNameServer`. If the foreground engine registered it (it does while the
  app is resumed), the job asks it to run the sender and ends. Otherwise the job runs the sender
  itself and reports any failure through the crash reporter (queued if offline). It always tells
  WorkManager it succeeded unless the run ended for want of a network, or stopped at its 8-minute
  limit with items still due, in which cases WorkManager retries on its own backoff. The in-app
  wake-up timer of §3.9 point 1 runs only in the foreground engine; in the background, WorkManager's
  backoff does that job.
- WorkManager allows about 10 minutes per job. The background run starts no new send after 8 minutes
  and releases its locks (§3.9 point 11); the longest normal run (a 120-second wait, then at most 5
  clips at up to 60 seconds each) fits inside that.
- **Without the package**, and on **iOS** (P6-OFFLINE-09), stored items are sent at the next start or
  resume, and expiry runs then; the start-up path does this whenever no background work exists, which
  a unit test proves with the platform set to iOS.

### 3.11 Deferred results: History and notifications

What a deferred clip's answer becomes (contract R13; P6-OFFLINE-20):

| Answer | History entry (keyed by recognition id, so a replay never doubles it) | Notification (§2.16) |
|---|---|---|
| 200 `MATCH` | a result | "Look Up" / "Your saved clip has been checked. Tap to see the result." (A6); opens the result |
| 200 `CHOOSE_STATION` | waiting for a choice, with the candidates | the same words; opens the chooser |
| 200 `NO_MATCH`; 400 `INVALID_AUDIO` | not identified, "Not recognised" (keyed by the idempotency key when there is no recognition id) | the same words; opens History |
| 422 `CAPTURE_EXPIRED`; deleted unsent at 24 hours | "Not sent within 24 hours — deleted" | none |
| 422 `CAPTURE_TIME_INVALID`; an unreadable 200; a capture time more than 2 minutes ahead of the phone's clock (§3.8) | "Couldn't be checked — deleted" (the unreadable 200 also reported) | none |

The History entry is written before the outbox item is deleted, and the History view hides a waiting
row whose idempotency key already has an entry, so the listener sees the row turn into the entry in
one step (§3.9, amended after review). The notification is posted after the History write, with the
generic words of §2.16 (A6). A deferred `CHOOSE_STATION` opened later becomes the chooser (T51); its
choice has no time limit on the server (contract §1.3).

### 3.12 API client and install changes

- **`ListenerRoute.carriesInstallToken(path)`** replaces `listenerRoutePaths`: `recognize`, `stations`,
  `engagements`, and `recognitions/<lower-case uuid>/choice` or `/report`. `client-errors` never
  carries the token, and `installs` carries it only on a re-registration (contract §1.0 and
  amendment A3; below).
- **`getJson(path, {installToken, ifNoneMatch})`** returns an `ApiAnswer` and never throws, like the
  POST methods; `ApiAnswerReceived` gains `entityTag` (the `ETag` header, when it came once), and a 304
  is an ordinary received answer.
- **`postMultipart(…, onSendProgress)`** passes Dio's upload progress to the flow (T42, T43).
- **Data use**: every attempt reports its request body's size and its answer body's size (UTF-8
  bytes) to `DataUseMeter` (§3.16).
- **The install** (contract §1.1): `ListenerInstallRepository` stores the `app_version` it registered
  with (`listener_install_registered_app_version`); `ensureRegistered()` registers again, with the same
  install id, whenever it differs from `AppVersion.current` (Step 4 installs have none stored, so they
  register once more after the update). Nothing is sent with the old token in between.
- **A re-registration carries the install's token** (amended after review; contract amendment A3).
  When the app registers again and still holds a token that has not reached its stored expiry, it
  sends `Authorization: Bearer <that token>` with `POST /installs`, so the server counts it against
  the install's own re-registration allowance (5 a day) and not against the per-address limit that
  many listeners behind one carrier address share. A first registration, and one after a 401 (the
  token was refused and forgotten), carries none. This is the one exception to "never on `/installs`"
  (contract §1.0), and the security baseline's row on where the token goes changes with it. The
  stand-in accepts a token it issued on `/installs` and logs the request as a re-registration (§4.7).
- **Two engines and `shared_preferences`** (added after review, P6-D45). Each engine keeps its own
  cached `SharedPreferences`, so the values both engines touch — the install token, its expiry and
  the registered app version — are read after `SharedPreferences.reload()` and written straight
  after it. Otherwise the foreground engine could keep using a token the background engine replaced,
  get a 401 and register once more for nothing. The data-use count, which both engines add to, moves
  out of `shared_preferences` into a locked file (§3.16). "My station", the pictures switch and the
  first-open flag are written by the foreground engine only.

### 3.13 "My station" and the station list

- **`MyStationStore`**: `shared_preferences` key `my_station`, a JSON object `{id, name,
  frequency_label, city}`. Set by "Remember" (T44) or the picker; cleared only by the picker's "No
  station". The app never clears it by itself, even when the fresh list lacks it (contract §5.8).
- **The hint** is read at capture (T1′) and stored with a clip that goes to the outbox; the request
  builder adds `station_hint` when it has one and leaves it out otherwise (P6-MYSTATION-05).
- **An unlisted station** (added after review). The app never filters the chooser's candidates: it
  shows what the server sent. A station whose owner turned "Show my station in the app" off can
  therefore be chosen with "Remember" ticked and become "My station"; the picker then shows it at the
  top as "Not in the current list" (§2.12), and the app keeps sending it as the hint. Whether the
  server honours that hint is the server's rule; the recommended answer is yes when the station is a
  candidate, because it airs the ad (§10, correction 5). The app works the same either way.
- **`StationListRepository`** (contract §1.4): `GET stations` with the install token and
  `If-None-Match`; the answer is read by the `ListenerStationList` rules (strict object, distinct ids,
  at most 1,000); the cache is `<app support>/stations/station-list.json` with `fetched_at`, the
  `ETag` and the stations. It fetches only when the cache is missing or older than 24 hours
  (P6-MYSTATION-04; a `fetched_at` more than an hour in the future counts as stale). A 304 keeps the
  list and resets `fetched_at`; every error keeps the cache. It is never an outbox item.

### 3.14 The History store

- **Where**: `<app support>/history/index.json`, written like the outbox index (lock file, atomic
  rename), because the background engine writes results too.
- **Entry**: `entry_id` (the recognition id, or the idempotency key when there is none), `kind`
  (`RESULT`, `AWAITING_CHOICE`, `NOT_IDENTIFIED`), `not_identified_reason`, `captured_at_on_phone`,
  `saved_at`, `was_deferred`, `deferred_idempotency_key` (the clip's key, so the waiting row can be
  hidden, §3.9), `was_notified` (a notification was posted for it, §3.15), `answer` (the result
  object or the candidates **exactly as the API sent them**), `chosen_station_id`, `is_reported`.
- **Reading**: the stored answer is read again by `RecognizeResponseParser` and the shared card reader
  every time it is shown, so a newer app reads old entries with its newer reader, and an entry the
  reader refuses is dropped and reported.
- **Times**: rows show the phone's own capture time (contract §5.14); the answer's corrected
  `captured_at` is kept in the entry for completeness.
- **Limits** (Q7; gap 20): at most 50 entries and 30 days; the oldest go first; checked on every write
  and at start. Cards are not refreshed after saving; pictures are never stored (they load like any
  result's, under the data-saver rule). "Clear history", if approved, empties this file and deletes
  every waiting clip.
- **Picture addresses in saved entries** (added after review; checklist-3 gap 38, checklist-2 gap 8).
  A saved entry keeps the answer's picture addresses as sent and loads them again when shown. How long
  an address stays valid (a public path, or a signed address and its lifetime) is not decided, because
  no station can upload a picture yet (fact 17). Decision: it is decided with the portal's picture
  screens, and the rule then is that an address in an answer stays valid for at least History's 30
  days, or the server re-signs it on replay. Until then a picture that no longer loads leaves its box
  out, as any failed picture does (Step 4), and the buttons still work (P6-D53).

### 3.15 Notifications and the network: the `device_services` plugin (P6-D15)

A Flutter plugin package in this repository (`apps/mobile/packages/device_services`), so it registers
in the background engine as well as the app's. Android only in Phase 6, Kotlin, on the Android
framework only (no AndroidX, so no Gradle download):

| Dart method or stream | Android |
|---|---|
| `areNotificationsEnabled()` | `NotificationManager.areNotificationsEnabled()` |
| `showSavedClipNotification({notificationId, title, text, recognitionId, opensChooser})` | creates the channel (Android 8+), builds `Notification.Builder` with the monochrome `notification_icon` drawable, public visibility (the words are the generic ones of §2.16, A6), and a `PendingIntent` to the app's launch intent with the extra `zm.lookup.recognition_id`, made with **request code = `notificationId`** and `FLAG_UPDATE_CURRENT | FLAG_IMMUTABLE` (amended after review: two intents that differ only in their extras are one `PendingIntent` to Android, so without its own request code the older notification would open the newer result) |
| `takeLaunchRecognitionId()` and the `launchRecognitionIds` stream | the extra from the intent that started the activity, and from `onNewIntent`; read once, then cleared |
| `isActiveNetworkMetered()` | `ConnectivityManager.isActiveNetworkMetered()` |
| `networkAvailability` stream | `registerDefaultNetworkCallback` (`onAvailable`, `onLost`); also the current state, so the sender knows when there is no network at all (§3.9 point 7) |
| `registerEngine(engineId)`, `isEngineAttached(engineId)` (added after review) | a process-wide set of attached engines (a Kotlin `object`); an engine's ids are removed in `onDetachedFromEngine`, which runs when its `FlutterEngine` is destroyed (§3.8) |
| `takeOverDeadLock(path, expectedContent)` (added after review) | inside one process-wide `synchronized` block: if the file still holds exactly `expectedContent`, rename it to a unique name, delete that, and answer true; otherwise answer false (§3.8) |

The Dart side checks a launch id is a lower-case UUID version 7 before routing to it, and (amended
after review) honours it only when it names a History entry marked `was_notified`, that is, a
recognition this app posted a notification for; anything else is ignored. The draft said no other
app could open a route; that was wrong: there is no URL scheme and no deep-link intent filter, but
`MainActivity` is exported for the launcher, so any app can start it with that extra (fact 26). With
the `was_notified` check, another app can at most reopen a result this phone was already told about,
and only if it knows the recognition id, which is random (UUID version 7, 74 random bits) and never
leaves the phone except to Look Up's API. The security-baseline row says exactly that.
The permission (Android 13+) is asked through `permission_handler`'s `Permission.notification`, only
from "Allow notifications" (T50). iOS: the plugin's iOS side reports "not supported", so the Saved
screen shows the "result will wait in History" panel.

### 3.16 Data use and the data saver

- **"Used this month"** (P6-DATASAVER-03; gap 21, Q11): `DataUseMeter` adds every request body and
  answer body the app's own client sends or receives, and every picture `HttpsImageProvider` downloads;
  headers and the connection's own overhead are not counted. The count is kept per calendar month of
  the phone (`month` like `2026-10`, `bytes`) and starts again at 0 on the 1st. Amended after review:
  it lives in `<app support>/data_use/data-use.json` under the lock-file rules of §3.8, not in
  `shared_preferences`, because the foreground and background engines both add to it, and each
  engine's cached `SharedPreferences` would lose the other's bytes (P6-D45).
- **"Each identify uses about 25 KB"** repeats Home's figure (S4-D31: 27–31 KB measured, revisited
  above 35 KB).
- **"Load ad pictures on mobile data"** (P6-DATASAVER-04 to -06): stored as
  `load_pictures_on_mobile_data` (default true). `DataSaverRule.mayLoadPictures(isSwitchOn,
  isNetworkMetered)` (pure, `settings/domain`) is false only when the switch is off and the network is
  metered; "mobile data" means a metered network (a phone's hotspot counts too, which is the point).
  When false, the Result has no banner box and shows initials instead of logos, decided before the
  first frame; no picture request is made; the buttons work as ever.
- **How the pictures are shown live** (amended after review, P6-D49). No picture can load on the
  emulator (fact 17), and the app keeps refusing plain `http` pictures in every flavour: there is no
  development exception. P6-DATASAVER-05 and -06 are proven by widget tests with a fake metered or
  unmetered network and a fake image client that records every request, and shown live on the user's
  phone with the stand-in behind the `https` ngrok tunnel (§5.0 (c)): the stand-in rewrites the
  fixture's picture addresses to its own public `https` origin and serves two pictures it draws
  itself. On mobile data with the switch off no picture is requested; with it on, or on Wi-Fi, both
  load.
- **Banners at the device's width, as WebP** (P6-DATASAVER-01): deferred with the contract (§5.15): no
  station can upload a picture yet, and the answer has one banner address. The app already decodes at
  the box's width (S4-D20).

### 3.17 Localisation (P6-LOCALISATION-01 to -03)

- `l10n.yaml`: `arb-dir: lib/l10n`, `template-arb-file: app_en.arb`, `output-class: AppLocalizations`,
  `nullable-getter: false`; the generated files are committed, and the gate regenerates them and fails
  on any difference (as the token generator's drift check, S4-THEME-05).
- **Every** user-visible string moves to `app_en.arb`, development-only text included, with
  descriptions; counts use ICU plurals ("8 seconds left", "1 second left"). Key names are full words
  (`savedOfflineHeadingNoConnection`).
- `supportedLocales` and the delegates come from the generated class only. A
  `FallbackMaterialLocalizationsDelegate` (and its Cupertino twin) gives English Material texts to a
  locale Flutter's own delegates do not support, and `DayLabel` falls back to English date symbols for
  a locale `intl` has none for (§2.9, amended after review), so `app_bem.arb` or `app_ny.arb` alone
  adds a language (P6-LOCALISATION-03, proven by a scratch build that switches to the stub language
  and opens Home, the chooser, History with entries of every age, and Settings).
- The app keeps its own words for every error code; the API's `message` is never shown in any language
  (S4-D13; gap 23).
- Phone numbers stay in the +260 display form (P6-LOCALISATION-04, built in Step 4).
- **English only (the user's decision, 13 October 2026).** No Bemba or Nyanja is planned, so the scratch
  Bemba build of P6-LOCALISATION-03 is withdrawn. The one English language file stays (it keeps every
  sentence in one place), and so do the fallbacks for phone languages the app does not have, so every
  phone gets English. If a language is ever added after all, English must first be made the fallback:
  the scratch build of piece 2 showed `gen-l10n` listing `bem` before `en`, so a phone set to a language
  the app did not have (French) got the Bemba words.

### 3.18 The dark theme (P6-THEME-01)

`LookUpTheme.dark()` mirrors `light()` from `LookUpTokens.dark` (`ColorScheme.fromSeed(…,
brightness: Brightness.dark)`, then the exact token colours copied over). `MaterialApp.router` gets both
themes and `themeMode: ThemeMode.system`, so the app follows the phone. The scrim, rings, badges and
the notification panel use tokens in both. `look_up_tokens_test` checks every text/background pair the
app uses at 4.5:1 in **both** palettes (P6-ACCESSIBILITY-03), and every widget test runs
`textContrastGuideline` in both themes.

### 3.19 Window sizes and orientation (P6-RESPONSIVE)

- **One helper**, `WindowSizeClass.of(context)`, reads `MediaQuery.sizeOf(context).width` against the
  tokens' breakpoints (600, 840): compact, medium, expanded (P6-RESPONSIVE-02). A scan bans
  `MediaQuery.of(context).size`.
- **Compact (below 600 dp)**: the wireframes; one column; the bottom tab bar (P6-RESPONSIVE-03).
- **Medium (600–839 dp)**: a navigation rail at the left instead of the bar. Identify tab: Home in a
  column; while a result shows, Home on the left and the Result in a side panel on the right (45% of
  the width, at least 360 dp) (P6-RESULT-02, P6-RESPONSIVE-04). History and Settings: one column at
  most 600 dp wide, centred.
- **Expanded (840 dp and wider)**: the rail, and two panes per tab: Identify — Home | the result, or
  History when there is none (P6-RESPONSIVE-05); History — the list | the selected saved result;
  Settings — the list | the page opened (picker, Privacy, About).
- **Flow screens** other than Result stay one centred column at most 600 dp wide, with no rail; the
  chooser and report sheets at most 640 dp wide.
- **Orientation**: never locked (`setPreferredOrientations` stays banned); a phone on its side
  (800 × 360) is "medium" by width and reflows, scrolling where the height is short
  (P6-RESPONSIVE-07). Portrait is designed first (P6-RESPONSIVE-06).

### 3.20 Crash reports made offline (P6-ERRORREPORTING-05)

When a report gets no answer, `ClientErrorReporter` queues it as a `CLIENT_ERROR_REPORT` item: the
already scrubbed fields plus `occurredAt` (the phone's time of the error; contract §1.7), at most 20,
kept 7 days. The outbox sends it with its own `report_id` as the `X-Request-Id` on every attempt
(amended after review, P6-D43; §3.8); any answer but no answer, 429 or 5xx deletes it, and a report
about a failed report is never made (contract §3 table). A 429 pauses only the crash-report group
(§3.9 point 4). The once-a-minute
and 10-a-minute limits still apply when a report is made. A phone failure whose report was queued
shows no reference code (Step 4's rule: a code only for a report the API accepted).

### 3.21 Android and iOS settings

- **Permissions** (merged manifest, checked by `android_project_test`): `INTERNET`, `RECORD_AUDIO`
  (Step 4); `POST_NOTIFICATIONS` (asked only on "Allow notifications"); `ACCESS_NETWORK_STATE`
  (normal, the plugin); with WorkManager, also `WAKE_LOCK` and `RECEIVE_BOOT_COMPLETED`, which
  `androidx.work` merges and needs to run and to survive a reboot. `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_SHORT_SERVICE` and `SystemForegroundService` are removed with
  `tools:node="remove"`, each with its reason in a comment. The `POST_NOTIFICATIONS` that
  `workmanager_android` also merges is the app's own permission anyway, so it is kept (a
  `tools:node="remove"` on it would remove the app's declaration too).
  The security baseline's permission row changes to this exact list.
- **Notification icon**: `res/drawable/notification_icon.xml`, a white vector (no image file). Named
  in full words (amended after review; ALL-NAMING-02: the draft's `ic_` abbreviated "icon"). Flutter's
  own `@mipmap/ic_launcher` from Step 4 keeps its generated name.
- **Release builds** (P6-PERFORMANCE-01, -02; Q10): `flutter build apk --release --split-per-abi`
  (arm64-v8a, armeabi-v7a, x86_64), and, if approved, `packaging { jniLibs { useLegacyPackaging =
  true } }` in `android/app/build.gradle.kts` for release, so native libraries are compressed.
- `<queries>`, backup, cleartext and flavours are unchanged (step 4 design §3.20).
- **iOS**: no background mode (best effort at the next open), no notification macro in the Podfile
  (no iOS notifications in Phase 6), the plugin's stub; checked by file review only (gap 32).

### 3.22 Privacy

| Data on the phone | Where | Lifetime | Leaves the phone |
|---|---|---|---|
| A waiting clip | `outbox/clips/`, app-private, no backup | until acknowledged (200, `INVALID_AUDIO`, 422, other permanent refusals), 24 hours after capture, "Clear history", or uninstall | only to `POST /recognize` |
| Choices, taps, reports | `outbox/index.json` | until acknowledged, 7 days | only to their routes; ids, times and a reason code |
| Queued crash reports | `outbox/index.json` | until sent, 7 days | only to `/client-errors`, scrubbed as in Step 4 |
| History | `history/index.json` | 50 entries, 30 days, "Clear history" | never |
| "My station" | `shared_preferences` | until changed | as `station_hint` |
| Station list | `stations/station-list.json` | refreshed after 24 hours | never (public data) |
| Data-use count | `data_use/data-use.json` (locked file) | the month | never |
| First-open flag | `shared_preferences` | until uninstall | never |
| Lock files | `outbox/`, `history/`, `data_use/` | while held | never; they name a process id and a random engine id, nothing about the listener |

No new store holds the install id, the token, the listener's own phone number or any free text. No
log line or crash report carries audio, card contents, numbers or links. Notifications never name the
brand, the ad, the station or the outcome, on the lock screen or anywhere else: they say only "Look
Up" / "Your saved clip has been checked. Tap to see the result." (A6). New security-baseline rows
(ALL-SECURITY-06): the outbox (app-private, bounded, expiring, atomic, locks judged by owner), History
(app-private, bounded, clearable), the station cache, notifications (generic words, a request code per
notification, launch ids honoured only when this app notified them, no deep-link scheme), the
background job (no foreground service), and the changed rows on permissions, the token's routes (now
also a re-registration, A3) and the clip's lifetime (24 hours on a clock that may move, §3.8).

### 3.23 Changes outside `apps/mobile`

1. **`packages/contracts`**: everything in contract §2 (schemas, constants, reason codes, error
   envelopes, emitted JSON Schemas, fixtures), with the data rules of contract §2.7: every new or edited
   fixture uses `+447700900NNN` and `https://example.com/…`.
2. **`apps/api`**: the P4 design (contract §1). Its development seed is the one the P4 design's §5.15
   defines (amended after review, so the two designs agree): Station B, "104.3 FM", Kitwe, Copperbelt,
   ACTIVE, listed, with Station A's owner as a member; at Station B the client "Brand A" and the ad
   "Summer service offer" with the same jingle as Station A's, its campaign a DRAFT with an all-day
   schedule that the walkthrough publishes in the portal; default cards for Brand A at both stations
   and for Brand B at Station A; sample numbers from `+447700900001` up and links on
   `https://example.com/`.
3. **`apps/mobile/tool/fake_listener_api.py`**: contract §4, plus P6-D30 and P6-D50 (control page,
   forwarded requests refused, control requests checked for their content type, origin and host, the
   offline switch acting before any scenario is taken, a `slow-upload` scenario, `match-with-images`
   with its addresses rewritten to the stand-in's public origin, the number replacement taken from the
   control page, `occurredAt` accepted, a token accepted on a re-registration); §4.7.
4. **Docs**: this file; the security-baseline rows of §3.22; checklist 3 gains the new behaviours this
   design adds once approved (ALL-CHECKLIST-06; §7, P6-D34) and P6-OUTBOX-01's wording after Q1;
   `docs/conventions.md` gains the outbox and History file layouts and the ARB key rule.

---

## 4. Tests

### 4.1 Rules

Step 4's rules hold (step 4 design §4.1): every test can fail the build; no skips at a gate; fakes only
through provider overrides; shared fixtures read from `packages/contracts`, never copied;
`expectNoTechnicalText` on every failure path. Added:
- Every new screen's widget test runs `androidTapTargetGuideline`, `labeledTapTargetGuideline` and
  `textContrastGuideline` in both themes, checks no overflow at 320 × 640, 360 × 800 and 411 × 891, and
  at text scale 2.0, and asserts its words from the ARB file's English value (P6-ACCESSIBILITY-01,
  -05; P6-RESPONSIVE-01, -03).
- Time is always a `FakeClock`, randomness a seeded `Random`, the platform plugin a
  `FakeDeviceServices`, files a temporary folder.
- No test talks to a real network, notification shade or WorkManager; those are the emulator's.

### 4.2 Unit tests

| File | Proves |
|---|---|
| `core/outbox/outbox_store_test.dart` | each kind queued and read back (P6-OUTBOX-02); items survive closing and reopening (P6-OUTBOX-01); atomic write (a crash between write and rename leaves the old index); clip file under the app-support folder, never the cache or external storage (P6-OFFLINE-03); 6 captures leave 5, the oldest gone (P6-OFFLINE-04); expiry at 24 h + 1 s with nothing sent (P6-OFFLINE-05); a clip whose `captured_at` is more than 2 minutes ahead after the FakeClock is set back one day is deleted at once with "Couldn't be checked — deleted", and one set back 1 minute is deleted by 24 hours of real time (P6-D37); follow-ups at 7 days; at 200 follow-ups taps go before reports, reports before choices, and a choice with a queued tap is never evicted (P6-D44); orphans swept; an unreadable index moved aside and reported; **two engines simulated as two `OutboxStore` instances, one stalled for 40 s while holding `index.lock`, lose no item** and the other is never allowed to take the lock over (P6-D36) |
| `core/outbox/outbox_sender_test.dart` | contract R1–R13 app column: one in flight with a slow fake network (P6-OFFLINE-10); 10:00, 10:05, 10:10 in order (P6-OFFLINE-11); the first send at the drawn second, one wait per run (P6-OFFLINE-12); three failed sends one key, two items two keys (P6-OUTBOX-03); growing waits and `Retry-After` 120 honoured (P6-OUTBOX-04); captured 10:00, sent 11:00 (fails) and 11:30, both `"true"`, same key and capture time (P6-OUTBOX-07); 401 then 204: one registration, one resend; no send while a live identify is under way; a wake-up after a pause draws no new wait. Added after review: **A1** — no answer at 10:00:00 with the app left open and nothing else happening, then the next send at the drawn second inside [10:00:15, 10:00:30] (FakeClock, seeded `Random`); a 409 item with nothing else queued is sent again after its `Retry-After` 3 s; a 500 item after its backoff; the development base of 5 s accepted only in development and staging and production held to 30 s. **A2** — a 426, then a probe at the next start answered 204 resumes sending; a probe answered 426 keeps the pause; a probe every 6 hours; a live identify answered 200 resumes it; a version change resumes it. **Groups** — a clip's 429 with `Retry-After` 2,400 leaves a queued choice and a crash report sent at once; a follow-up's 429 leaves clips going (P6-D38). **Busy wait** — a deferred clip's 502 or 503 with no `Retry-After` pauses clips for the drawn 60–300 s; a `Retry-After` of 187, or of 15, is honoured as it is. **Network** — no attempt and no failure counted while the fake network reports none; the network back clears the no-answer waits but not a 429's. **Order** — a crash injected between the History write and the item's deletion leads to one resend and one History entry |
| `core/outbox/outbox_acknowledgement_policy_test.dart` | every row of `acknowledgement-rules.json` (P6-OFFLINE-13 to -19); and every status from 200 to 599 gives an action for every kind, through the default rows (P6-D39) |
| `core/outbox/outbox_acknowledgement_files_test.dart` (added after review) | table-driven over `acknowledgement-rules.json`: the whole `OutboxSender` with a temporary folder and a fake `ApiClient`; for each row, whether the clip file and the index item remain and when the next attempt is due — after a 200 the file and item are gone (P6-OFFLINE-06, -13); after each 422 and `INVALID_AUDIO` gone and not retried (-14, -15); after 409 kept and due after `Retry-After` with the same key (-16); after 429 kept and retried later (-17); after no answer kept and pending (-19) |
| `core/files/owned_lock_file_test.dart` (added after review) | a lock naming another process id is taken over; one naming this process and an attached engine is never taken over, however old its time; one naming a detached engine is taken over; two engines judging the same dead lock at once: only one takes it, and a lock taken in between is never removed |
| `core/outbox/outbox_timing_rules_test.dart` | the Dart constants equal `timing-rules.json`; the development overrides (sending delay, backoff base) accepted only in development |
| `core/outbox/outbox_background_job_test.dart` | hands off to a registered foreground port; runs itself otherwise; refused configuration does nothing; with the platform set to iOS, start-up sends stored clips (P6-OFFLINE-09) |
| `app/outbox_run_scheduler_test.dart` | start, resume, network back and a new item each start a run (P6-OFFLINE-07); the wake-up timer is set for the earliest `next_attempt_at` while in the foreground and starts a run when it fires, and is cancelled when the app is hidden (A1); hidden with items waiting enqueues the background work (fake) |
| `app/deferred_result_handler_test.dart` (added after review) | History is written before the notification is asked for; the title and text given to `FakeDeviceServices` are exactly "Look Up" and "Your saved clip has been checked. Tap to see the result." for a match, a chooser and a no-match, and contain none of the fixture's client, ad or station names (A6); each notification has its own id |
| `core/network/listener_route_test.dart`, `api_client_test.dart` | the token on exactly the contract's listener routes; GET with `If-None-Match`; 304 read; `ETag` kept; upload progress reported; data use counted |
| `core/listener_install/listener_install_repository_test.dart` | registers again when the registered version differs; none stored counts as different; nothing sent with the old token in between; the re-registration carries the stored, unexpired token and a first registration or one after a 401 carries none (A3); two store instances (two engines): a token written by one is read by the other after `reload()` (P6-D45) |
| `core/data_use/data_use_meter_test.dart` | three identifies of known size in October sum; 1 November starts at 0 (P6-DATASAVER-03); two meters on one temporary folder (two engines) adding at once lose no byte |
| `core/layout/window_size_class_test.dart` | 599, 600, 839, 840 dp |
| `core/error_reporting/client_error_reporter_test.dart` | a report with no answer is queued with `occurredAt`, scrubbed, sent once when the network returns (P6-ERRORREPORTING-05); never a report about a report; three failed sends of one queued report carry the same `X-Request-Id`, its `report_id`, and two reports carry different ones (P6-OUTBOX-03 for crash reports) |
| `features/identify/domain/recognition_state_test.dart` | eleven subclasses (P6-STATE-01); every field non-null |
| `features/identify/domain/recognition_outcome_test.dart`, `send_policy_test.dart` | every changed row of §3.5 (T19′, T19″, T21′, T24′, T26′, T27′) |
| `features/identify/data/recognize_response_parser_test.dart` | the new response fixtures (§4.4): recognition id, captured time, city, 2–4 candidates with their cards (P6-STATE-02); the invalid ones never throw and never show a forbidden value |
| `features/identify/data/recognize_request_builder_test.dart` | `station_hint` present with a stored station and absent without (P6-MYSTATION-05); `is_deferred` `"true"` for the outbox; text fields before audio; the fields pass `recognize-request-fields.schema.json` and match the two new request fixtures |
| `features/identify/presentation/recognition_flow_test.dart` | every new or changed row T1′–T54 with fakes: `CHOOSE_STATION` gives the chooser (P6-STATE-03); a throwing fake network gives Saved offline and one clip in the outbox with the original key (P6-STATE-04, P6-OFFLINE-01); a clip retried from Busy and then from the outbox carries the same key and bytes (P6-LISTENING-02); after "Remember" the stored station is the chosen one and the next request carries it (P6-CHOOSER-07); unticked leaves it (P6-CHOOSER-08); a sixth clip deletes the oldest; a failed outbox write is a phone failure |
| `features/identify/data/deferred_clip_sender_test.dart`, `station_choice_sender_test.dart` | bodies pass the emitted schemas and match the valid fixtures; a 200 reaches History once even when replayed (contract R13); an unreadable 200 is deleted and reported |
| `features/result/data/engagement_recorder_test.dart`, `engagement_sender_test.dart` | two Call taps give one item with the first tap's time; the five fields match `engagement-input/valid`; a History tap queues too (P6-OUTBOX-06) |
| `features/result/data/recognition_report_sender_test.dart` | one report per recognition; body matches `recognition-report-input/valid` |
| `features/history/domain/day_label_test.dart` | Today, Yesterday, "Mon", "3 Oct", 24-hour times, the lower-case sentence form (P6-HISTORY-09); with the locale `bem` and with `ny`, no exception and the English "Mon" and "3 Oct" (P6-D47) |
| `features/history/data/history_repository_test.dart` | a match, a fallback and a choice each stored with the card (P6-HISTORY-01); keyed by recognition id; 50 entries and 30 days; an entry the reader refuses is dropped and reported; clear empties it and the waiting clips |
| `features/settings/data/station_list_repository_test.dart` | a second open within 24 h makes no request, after 24 h it fetches (P6-MYSTATION-04); 304 resets the time; errors keep the cache; the list fixtures (valid shown, invalid refused) |
| `features/settings/data/my_station_store_test.dart` | set, read, cleared only by "No station" |
| `features/settings/domain/data_saver_rule_test.dart` | pictures refused only when off and metered |

### 4.3 Widget tests

Each file also runs the rules of §4.1.

| File | Specific checks |
|---|---|
| `app/main_navigation_bar_test.dart` | three items Identify, History, Settings in that order with microphone, clock and sliders icons and labels under them, equal widths (P6-NAVIGATION-01, -02); the container named "Main", the current item selected for screen readers and bold (P6-ACCESSIBILITY-06) |
| `app/app_router_test.dart` | the route list (no ads route); the narrowed redirect (§3.7); `/r/<id>` of a saved result shows its card, an unknown id goes to History (P6-STRUCTURE-02); "See it in History" lands on History with no frame of Home; a notification id is opened after the flow ends |
| `features/identify/presentation/home_screen_test.dart` | the chip "My station: Station A" with the radio icon, 48 dp (P6-NAVIGATION-03); "My station: Not set"; a tap opens Settings (P6-NAVIGATION-04); the "How Look Up works" note on a first launch (empty preferences), absent on a later launch (a new `ProviderContainer` over the stored flag) whether or not "Got it" was tapped, and "Got it" hides it (ALL-USABILITY-04). Step 4's "no station chip, no bottom navigation" test is retired on purpose |
| `features/identify/presentation/choose_station_screen_test.dart` | the title, the text, both wordings (P6-CHOOSER-01, -13), including an in-window chooser whose candidates are all default cards (its campaigns at their limits), which shows "This ad is played on more than one station." (P6-D42); 2 and 4 rows, never more (P6-CHOOSER-02); row content with and without a city (P6-CHOOSER-03); rows at least 56 dp (P6-CHOOSER-04); "Remember" ticked at open, the label row toggles it (P6-CHOOSER-05, -06); a row shows that station's card at once with a fake network that fails every request after the first answer, and "via Station B" (P6-CHOOSER-09); Cancel → Home with no outbox item (P6-CHOOSER-14); only the sheet reachable by semantics, the route modal and named by the title (P6-CHOOSER-11, P6-ACCESSIBILITY-07); the handle present (P6-CHOOSER-12); drag down = Cancel; a tap on the scrim does nothing |
| `features/identify/presentation/saved_offline_screen_test.dart` | each reason's icon, heading as a status, body (P6-OFFLINE-22, -24 to -26); the oldest-clip line; the three panel states (P6-OFFLINE-27); Close "Close" → Home with the clip still queued (P6-OFFLINE-23); "OK" → Home (P6-OFFLINE-28); "See it in History" → History with the clip Pending (P6-OFFLINE-29) |
| `features/identify/presentation/identifying_screen_test.dart` | after 5 s on a fake slow network: "Still working…", the share sent, then "Clip sent — waiting for the answer" (P6-LISTENING-01) |
| `features/identify/presentation/permission_screen_test.dart` | the offline bullet's exact text (P6-PERMISSION-01); the Step 4 assertion of its absence retired |
| `features/identify/presentation/error_screen_test.dart` | "Please update the app" with a fake 426 (P6-COMPATIBILITY-02); the retired variants gone |
| `features/result/presentation/result_screen_test.dart` | "Saved to History" with the green tick after the store writes (P6-HISTORY-14); "Report this" with the flag at the bottom right, 48 dp, under the last button on matched, fallback, chosen and saved results (P6-RESULT-04, -05); "Reported" after sending; no banner request with pictures off on a metered fake network and Call still opening (P6-DATASAVER-05); the banner requested on Wi-Fi with the switch off (P6-DATASAVER-06); the default-card note "These are Brand A's usual contact details." in three named cases — out of its slots, paused after the capture, at its tap limit — each a `CLIENT_DEFAULT` answer, because the answer does not say why (A7); the "More options" tests re-run on chosen and saved results (P6-RESULT-03). Step 4's "no Saved to History, no Report this" test retired |
| `features/result/presentation/report_sheet_test.dart` | four reasons; "Send report" enabled only after a choice; the thanks snackbar; no text field anywhere |
| `features/history/presentation/history_screen_test.dart` | "History" (P6-HISTORY-03); one queued clip under "Waiting for signal" with the icon, "Clip from today, 14:32", the subtitle and "Pending" (P6-HISTORY-04, -05); no section with an empty outbox (P6-HISTORY-06); three results newest first under "Earlier" (P6-HISTORY-07); row content from fixture results (P6-HISTORY-08); rows at least 72 dp (P6-HISTORY-10); a tap opens the saved Result (P6-HISTORY-11); the note (P6-HISTORY-12); the empty state (P6-HISTORY-13); the awaiting-choice and not-identified rows; History selected in the bar (P6-NAVIGATION-05) |
| `features/settings/presentation/settings_screen_test.dart` | "Settings" (P6-SETTINGS-01); "Listening" with the row (P6-SETTINGS-02); its text with a stored station and with none (P6-SETTINGS-03); 64 dp, opens the picker (P6-SETTINGS-04, P6-MYSTATION-01); "Language" / "English" (P6-SETTINGS-05); Privacy and About open their pages (P6-SETTINGS-06, -07); the Data rows and the switch on at first launch, toggled by the whole row (P6-DATASAVER-02, -04); Settings selected in the bar (P6-NAVIGATION-06) |
| `features/settings/presentation/my_station_picker_screen_test.dart` | exactly the stations the fake GET returned, in order (P6-MYSTATION-02); search only above 10; "No station"; a kept station missing from the list; loading, refresh-failed, failed and empty states; a tap stores and returns |
| `features/settings/presentation/privacy_screen_test.dart`, `about_screen_test.dart` | wording; the version from `AppVersion.current`; the support link only with a number |
| `structure/station_lists_test.dart` | station lists only in the chooser and the picker (P6-MYSTATION-06): a scan for list builders over `ListenerStation` outside those two files, plus each other screen's widget test finding no station list |
| `app/app_shell_test.dart` | at 700 dp: identify and the result side panel both visible (P6-RESPONSIVE-04); at 1280 × 800: both panes (P6-RESPONSIVE-05); at 800 × 360: no overflow (P6-RESPONSIVE-07); identify tap beside a result starts a capture (T52) |

### 4.4 Shared-fixture tests

| Fixture set (contract §2.6) | Expected in the app |
|---|---|
| `recognition/recognize-response/valid/*` (edited and new) | each read to its state: `choose-station*` to the chooser with 2, 3 or 4 rows; `choose-station-out-of-window` with the all-default-cards text (an in-window chooser whose campaigns are all at their limits is the same answer on the wire, so it needs no fixture of its own); `match-station-without-city` without a city; `match-campaign-station-b` via Station B |
| `recognition/recognize-response/invalid/*` (new) | never throws; `choose-station-with-result`, `-five-candidates`, `-one-candidate`, `-same-station-twice` read as unreadable (server failure, reported); `candidate-with-campaign-id` shows nothing internal |
| `recognition/recognize-request/*` | the deferred and hinted fields the builder makes match the valid ones; the invalid ones fail the Dart `ContractSchemaChecker` with the fixture's `expected_issues` |
| `recognition/station-choice-input/*`, `engagement-input/*`, `recognition-report-input/*` | the bodies the app builds pass the emitted schemas and equal the valid fixtures; the invalid ones fail the checker with the expected issues |
| `recognition/listener-station-list/*` | valid lists shown; invalid ones refused |
| `recognition/listener-app-versions/comparisons.json` | (server and contracts; the app only compares for equality) |
| `errors/envelopes/*` (five new) | each maps to its row of contract §1.3–§1.5 in the acknowledgement policy |
| `listener-outbox/acknowledgement-rules.json`, `timing-rules.json` | every row and value (§4.2), including the default rows per kind and status class and the deferred clip's busy-wait rows added after review (§10, corrections 7 and 11) |
| the emitted `recognition-station-choice-input`, `record-engagement-input` and `report-recognition-input` schemas | only plain string properties and no nested `$ref` (amendment A5), so the Dart `ContractSchemaChecker`, which follows only a top-level `$ref`, can check every body; the contracts test asserts the same on its side |
| `client-error-report.schema.json` (with `occurredAt`) | queued reports pass it |

### 4.5 Structure and source scans

- `feature_folders_test`: exactly `identify`, `result`, `history`, `settings`, each with exactly
  `presentation`, `domain`, `data` (P6-STRUCTURE-01).
- `layer_imports_test`: §3.2, including no feature screen imported by another feature, no feature's
  `data` importing another feature's `data` (a planted `identify/data` → `history/data` import fails
  it), and `core/` importing no feature.
- `source_scan_test` adds: no string literal passed to `Text`, `Semantics(label:)`, `tooltip:` or a
  button outside `lib/l10n/` (P6-LOCALISATION-01); no `MediaQuery.of(context).size`
  (P6-RESPONSIVE-02); no `ThemeMode.light`; no `Color(0x` outside the tokens (the scrim included); no
  `RandomAccessFile.lock` (§3.8); no `force-stop` in the emulator driver; no +260 number and no
  `example.co.zm` link in the fixture folders contract §2.6 adds or edits (the remaining sweep is
  Q13). Each rule fails on a planted violation, as in Step 4.
- `pubspec_test`: the pins of §3.3; `generate: true`; `intl` 0.20.2.
- `android_project_test`: the permission list of §3.21 exactly; the removed services and permissions
  carry `tools:node="remove"`; the notification drawable `notification_icon.xml` exists; release
  packaging as decided (Q10).
- `ios_project_test`: unchanged plus the plugin's iOS stub present.
- `l10n_test`: every key in `app_en.arb` has a non-empty English value and a description
  (P6-LOCALISATION-02); the generated files equal a fresh `flutter gen-l10n`.

### 4.6 Golden images (P6-TESTS-01 to -04)

- `test/goldens/` with `matchesGoldenFile`; `flutter_test_config.dart` loads `roboto-regular.ttf`,
  `roboto-medium.ttf`, `roboto-bold.ttf` and `materialicons-regular.otf` from the SDK's
  `material_fonts` folder with `FontLoader` (no download), named with their exact lower-case names
  (amended after review: Windows hides a wrong case, the Linux run at P8 would not). A test lists the
  folder and fails if a named font file is not there with exactly that case.
- **Sizes** exactly 320 × 640, 360 × 800, 411 × 891 and 800 × 1280 (P6-TESTS-02); text scale 1.0 and
  2.0 (P6-TESTS-03); light and dark (P6-TESTS-04): 16 images per state.
- **States** (about 29): Home with and without a station, and with the first-open note; Permission × 3; Listening; Identifying and
  its slow variant; Which station? with 2 and 4 rows and out of window; Result (campaign, default
  card, "More options", reported); No match; Busy; Error × 5 (server, phone, recording unusable, newer
  app, please update); Saved offline × 3 reasons; History (pending and results, results only, empty);
  Settings; the picker; Privacy; About; the report sheet. About 460 images.
- Each golden test also fails on any overflow (P6-ACCESSIBILITY-05, P6-RESPONSIVE-01, -03, -06). The
  800 × 1280 images show the medium layout: the Result in a side panel (P6-RESULT-02); 360 × 800 shows
  the full-height Result (P6-RESULT-01).
- The images are drawn on Windows and regenerated on Linux at P8 (continuous integration). Step 4's
  decoration assertions stay, because they name the exact value that changed.
- The gate review adds a greyscale contact sheet of every state (P6-ACCESSIBILITY-04) and the
  screenshots of states with no wireframe (gap 4), published for the user as in Step 4.

### 4.7 The stand-in API

Contract §4 in full (routes, per-route scenario queues, replay by key, the offline and minimum-version
switches, `/__fake/state`), plus P6-D30 and, added after review, P6-D50:
- **A control page** at `http://127.0.0.1:3999/__fake/panel` (standard-library HTML): a labelled button
  per scenario ("Next answer: Which station?"), "No signal" on and off, the minimum app version, reset,
  and a live view of what the app sent and what the stand-in holds (choices, taps, reports,
  station-list requests). The emulator driver keeps using the JSON routes.
- **Forwarded requests refused**: any `/__fake/*` request carrying `X-Forwarded-For` (ngrok adds it)
  gets 404, so a phone check through the tunnel cannot drive the stand-in from the internet.
- **Control requests from other web pages refused** (added after review): every state-changing
  `/__fake/*` route is a POST that must carry `Content-Type: application/json` (a cross-site form or
  `text/plain` POST is refused; a cross-site JSON POST needs a preflight, which the stand-in never
  answers), must carry no `Origin` or exactly `http://127.0.0.1:3999`, and must have the `Host`
  `127.0.0.1:3999` or `localhost:3999` (against DNS rebinding). The panel sends exactly that; the
  emulator driver sends no `Origin`. Each rule has a test.
- **"No signal" acts first** (added after review): while it is on, a listener request's connection is
  closed before any scenario is taken from a queue, so a queued "Busy (shed)" is kept for the first
  request that gets through. A test queues a scenario, sends with "No signal" on, then off, and sees
  the scenario used by the second request.
- **Scenarios added to contract §4's list**: `slow-upload` and `match-with-images`.
  - `slow-upload` sets a small receive buffer (`SO_RCVBUF` of 2 KB) on the accepted socket and reads
    about 3 KB a second, then answers `match`. The clip (27–31 KB) may still fit in the phone's and the
    emulator's network buffers, so the app may report "Clip sent — waiting for the answer" at once
    instead of a growing percentage; the walkthrough accepts either, and the widget test with a fake
    slow network is the proof (P6-LISTENING-01).
  - `match-with-images`: the existing fixture, with its two picture addresses rewritten to the
    stand-in's own public origin, given at start as `--public-origin https://<address>` (the user's
    fixed ngrok address in a phone check; §5.0 (c)), at `/sample-images/banner.png` and
    `/sample-images/logo.png`. Those are not `/__fake/` routes, so they work through the tunnel. The
    stand-in draws the two pictures itself with the standard library (flat colours), so nothing is
    downloaded. Without `--public-origin` the scenario keeps the fixture's unresolvable addresses.
- **Re-registration** (amendment A3): `POST /api/v1/installs` accepts `Authorization: Bearer <a token
  it issued>` and logs it as a re-registration; without one, as a registration.
- **`occurredAt`** joins `CLIENT_ERROR_FIELDS` (fact 7).
- **The number replacement comes from the control page** (amended after review; contract §4 said a
  command-line flag): a form on the panel, sent by a POST from the PC's own browser, replaces numbers
  in answers in memory for a phone check against the user's own number. A number typed on a command
  line would land in PowerShell's history and in the session's records. The stand-in never echoes,
  logs or writes the number, and neither `/__fake/state` nor the panel shows stored answers, only
  counts and ids (§10, correction 12).
- **The fake's own tests** (`tool/test_fake_listener_api.py`) cover each new route accepting the valid
  fixtures and refusing the invalid ones, replay by key, the switches, the panel's routes, the
  forwarded-request refusal, the content-type, origin and host checks, "No signal" before scenarios,
  the address rewriting, the re-registration and the number never appearing in the state, the log or
  the panel.

### 4.8 Emulator runs

`tool/run_emulator_tests.py` keeps its Step 4 journeys (the dropped-connection journey now ends at
Saved offline, then the result after the stand-in's "No signal" is switched off) and adds, against the
release APK built with the 5-second sending delay and the 5-second backoff base (A1). Amended after
review: with "No signal" the emulator's network stays up, so only the app's own wake-up (A1) sends
again; the development backoff gives retries after at most 5, 10, 20 and 40 seconds, so the driver
allows 45 seconds after "No signal" goes off. Real network changes are made with the command piece 0
proved (fact 8): `cmd connectivity airplane-mode enable|disable`, or else `svc wifi disable` plus
`svc data disable`. Before the first journey that expects a notification, the driver taps "Allow
notifications" on the Saved screen and the system dialog's "Allow" (T50); if the dialog cannot be
reached, it runs `pm grant zm.lookup.listener.development android.permission.POST_NOTIFICATIONS` and
records that it did.

1. **Chooser and choice** (P6-TESTS-07 part 1, P6-CHOOSER-10): `choose-station`; the sheet with both
   rows; "No signal" on; tap Station B; the Result "via Station B" at once; "No signal" off; within 45
   s, `/__fake/state` holds exactly one choice for Station B.
2. **Remember** (P6-CHOOSER-15 stand-in half): `match-by-hint`; no sheet; the log shows `station_hint`.
3. **Cancel**: `choose-station`; Cancel; Home; no choice.
4. **History**: a match; Result shows "Saved to History"; History lists it; open it; tap Call; the copy
   sheet shows the number (the test image has no dialler; P6-HISTORY-02 emulator half).
5. **My station picker**: Settings → My station → one `GET /stations`; back and reopen → no second GET.
6. **Saved offline with the stand-in's switch** (P6-TESTS-09 part 1, P6-OFFLINE-19; the network looks
   connected but nothing answers): "No signal" on; identify → Saved offline; History shows Pending;
   "No signal" off; within 45 s the log shows a recognize with `is_deferred=true`, the same key and a
   later `sent_at`; History moves it to Earlier; `dumpsys notification` lists one notification for the
   app whose title is "Look Up" and text "Your saved clip has been checked. Tap to see the result.", and
   no "Brand A", "Summer service offer" or "Station A" (P6-OFFLINE-20, A6); opening it — through the
   shade if the image has one, else `am start` with the same launch extra — shows the saved result
   (P6-OFFLINE-21, P6-STRUCTURE-02).
7. **Airplane mode, app closed** (P6-OFFLINE-08, only if WorkManager is approved): network off; identify
   → Saved; Home; `am kill`; network on; the stand-in receives the clip with the app closed.
8. **A clip survives a restart**: "No signal" on; identify; `am kill`; start again; History still shows
   Pending.
9. **Shed and limited, one group at a time**: `busy-deferred-shed` then `match` → the second deferred
   send at least 60 s after the first (P6-OFFLINE-18); `rate-limited-deferred` then `match` → at least
   90 s (P6-OFFLINE-17); during that wait a chooser tap's choice reaches the stand-in at once (the
   clips group is paused, the follow-ups are not; P6-D38).
10. **Update gate, and its end** (P6-COMPATIBILITY-02, A2): minimum version 0.2.0 → identify → "Please
    update the app"; tap a saved chooser's row so a choice is queued and gets 426; minimum back to
    0.0.0; `am kill`, start: the probe at start is answered 204 and the queued choice arrives.
11. **Queued crash report, stand-in switch**: "No signal" on; "Send a test error"; "No signal" off;
    within 45 s, one report with `occurredAt`.
12. **Report this** (if approved): one report at the stand-in.
13. **Taps** (piece 5): two Call taps → one engagement; a tap with "No signal" on → sent once within
    45 s of switching it off.
14. **Answers lost** (P6-OUTBOX-05; added after review; replaces the draft's "pictures off", which
    cannot work on the emulator, fact 17): `match-answer-lost`, then `choice-answer-lost` on a chooser,
    then `engagement-answer-lost` on a Call tap; `/__fake/state` holds exactly one recognition for that
    key, one choice and one engagement.
15. **Window sizes**: `wm size 800x1280` and `1280x800` and back; screenshots for the gate review.
16. **Airplane mode with the app open** (P6-TESTS-08, P6-OFFLINE-01, -02, P6-ERRORREPORTING-05; added
    after review; independent of Q2): network off; identify → Saved offline; History shows Pending;
    "Send a test error" (queued: no answer); network on; within 30 s the stand-in receives the clip with
    `is_deferred=true` and one crash report with `occurredAt`; History shows the result; `dumpsys
    notification` lists the "Look Up" notification. This journey uses the network-back event (piece 3),
    not the stand-in switch.
17. **First open** (ALL-USABILITY-04; added after review): `pm clear` the app; start → "How Look Up
    works" on Home; `am kill`, start → no note.
18. **Two notifications** (P6-OFFLINE-21; added after review): with "No signal" on, two clips saved
    (answers `match` and `match-campaign-station-b`); "No signal" off; two notifications; opening the
    older one through the shade shows Brand A via Station A, the newer one via Station B. If the image
    has no shade (piece 0 checks), this step is recorded as not possible here and shown on the phone in
    piece 3 (b).

Every step's evidence includes the app's no-answer reason when one occurs (fact 21).

### 4.9 API and contracts tests

In the P4 design and contract §2.8: the schemas and fixtures (zod and emitted schema), the envelopes,
`comparisons.json`, the route tests that give P6-MYSTATION-03, P6-COMPATIBILITY-01, -03,
P6-OUTBOX-05 (one recognition, one choice, one engagement however often sent), P6-OUTBOX-07 and
P6-TESTS-07 part 2 and -09 part 2 (`LISTENER_CHOICE`; `is_deferred` true with a corrected capture time),
and the amendments' server tests (A3, A4, A5, A8).

### 4.10 Checks on the user's phone and real devices

Against the real stack through ngrok (Docker on, emulator off), with the phone APK built beforehand
with Docker closed (§5.0 (b)), recorded with the phone's name and Android version: the chooser with
two stations on air (P6-TESTS-07 part 3, P6-CHOOSER-15); airplane mode → Saved → Pending → back online
→ result and notification, and the recognition shown deferred on the server (P6-TESTS-08, -09 part 3,
P6-OFFLINE-21); a saved result's Call opening the dialler in airplane mode (P6-HISTORY-02); "Send a
test error" found in the API log by its id (P6-TESTS-13 part 3); a TalkBack pass over every screen,
writing down each screen's spoken labels and fixes (P6-ACCESSIBILITY-02). Against the stand-in through
ngrok (Docker closed, §5.0 (c)): the pictures switch on mobile data and on Wi-Fi (P6-DATASAVER-05, -06,
live half). The low-end checks (P6-TESTS-05, -10, -11) need hardware the project does not have (Q12).

### 4.11 Gate run order

1. Docker up: contracts, portal and API suites (the API with the real Python workers), `pytest`. Stop
   the Look Up containers.
2. Docker closed: `flutter analyze`; `flutter gen-l10n` with no difference; `flutter test` (unit,
   widget, structure); `flutter test test/goldens`; `tool/test_fake_listener_api.py`;
   `tool/test_run_emulator_tests.py`; `tool/check_apk_sizes.py` after `flutter build apk --release
   --split-per-abi` (P6-PERFORMANCE-01, P6-TESTS-12: exits non-zero when any APK is 15,000,000 bytes or
   more; its own test plants an oversized file); the phone's development APK for the ngrok address
   (amended after review: always here, with Docker closed, never alongside Docker;
   ALL-BUILD-MACHINE-07, -09); `tool/run_emulator_tests.py`.
3. Emulator off, Docker up: the phone checks of §4.10 against the stack. Then Docker closed again for
   the stand-in check through ngrok.

---

## 5. Pieces, in build order

Each piece ends green (its tests, the whole app suite, the stand-in's tests) and with a live
walkthrough; the user's answers decide the parts marked with a question. The commit order is recorded
at the gate (P6-SCOPE-01): the chooser with the server's resolution first (pieces 0–1), then History,
Settings and offline capture (pieces 2–4), then taps and limits with the server's second part (piece
5), then the finishing piece (6).

### 5.0 How a walkthrough is set up

**(a) On the emulator, against the stand-in** (no Docker):
1. You close Docker Desktop (the runner refuses to start while it runs).
2. I start the stand-in (`python apps/mobile/tool/fake_listener_api.py --port 3999`) and the
   `lookup_test` emulator with its window shown and software drawing (`-gpu swiftshader_indirect`, after
   the Step 4 freezes), and install the development build made for the stand-in with a 5-second sending
   delay and a 5-second backoff base (A1).
3. You open the stand-in's control page, **http://127.0.0.1:3999/__fake/panel**, in your browser beside
   the emulator. Its buttons choose the next answer, switch "No signal" on and off, and show what the
   app sent.

**(b) On your phone, against the real stack** (no emulator). Amended after review: the APK is built
first, with Docker closed (ALL-BUILD-MACHINE-07, -09; the P4 design's set-up B says the same).
0. Before the session, with Docker closed and the emulator off, I build the phone APK (development
   flavour, arm64, your fixed ngrok address, a 5-second sending delay and backoff base) and give you
   the file; you install it as in the Step 4 phone check. A piece with new app code means a new APK,
   built the same way before its session.
1. You open Docker Desktop; I start the stack (database, Valkey, storage, the API on 3100, the
   workers, the portal on 5180) with the development seed (Station A and Station B, P4 design §5.15).
2. I start ngrok on your fixed address, pointing at the API.
3. I play the sample ad from the PC's speaker when a step says so; you hold the phone near it.

**(c) On your phone, against the stand-in** (added after review; Docker closed, emulator off; for the
pictures of piece 4):
1. The same APK as (b): it talks to your ngrok address, whatever runs behind it. The stand-in issues
   its own tokens, so the app registers again by itself (one refused token, then a registration).
2. I start the stand-in with `--public-origin https://<your ngrok address>` and ngrok pointing at port
   3999. Its `match-with-images` answer then carries two pictures at that `https` address, which the
   app may load like any real picture (§4.7).
3. You open the control page on the PC, as in (a). Its controls refuse anything that comes through the
   tunnel.

### Piece 0 — Groundwork: languages, dark theme, safe test numbers

**Builds**: every string into `app_en.arb` with the fallback delegate (§3.17); `LookUpTheme.dark()`
and the system theme mode (§3.18); the window-size helper (§3.19); contract §2 parts that need no
server (schemas, fixtures with `+447700900NNN` and `example.com`, envelopes, `timing-rules.json`,
`acknowledgement-rules.json`, with the default rows); `ListenerRoute` and `getJson` (§3.12);
registering again on a version change, carrying the token (A3); the stand-in's per-route queues,
panel, forwarded-request refusal and the other control checks of §4.7; the no-answer reason in the
emulator evidence; the emulator commands of fact 8 proved on `lookup_test` (airplane mode or `svc`,
`dumpsys notification`, whether a shade exists), each result written in the evidence. **Server**:
none. **Items**: P6-LOCALISATION-01 to -03, P6-THEME-01,
P6-ACCESSIBILITY-03, P6-RESPONSIVE-02. **Tests changed on purpose**: `pubspec_test`, `look_up_theme_test`,
`look_up_tokens_test`, `api_client_test`, `listener_install_repository_test`, the copy-sheet number in
`result_screen_test` and the emulator driver.

**Walkthrough (a)**:
1. Open "Look Up (dev)" on the emulator. Home looks exactly as before: "Heard an ad on the radio?" and
   the round "Tap to identify".
2. On the control page press **"Next answer: Match"**. Tap "Tap to identify", wait 8 seconds →
   "Found it", "Brand A", "via Station A · 98.1 FM".
3. Tap **"Call us"**. The test phone has no dialler, so "Couldn't open this" shows the number
   **+447700900001**: a UK number kept for films and TV, which reaches nobody. Tap "Close".
4. I switch the emulator to dark mode (`adb shell cmd uimode night yes`; or you open the emulator's
   Settings → Display → Dark theme). Look Up turns dark at once: dark background, light text, a lighter
   copper button. Identify again: the Result is dark too. I switch back.
5. What you have seen: the same words (they now come from the language file), the phone's theme
   followed, and no realistic phone number left in the answers.

### Piece 1 — Which station? (with the outbox's first item)

**Builds**: the reader's candidates and ids (§3.4); `ChooseStationState` and the sheet (§2.6); a
result from a candidate with the haptic tick; "Remember" and `MyStationStore`; the hint at capture;
the outbox store, its owned lock files, sender, timing rules and acknowledgement policy with the
`STATION_CHOICE` kind (§3.8, §3.9); runs on start, resume, a new item and **the sender's own wake-up
after a wait** (A1, added after review); the default-card note's new sentence (A7) and the chooser's
all-default-cards sentence (P6-D42); the `settings` feature folder (its domain and data only).
**Server**: none for (a); for (b), the P4 design's pieces 2 and 3 (resolution, then the choice route
and the station list; amended after review: the P4 design runs this phone check in its piece 3).
**Items**: P6-STATE-01 (one of two), -02, -03; P6-CHOOSER-01 to -15; P6-MYSTATION-05; P6-OUTBOX-01 to
-04; P6-OFFLINE-10, -12; P6-ACCESSIBILITY-07; P6-TESTS-07 part 1. **Tests changed**:
`recognition_state_test`, `recognition_outcome_test` and the T19 flow tests,
`recognize_request_builder_test` (hint), `error_screen_test` (the several-stations wording goes),
`result_screen_test` (the default-card note), `app_route_test` (each state has its one route: the
chooser's is new here; moved from piece 2 after review), `feature_folders_test`.

**Walkthrough (a)**:
1. On the control page press **"Next answer: Which station?"**. Tap "Tap to identify".
2. After 8 seconds a sheet slides up over a dimmed screen: **"Which station are you listening to?"**,
   "This ad is on more than one station right now.", two rows — "Station A, 98.1 FM · Lusaka" and
   "Station B, 104.3 FM · Kitwe" — and **"Remember my station — skip this next time"**, already ticked.
3. On the control page press **"No signal: on"**. Then tap **Station B**. The Result appears at once:
   "via Station B · 104.3 FM", with Station B's own buttons. The page shows "Choices: 0".
4. Press **"No signal: off"**. Within about 30 seconds the page shows **"Choices: 1 — Station B"**:
   the app tries again by itself, sooner after the first failure and less often after each one (at
   most 5, 10, then 20 seconds apart in this build), so switch "No signal" off soon after the tap.
5. Press **"Next answer: Match by my station"**, tap Back, then "Tap to identify": **no sheet**, Station
   B's card straight away; the page's log shows the request carried Station B as the hint.
6. Press **"Next answer: Which station?"**, identify, **untick "Remember"**, tap Station A → "via Station
   A". Identify once more with "Match by my station": still Station B (an unticked choice changes
   nothing).
7. Press **"Next answer: Which station?"**, identify, tap **"Cancel"** → Home; the page still shows
   one choice.
8. Press **"Next answer: Which station, off air"**: the sheet says **"This ad is played on more than one
   station."**; tap a row → the Result with **"These are Brand A's usual contact details."** (the
   sentence pending Q15).

**Walkthrough (b)** (with the P4 design's piece 3, part 2; set-up (b)): Station A and Station B both
have the sample ad live, as the P4 design's piece 2 leaves them.
1. Open Look Up on your phone. I play the ad; tap "Tap to identify" → the sheet with Station A and
   Station B and their real frequencies and cities.
2. Turn on **airplane mode**, then tap **Station B** → Station B's card at once.
3. Turn airplane mode **off** and wait up to a minute with Look Up open (in this piece the app retries
   on its own timer, a little later after each failure; sending the moment the network returns comes
   in piece 3, and the P4 design's walkthrough says the same). On the PC I show the recognition:
   resolution **LISTENER_CHOICE**, Station B chosen.
4. I play the ad again; tap Identify → **no sheet**, Station B's card; the recognition shows resolution
   **HINT**.

### Piece 2 — The tab bar, History and Settings

**Builds**: the shell, the tab bar and rail, the narrowed redirect, `PendingDestination` (§3.7); the
Home chip and the first-open note "How Look Up works" (§2.3, Q20); the History store and screen with
results, the empty state and `/r/<id>` (§2.9, §2.10, §3.14); "Saved to History" (§2.7); Settings with
the Listening and App sections, the picker, Privacy and About (§2.11–§2.13); the station list
repository (§3.13); "Clear history" if approved; the scratch Bemba build extended to open History.
**Server**: none for (a); for (b), the P4 design's piece 3 (the station-list route). **Items**:
P6-STRUCTURE-01, -02 (route); P6-NAVIGATION-01 to -06; P6-MYSTATION-01 to -04, -06; P6-HISTORY-01 to
-03, -07 to -14; P6-SETTINGS-01 to -07; P6-ACCESSIBILITY-06; ALL-USABILITY-04. **Tests changed**:
`home_screen_test`, `result_screen_test`, `app_router_test`, `feature_folders_test`.

**Walkthrough (a)** (a fresh install):
1. Open Look Up: a **tab bar** at the bottom — Identify, History, Settings — at the top right **"My
   station: Not set"**, and under the header the note **"How Look Up works"**. Tap **"Got it"**: it
   goes. I close the app and open it again: no note (it shows on the first open only).
2. Tap **History**: "History", a clock in a circle, "No results yet".
3. Tap **Identify**; press "Next answer: Match"; identify → the Result now ends with **"✓ Saved to
   History"**. Tap Back.
4. Tap **History**: "Earlier" → "Brand A — Summer service offer", "via Station A · Today, [time]", and
   under it "Saved results keep working without data — call, chat or get directions any time."
5. Press **"No signal: on"**. Tap the row → "Saved result" with the same buttons; tap "Call us" → the
   copy sheet with the number (no data needed). Back → History.
6. Tap the **chip** on Home → Settings: "My station — Not set — used when an ad is on more than one
   station". Tap it → (with "No signal: off") the picker lists the stand-in's stations. Tap **Station
   A** → Settings now says "Station A · 98.1 FM — used when…", and Home's chip "My station: Station A".
7. Open the picker again: the page's log shows **no second station-list request** (kept for 24 hours).
8. Open **Privacy** and **About** and read them (Q9).

**Walkthrough (b)**: after an identify on the phone, the result is in History; with **airplane mode
on**, open it and tap **Call**: your phone's dialler opens with the number, which starts `+447700900`.
**Do not press call**: it is a UK number, so from a Zambian SIM it would be an international call
attempt that may be charged; the dialler opening with the number is the check. Go back. Settings → My
station lists Station A and Station B as the real API returned them.

### Piece 3 — Offline capture, notifications and the update gate

**Builds**: `DEFERRED_CLIP` items and Saved offline with its three reasons (§2.8); the live flow's new
rows (§3.5); the full sender (waits, pauses, 401, 426, expiry, the sixth clip) (§3.9); History's
waiting rows and deferred outcomes (§3.11); the `device_services` plugin, notifications with their generic words (A6) and "Allow
notifications" (§3.15); network-back runs and "no attempt while there is no network" (§3.9); the 426
pause with its probes (A2); the background job if approved (§3.10); queued crash reports (§3.20); the
Permission bullet (§2.4); "Please update the app" (§2.15). **Server**: none for (a); for (b), the P4
design's piece 4. **Items**: P6-STATE-01 (second), -04; P6-OUTBOX-07;
P6-OFFLINE-01 to -29; P6-HISTORY-04 to -06; P6-PERMISSION-01; P6-LISTENING-02; P6-ERRORREPORTING-05;
P6-COMPATIBILITY-01 to -03; P6-STRUCTURE-02 (notification); P6-TESTS-08, -09, -13 part 3. **Tests
changed**: the T24, T27, T31 and T37 flow tests, `recognition_outcome_test`, `error_screen_test`,
`permission_screen_test`, `android_project_test`, `client_error_reporter_test`, the emulator's
dropped-connection journey; the security-baseline rows.
**Carried over from the review of piece 1 (13 October 2026):** `OwnedLockFile` creates its lock
exclusively and writes its owner line just after, so for a moment the file is empty; an empty or
unreadable lock is judged dead when it is still the same at the next look. With one engine (pieces 1
and 2) only a crashed process can leave such a file, so that is safe. Once the background engine
exists, an engine stalled between the two steps could lose its lock to the other engine. This piece
decides an empty or unreadable lock with `device_services`: while another engine of this process is
attached, it is waited for and never taken over, and a test with `FakeDeviceServices` proves it.

**Walkthrough (a)**:
1. Press **"No signal: on"**. Tap "Tap to identify"; after 8 seconds: **"Saved — we'll identify it when
   you're back online"**, "No signal right now. Your clip stays on this phone for up to 24 hours and is
   deleted as soon as it's sent.", and a panel "Allow notifications to hear when the result is ready."
2. Tap **"Allow notifications"** → the system asks → **Allow**. The panel now reads "You'll get a
   notification with the result, including the station's buttons."
3. Tap **"See it in History"** → "Waiting for signal": **"Clip from today, [time]"**, "Will identify when
   you're back online", **Pending**.
4. Press **"No signal: off"**. Within about 30 seconds the page's log shows the clip sent again with
   **is_deferred = true**, the same key, and a later send time (the app retries by itself; the
   emulator's network never dropped). A notification appears: pull down the emulator's notifications
   (if this test image has a shade; otherwise I open it with the same tap the notification carries) →
   it says only **"Look Up"** and **"Your saved clip has been checked. Tap to see the result."** — no
   brand, ad or station, as on a locked phone → tap it → "Saved result" with the buttons. History now
   lists it under Earlier; the Pending row is gone.
5. I turn the emulator's network **off** (airplane mode); identify → Saved; "See it in History" →
   Pending. I turn it **on** → within about 30 seconds the clip is sent and the result arrives with the
   notification, this time because Android reported the network back. (If WorkManager is approved, I
   then repeat it with the app's process ended: the notification arrives with Look Up closed.)
6. Press **"Next answer: Busy (shed)"** then **"Match"**, with "No signal" on, identify, then off: the
   first send is refused and the next comes **at least 60 seconds later**, then the result. Meanwhile
   a choice made on a chooser goes through at once: only the clips wait.
7. Set the **minimum app version to 0.2.0** on the page; identify → **"Please update the app"**, "This
   version of Look Up is too old to identify ads." Open a saved chooser from History and tap a row:
   its choice waits, Pending. Set the version back; close and reopen the app → the page shows the
   choice arrive (the app tried one item at start, it was accepted, and sending resumed; A2).
8. "No signal: on"; tap **"Send a test error"**; "No signal: off" → within about 30 seconds the page
   shows one report with the time it happened.

**Walkthrough (b)** (with the P4 design's piece 4, part 2):
1. Turn on **airplane mode**. I play the ad; tap Identify → **Saved**. History shows **Pending**.
2. Turn airplane mode **off**. Within about 30 seconds a notification arrives. Lock the phone first if
   you like: it says only **"Look Up"** / "Your saved clip has been checked. Tap to see the result." Tap
   it → the station's buttons.
3. (Added after review) Save two clips in airplane mode, one after the other, then turn it off: two
   notifications; the older opens the first result, the newer the second (P6-OFFLINE-21).
4. On the PC I show the recognition: **is_deferred = true**, and its capture time corrected to when you
   recorded.
5. Tap "Send a test error"; I find its id in the API's log, with the full error.
6. (Carried from piece 2's walkthrough (b), skipped on 13 October 2026) Turn on **airplane mode**, open
   History, open a saved result and tap **Call** → your phone's dialler opens with the number, which
   starts `+447700900`. **Do not press call.** Turn airplane mode off.
7. (Carried from piece 1's walkthrough (b), skipped on 13 October 2026) Clear **My station**. I play
   the ad; tap Identify → the sheet. Turn on **airplane mode**, tap **Station B** → its card at once.
   Turn airplane mode **off** and leave Look Up open, or lock the phone: within about 30 seconds the
   recognition shows resolution **LISTENER_CHOICE**, Station B chosen (P6-TESTS-07 part 3).

### Piece 4 — Data saver, slow upload and "Report this"

**Builds**: the Data section, the meter and the switch (§2.11, §3.16); the metered check; the slow
Identifying state (§2.5); the report sheet and `RECOGNITION_REPORT` items (§2.14) if approved; the
stand-in's picture addresses and `--public-origin` (§4.7). **Server**: the report route for (b), if
approved (the P4 design's piece 4). **Items**: P6-DATASAVER-02 to -06; P6-LISTENING-01; P6-RESULT-04,
-05.

**Walkthrough (a)**:
1. Settings → **Data**: "Each identify uses — about 25 KB", "Used this month — 0 KB". Identify three
   times; it now shows about **90 KB**.
2. Turn **"Load ad pictures on mobile data"** off (tap anywhere on the row) and on again: the switch
   follows the whole row. The pictures themselves are shown on your phone in walkthrough (c), because
   none can load on the emulator (fact 17).
3. Press **"Next answer: Slow upload"**, identify: after 5 seconds "Still working — the connection is
   slow.", then either "Clip [n]% sent" growing or "Clip sent — waiting for the answer" (the clip is
   small enough that the network may take it all at once; the widget test proves the percentage),
   then the result.
4. (If approved) On a Result tap **"Report this"** → "Report this ad" → **"It looks like a scam"** →
   **"Send report"** → "Thanks — we'll check this ad."; the footer says "Reported"; the page shows one
   report.

**Walkthrough (c)** (added after review; set-up (c), your phone and the stand-in through ngrok):
1. With your phone on **mobile data**, open Settings → Data and turn **"Load ad pictures on mobile
   data"** off. I press "Next answer: Match with pictures"; identify (the stand-in answers, so no ad
   needs to play) → no banner, the letter "A" instead of the logo; the control page shows **no picture
   request**. The buttons work.
2. Turn the switch **on**; identify again → the banner and the logo load; the page shows two picture
   requests.
3. Turn the switch **off** again and connect the phone to **Wi-Fi**; identify → the pictures load,
   because the switch is about mobile data only.

### Piece 5 — Button taps counted (with the P4 gate's second part)

**Builds**: `ENGAGEMENT` items queued from Result and saved-result buttons (§3.8, T54); the stand-in's
engagements route. **Server**: the engagements route and caps (P4-RESOLUTION-17). **Items**:
P6-OUTBOX-05, -06.

**Walkthrough (a)**: on a Result tap **"Call us"** twice (the copy sheet each time) → the page shows
**one** tap for that button. "No signal: on", tap **"Find our shop"**, "No signal: off" → within about
30 seconds one more tap arrives. Press **"Next answer: Match, answer lost"**: the app saves the clip,
sends it again and the page still shows one recognition; the same with "Choice, answer lost" and
"Tap, answer lost" (one choice, one tap).

**Walkthrough (b)** (the P4 design's piece 5; amended after review to match it): in the portal, a **tap
limit of 2** on Station A's "Summer service offer". Identify; tap **Call** → the dialler opens with a
number starting `+447700900` — **do not press call** (an international call attempt from a Zambian
SIM); go back. Tap **WhatsApp** → WhatsApp says the number is not on WhatsApp; go back. I show "Call —
counted, 1 of 2" and "WhatsApp — counted, 2 of 2". Identify again → the advertiser's usual buttons
with the default-card note (the limit is reached).

### Piece 6 — Tablets, golden images, size and accessibility; the P6 gate

**Builds**: medium and expanded layouts and the rail (§3.19); the golden matrix (§4.6); split APKs, the
size check and compressed libraries if approved (§3.21); the gate runs (§4.11). **Items**:
P6-RESULT-01, -02; P6-RESPONSIVE-03 to -07; P6-PERFORMANCE-01, -02; P6-TESTS-01 to -04, -12;
P6-ACCESSIBILITY-02, -04; P6-CHOOSER-11, -12 (goldens); the Step 4-evidenced items P6-RESULT-03,
P6-LOCALISATION-04, P6-TESTS-06.

**Walkthrough (a)**: I set the emulator to **800 × 1280**: identify → the result appears **beside** Home
in a side panel, with a rail of Identify, History and Settings at the left. **1280 × 800**: Home and
History side by side; identify → the result replaces History in the right pane. Turn the phone-sized
screen sideways: the screens reflow without cutting anything. I publish the golden images as a contact
sheet for your review, in light and dark and at large text.

**Walkthrough (b)**: on your phone, turn on **TalkBack** (Settings → Accessibility); swipe through Home,
the chooser, Saved offline, History, Settings and a Result; I write down what each item says and fix
anything unclear.

---

## 6. Item map

"Here?" says whether the item can be built and verified on this machine: **Yes**; **Partly** (what
cannot, and why); **No** (why). 156 ids.

| Item | Covered by | Piece | Here? |
|---|---|---|---|
| P6-SCOPE-01 | §5 order, P6-D1; the commit history recorded at the gate | 0–6 | Yes |
| P6-STRUCTURE-01 | §3.1, §4.5 `feature_folders_test` | 1–2 | Yes |
| P6-STRUCTURE-02 | §2.10, §3.7, §3.15; `app_router_test`, emulator steps 6 and 18 | 2, 3 | Yes (widget test and emulator in place of `integration_test`, S4-D33) once Q18 narrows "deep link" to the internal route; as written it stays open |
| P6-STATE-01 | §3.4; `recognition_state_test`, `app_route_test` (piece 1) | 1, 3 | Yes |
| P6-STATE-02 | §3.4, §4.4; parser test with the shared fixtures | 1 | Yes |
| P6-STATE-03 | §2.17 T19′, §3.5 | 1 | Yes |
| P6-STATE-04 | §2.17 T27′, §3.8; flow test with a throwing fake network | 3 | Yes |
| P6-NAVIGATION-01 | §2.2, §3.7 | 2 | Yes |
| P6-NAVIGATION-02 | §2.2; widget test, goldens | 2, 6 | Yes |
| P6-NAVIGATION-03 | §2.3 | 2 | Yes — the wording with no station is Q8 |
| P6-NAVIGATION-04 | §2.3 | 2 | Yes |
| P6-NAVIGATION-05 | §2.2, §2.9 | 2 | Yes |
| P6-NAVIGATION-06 | §2.2, §2.11 | 2 | Yes |
| P6-CHOOSER-01 | §2.6, T44 | 1 | Yes |
| P6-CHOOSER-02 | §2.6 | 1 | Yes |
| P6-CHOOSER-03 | §2.6; contract §2.1 (`city`) | 1 | Yes |
| P6-CHOOSER-04 | §2.6 (64 dp rows) | 1 | Yes |
| P6-CHOOSER-05 | §2.6 | 1 | Yes |
| P6-CHOOSER-06 | §2.6 | 1 | Yes |
| P6-CHOOSER-07 | §2.17 T44, T1′; §3.13 | 1 | Yes (the server's HINT resolution is P4-RESOLUTION-06) |
| P6-CHOOSER-08 | §2.17 T44 | 1 | Yes |
| P6-CHOOSER-09 | §2.6, T44; widget test with a failing fake network | 1 | Yes |
| P6-CHOOSER-10 | §3.8, §3.9 (the sender's own wake-up, A1); `outbox_sender_test`; emulator step 1 | 1 | Yes |
| P6-CHOOSER-11 | §2.6; semantics test, golden | 1, 6 | Yes |
| P6-CHOOSER-12 | §2.6; golden | 1, 6 | Yes |
| P6-CHOOSER-13 | §2.6, P6-D42; widget test with campaign and all-default candidates | 1 | Yes — the all-default-cards sentence is Q15 |
| P6-CHOOSER-14 | §2.6, T46 | 1 | Yes |
| P6-CHOOSER-15 | T1′ hint; emulator step 2; API e2e (P4-RESOLUTION-06); §4.10 | 1 | Partly — the two-station run with a real ad needs the user's phone |
| P6-MYSTATION-01 | §2.11, §2.12 | 2 | Yes |
| P6-MYSTATION-02 | §2.12, §3.13; emulator step 5 | 2 | Yes |
| P6-MYSTATION-03 | contract §1.4, built with the P4 gate's first part; API e2e with four stations | 2 (server: P4 design) | Yes (Docker) |
| P6-MYSTATION-04 | §3.13; FakeClock test | 2 | Yes |
| P6-MYSTATION-05 | §3.13, T1′; builder test | 1 | Yes |
| P6-MYSTATION-06 | §2.1, §4.3 `station_lists_test` | 1–2 | Yes |
| P6-OUTBOX-01 | §3.8, P6-D3; survive-reopen test | 1 | Yes once Q1 rewords it; as written (Drift) it stays open |
| P6-OUTBOX-02 | §3.8 (five kinds; eviction order, P6-D44) | 1, 3, 4, 5 | Yes |
| P6-OUTBOX-03 | §3.8, §3.9 (contract R12; a crash report's `report_id`, P6-D43); sender and reporter tests | 1, 3 | Yes |
| P6-OUTBOX-04 | §3.9 point 9 (A1); FakeClock sender test | 1 | Yes |
| P6-OUTBOX-05 | §3.9; emulator step 14 (`match-`, `choice-` and `engagement-answer-lost`, one of each in `/__fake/state`); API e2e (P4 design) | 5 | Yes (needs the engagements route) |
| P6-OUTBOX-06 | §3.8, T54 | 5 | Yes (with P4-RESOLUTION-17) |
| P6-OUTBOX-07 | §3.9 point 10; FakeClock test; API e2e | 3 | Yes |
| P6-OFFLINE-01 | §2.8, T27′, §3.8; emulator step 16 (airplane mode, app open) | 3 | Yes |
| P6-OFFLINE-02 | §3.9; emulator steps 16 and 6 | 3 | Yes |
| P6-OFFLINE-03 | §3.8; store test | 3 | Yes |
| P6-OFFLINE-04 | §3.8, P6-D6 (Q5) | 3 | Yes |
| P6-OFFLINE-05 | §3.8 (and a clock moved back, P6-D37); FakeClock test | 3 | Yes |
| P6-OFFLINE-06 | §3.9 point 8; `outbox_acknowledgement_files_test` | 3 | Yes |
| P6-OFFLINE-07 | §3.9 point 1; scheduler test; emulator steps 16 and 10 | 1, 3 | Yes |
| P6-OFFLINE-08 | §3.10 (Q2); emulator step 7 | 3 | Yes if `workmanager` is approved; otherwise it stays open |
| P6-OFFLINE-09 | §3.10; unit test with the platform set to iOS; code review | 3 | Partly — no iOS build on this machine (gap 32) |
| P6-OFFLINE-10 | §3.9 | 1, 3 | Yes |
| P6-OFFLINE-11 | §3.9 point 7 | 3 | Yes |
| P6-OFFLINE-12 | §3.9 point 5 | 1 | Yes |
| P6-OFFLINE-13 | §3.9 point 8; `acknowledgement-rules.json`; the policy test and `outbox_acknowledgement_files_test` (file and item on disk) | 1, 3 | Yes |
| P6-OFFLINE-14 | as -13 | 3 | Yes |
| P6-OFFLINE-15 | as -13; §3.11 | 3 | Yes |
| P6-OFFLINE-16 | as -13; the wake-up after `Retry-After` (A1) | 3 | Yes |
| P6-OFFLINE-17 | as -13; emulator step 9 | 3 | Yes |
| P6-OFFLINE-18 | as -13; emulator step 9 | 3 | Yes |
| P6-OFFLINE-19 | as -13; emulator step 6 | 3 | Yes |
| P6-OFFLINE-20 | §2.16 (generic words, A6), §3.11, §3.15 (Q3, Q4); `deferred_result_handler_test`; `dumpsys notification` after granting the permission | 3 | Yes |
| P6-OFFLINE-21 | §2.16, §3.15 (a request code per notification), §2.10; emulator steps 6 and 18; §4.10 | 3 | Partly — the shade on `aosp_atd` is unverified; the same intent through `am start`, and the phone |
| P6-OFFLINE-22 | §2.8 | 3 | Yes |
| P6-OFFLINE-23 | §2.8 | 3 | Yes |
| P6-OFFLINE-24 | §2.8; golden | 3, 6 | Yes |
| P6-OFFLINE-25 | §2.8 | 3 | Yes |
| P6-OFFLINE-26 | §2.8 | 3 | Yes |
| P6-OFFLINE-27 | §2.8 | 3 | Yes |
| P6-OFFLINE-28 | §2.8 | 3 | Yes |
| P6-OFFLINE-29 | §2.8, T49 | 3 | Yes |
| P6-HISTORY-01 | §3.14 | 2 | Yes |
| P6-HISTORY-02 | §2.10; emulator step 4; §4.10 | 2 | Partly — the dialler opens only on the phone (the test image has none) |
| P6-HISTORY-03 | §2.9 | 2 | Yes |
| P6-HISTORY-04 | §2.9 | 3 | Yes |
| P6-HISTORY-05 | §2.9 | 3 | Yes |
| P6-HISTORY-06 | §2.9 | 3 | Yes |
| P6-HISTORY-07 | §2.9 | 2 | Yes |
| P6-HISTORY-08 | §2.9 | 2 | Yes |
| P6-HISTORY-09 | §2.9; `day_label_test` (English names for `bem` and `ny`, P6-D47) | 2 | Yes |
| P6-HISTORY-10 | §2.9 | 2 | Yes |
| P6-HISTORY-11 | §2.9, §2.10 | 2 | Yes |
| P6-HISTORY-12 | §2.9 | 2 | Yes |
| P6-HISTORY-13 | §2.9 | 2 | Partly — no wireframe; the design is reviewed as a screenshot (gap 4) |
| P6-HISTORY-14 | §2.7 | 2 | Yes |
| P6-RESULT-01 | §2.7; golden at 360 × 800 | 6 | Yes |
| P6-RESULT-02 | §3.19; golden at 800 × 1280 | 6 | Yes |
| P6-RESULT-03 | Step 4's S4-D18 tests, re-run with chosen and saved results | gate | Yes |
| P6-RESULT-04 | §2.7, §2.14 (Q6) | 4 | Yes if approved; otherwise it stays open (gap 5) |
| P6-RESULT-05 | §2.7 | 4 | Yes if approved |
| P6-DATASAVER-01 | §3.16 — deferred with contract §5.15 | — | No — no station can upload a picture yet; stays open |
| P6-DATASAVER-02 | §2.11 | 4 | Yes |
| P6-DATASAVER-03 | §3.16 (Q11) | 4 | Yes |
| P6-DATASAVER-04 | §2.11 | 4 | Yes |
| P6-DATASAVER-05 | §3.16; widget test with a fake metered network and a recording image client; the phone check through the tunnel to the stand-in (§5.0 (c), piece 4 walkthrough (c)) | 4 | Yes (pictures only from the stand-in; none can load on the emulator, fact 17) |
| P6-DATASAVER-06 | §3.16; widget test with a fake Wi-Fi network; piece 4 walkthrough (c) | 4 | Yes |
| P6-SETTINGS-01 | §2.11 | 2 | Yes |
| P6-SETTINGS-02 | §2.11 | 2 | Yes |
| P6-SETTINGS-03 | §2.11 | 2 | Yes |
| P6-SETTINGS-04 | §2.11 | 2 | Yes |
| P6-SETTINGS-05 | §2.11 | 2 | Yes |
| P6-SETTINGS-06 | §2.13 (Q9) | 2 | Yes with the interim page; the legal wording is O15, Phase 8 |
| P6-SETTINGS-07 | §2.13 (Q9) | 2 | Yes |
| P6-PERMISSION-01 | §2.4 (the promise kept when the clock moves back, P6-D37) | 3 | Yes |
| P6-LISTENING-01 | §2.5, T42, T43 (P6-D18) | 4 | Yes |
| P6-LISTENING-02 | T21′, T31′; flow test across Busy and the outbox | 3 | Yes |
| P6-ACCESSIBILITY-01 | §4.1, §4.3 (every new screen) | 1–6 | Yes |
| P6-ACCESSIBILITY-02 | §4.10, piece 6 walkthrough (b) | 6 | Partly — a manual TalkBack pass on the user's phone |
| P6-ACCESSIBILITY-03 | §3.18; token test in both palettes; `textContrastGuideline` | 0, each | Yes |
| P6-ACCESSIBILITY-04 | §2.2, §2.9; greyscale review (§4.6) | 2, 6 | Yes (review at the gate) |
| P6-ACCESSIBILITY-05 | §4.1, §4.6 | each, 6 | Yes |
| P6-ACCESSIBILITY-06 | §2.2 | 2 | Yes |
| P6-ACCESSIBILITY-07 | §2.6 | 1 | Yes |
| P6-THEME-01 | §3.18; goldens in both themes | 0, 6 | Yes |
| P6-LOCALISATION-01 | §3.17; scan; `flutter gen-l10n` | 0 | Yes |
| P6-LOCALISATION-02 | §3.17; `l10n_test` | 0 | Yes |
| P6-LOCALISATION-03 | §3.17; scratch Bemba build, extended in piece 2 to open History | 0, 2 | Yes |
| P6-LOCALISATION-04 | Step 4's `phone_number_display_test`, re-run | gate | Yes |
| P6-RESPONSIVE-01 | §4.1, §4.6 | each, 6 | Yes |
| P6-RESPONSIVE-02 | §3.19; scan | 0 | Yes |
| P6-RESPONSIVE-03 | §3.19, §4.6 | 6 | Yes |
| P6-RESPONSIVE-04 | §3.19; `app_shell_test` at 700 dp | 6 | Yes |
| P6-RESPONSIVE-05 | §3.19; `app_shell_test` at 1280 × 800 | 6 | Yes |
| P6-RESPONSIVE-06 | §4.6 | 6 | Yes |
| P6-RESPONSIVE-07 | §3.19, §4.5 | 6 | Yes |
| P6-PERFORMANCE-01 | §3.21, §4.11 | 6 | Yes |
| P6-PERFORMANCE-02 | §3.21 (Q10), `check_apk_sizes.py` | 6 | Yes once Q10 is answered; fails today (fact 13) |
| P6-ERRORREPORTING-01 | retired → S4-ERRORREPORTING-01 | — | — |
| P6-ERRORREPORTING-02 | retired → S4-ERRORREPORTING-02 | — | — |
| P6-ERRORREPORTING-03 | retired → S4-ERRORREPORTING-03 | — | — |
| P6-ERRORREPORTING-04 | retired → S4-ERRORREPORTING-04 | — | — |
| P6-ERRORREPORTING-05 | §3.20; reporter test; emulator steps 16 (airplane mode) and 11 | 3 | Yes |
| P6-ERRORREPORTING-06 | retired → S4-ERRORREPORTING-05 | — | — |
| P6-ERRORREPORTING-07 | retired → S4-ERRORREPORTING-06 | — | — |
| P6-ERRORREPORTING-08 | retired → S4-ERRORREPORTING-07 | — | — |
| P6-ERRORREPORTING-09 | retired → S4-ERRORREPORTING-08 (its phone part runs with P6-TESTS-13) | — | — |
| P6-ERRORREPORTING-10 | retired → S2-CLIENT-ERRORS-01 | — | — |
| P6-ERRORREPORTING-11 | retired → S2-CLIENT-ERRORS-02 | — | — |
| P6-ERRORREPORTING-12 | retired → S2-CLIENT-ERRORS-03 | — | — |
| P6-ERRORREPORTING-13 | retired → S2-CLIENT-ERRORS-04 | — | — |
| P6-ERRORREPORTING-14 | retired → S2-CLIENT-ERRORS-05 and -06 | — | — |
| P6-COMPATIBILITY-01 | contract §1.0, §2.2, §2.4 (server, P4 gate's first part); the shared envelope fixture | 3 | Yes (Docker) |
| P6-COMPATIBILITY-02 | §2.15; widget test with a fake 426; the pause's end (A2): sender test and emulator step 10 | 3 | Yes |
| P6-COMPATIBILITY-03 | P6-D19: the 426 gate plus the reader's `schema_version` rule, no card field (contract §5.2); API e2e with the minimum above the build | 3 | Yes once Q19 drops "and `min_app_version`" from its wording; as written it stays open |
| P6-TESTS-01 | §4.6 | 6 | Yes |
| P6-TESTS-02 | §4.6 | 6 | Yes |
| P6-TESTS-03 | §4.6 | 6 | Yes |
| P6-TESTS-04 | §4.6 | 6 | Yes |
| P6-TESTS-05 | §4.10 (Q12) | — | No — needs a phone with 2 GB or less; proposed for the pilot |
| P6-TESTS-06 | Step 4's address-builder tests, re-run | gate | Yes |
| P6-TESTS-07 | emulator step 1; API e2e; §4.10 | 1 | Partly — part 3 is the record on the user's phone |
| P6-TESTS-08 | emulator step 16 (airplane mode with the app open, whatever Q2's answer), and step 7 if WorkManager is approved | 3 | Yes (the airplane-mode or `svc` command is proved on the image in piece 0) |
| P6-TESTS-09 | emulator step 6; API e2e; §4.10 | 3 | Partly — the phone record |
| P6-TESTS-10 | Q12 | — | No — no Android 8/9 low-end phone; throttled 2G needs one |
| P6-TESTS-11 | Q12 | — | No — a field test with a real radio and phone |
| P6-TESTS-12 | §4.11 `check_apk_sizes.py` | 6 | Yes |
| P6-TESTS-13 | parts 1–2 done in Step 4; part 3 in piece 3 walkthrough (b) | 3 | Partly — part 3 on the user's phone |

**Count**: 156 ids: 143 items mapped (SCOPE 1, STRUCTURE 2, STATE 4, NAVIGATION 6, CHOOSER 15,
MYSTATION 6, OUTBOX 7, OFFLINE 29, HISTORY 14, RESULT 5, DATASAVER 6, SETTINGS 7, PERMISSION 1,
LISTENING 2, ACCESSIBILITY 7, THEME 1, LOCALISATION 4, RESPONSIVE 7, PERFORMANCE 2, ERRORREPORTING 1,
COMPATIBILITY 3, TESTS 13) and 13 retired ids with nothing to build.

**Expected to stay open at the P6 gate, with the reason:**
- **P6-DATASAVER-01** — no picture can be uploaded yet and the answer carries one banner address;
  resizing and variants come with the portal's picture screens (contract §5.15).
- **P6-TESTS-05, -10, -11** — no phone with 2 GB or less, no Android 8 or 9 phone, and the field test
  needs a real radio: proposed for the pilot, Phase 8 (Q12).
- **P6-OUTBOX-01** — only if the user keeps "Drift" in its wording (Q1).
- **P6-STRUCTURE-02** — only if the user keeps "deep link" in its wording (Q18).
- **P6-COMPATIBILITY-03** — only if the user keeps the per-card `min_app_version` in its wording (Q19).
- **P6-OFFLINE-08** — only if the background package is declined (Q2).
- **P6-RESULT-04, -05** — only if "Report this" is declined (Q6); they then need another answer.
- **P6-PERFORMANCE-02** — only if neither compression nor a download-size budget is chosen (Q10).
- The Partly items (P6-CHOOSER-15, P6-HISTORY-02, P6-OFFLINE-21, P6-TESTS-07, -09, -13,
  P6-ACCESSIBILITY-02) close when their phone walkthroughs are recorded; they stay open only if those do
  not happen.

---

## 7. Decisions

Decisions P6-D1 to P6-D34 are the first draft's; those the review changed say "amended after review".
P6-D35 to P6-D52 were added after review.

| # | Decision | Why |
|---|---|---|
| P6-D1 | **Build order**: piece 0 (languages, dark theme, safe numbers, groundwork), 1 (the chooser, with the outbox's first item kind), 2 (tabs, History, Settings), 3 (offline capture, notifications, update gate), 4 (data saver, slow upload, "Report this"), 5 (taps, with the P4 gate's second part), 6 (tablets, goldens, size, accessibility, gate). | P6-SCOPE-01 and P4-RESOLUTION-16/-17 fix the order chooser → offline/History/Settings → engagements. The choice must go through the outbox (P6-CHOOSER-10), so the outbox's core arrives with its first item kind and is built once. Strings move to the language file first so no new string is written twice. |
| P6-D2 | **The interface contract (§10) is adopted as written, with the corrections noted before it** and, amended after review, **the contract amendments A1–A8 after it, which win where they differ.** | One decision per wire question, made once for both sides (gaps 7, 8, 13, 21, 28, 30, 31, 37, 43). |
| P6-D3 | **Outbox and History are app-private files with a JSON index**, written under a lock file and renamed into place; no database package. | At most 5 clips and a few hundred small records; Drift costs about 22 MB plus SQLite downloads and code generation (S4-D3); sqflite still adds a native dependency (gap 18; Q1). |
| P6-D4 | **The outbox lives in `core/` with one sender per kind supplied by the features**; one run per engine, `sending.lock` across engines, a hand-off port to the foreground engine. | Clips, choices, taps, reports and crash reports share one queue without `core/` importing features; POSIX file locks do not separate two engines in one process (fact 9). |
| P6-D5 | **A run starts on start, resume, network back, a new item, the background job and (amended after review) the sender's own wake-up after a wait (P6-D35); it waits once, 0–120 s (0–10 s after the queue had emptied); wake-ups after a wait draw none; no send during a live identify.** | Avoids a thundering herd when a tower or the power returns without delaying every item (gap 17), and never competes with the listener's own identify. |
| P6-D6 | **A sixth clip deletes the oldest waiting clip**, and the Saved screen says so. | The app only learns there is no signal after recording; the clip the listener cares about is the new one, and the oldest is closest to its 24 hours (gap 17; Q5). |
| P6-D7 | **Expiry runs at start, resume, before each send and in the background job; an expired or refused clip leaves a "Not sent within 24 hours" or "Couldn't be checked" History row.** | Keeps "never longer than 24 hours" even when the app is not opened (with the background job), and a clip never vanishes without a trace (gap 17). |
| P6-D8 | **The live flow feeds the outbox**: no answer, a 429 and the 4th busy answer (or Busy hidden) lead to Saved offline with a reason; Step 4's "No connection"/"Send again" and "Too many tries" variants are retired; 426 shows "Please update the app". | The plan's acknowledgement rule (keep on 409, 429, 503, network) applied to the live flow (contract §5.9); one place keeps every saved clip. |
| P6-D9 | **The chooser is the page of the `chooseStation` state**: the Identifying layout under a scrim with Material's `BottomSheet`, modal semantics named by the title, a scrim that ignores taps, drag down or back = Cancel; candidates in the answer's order; its own all-default-cards sentence. | Keeps "navigation follows the state" (S4-D5) while meeting P6-CHOOSER-11 and P6-ACCESSIBILITY-07; the server decides the order (contract §5.6; gaps 7, 25, 26). |
| P6-D10 | **A row tap shows the result at once with the haptic tick, queues the choice, sets "My station" if ticked and saves to History; Cancel records nothing anywhere.** | P6-CHOOSER-09 asks for no wait; the tick marks every result the same way (gap 29); a cancelled choice is not a result (gap 28). |
| P6-D11 | **"My station" is a local setting read at capture**, sent as the hint, never cleared by the app; the chip reads "My station: Not set" without one; the picker adds search above 10 stations and a "No station" choice. An unlisted station chosen in the chooser may become "My station" (amended after review; the server uses its hint when it is a candidate, §10 correction 5). | Contract §5.8; gap 2 (Q8); gap 33 (a list of up to 1,000 stations needs a search). |
| P6-D12 | **History keeps the answer as received and re-reads it with the shared reader**, keyed by recognition id, 50 entries and 30 days, no pictures, cards not refreshed, and "Clear history" if approved. | One reader for live and saved results; a replay cannot double an entry; History records which ads someone heard, so it is bounded and clearable (gap 20; Q7). |
| P6-D13 | **`/r/<recognition_id>` opens only from this phone's History.** No server route, no URL scheme, no intent filter; an unknown id goes to History. Amended after review: it is an internal route, not a shareable link, and P6-STRUCTURE-02's "deep link" is reworded only if the user agrees (Q18). | Gap 19; no other install can read a recognition. |
| P6-D14 | **A shell route for the three tabs; the redirect forces the flow's route only while an identify is under way; a pending destination for "See it in History" and notification taps; the current tab shown by bold text and a pill as well as colour.** | Tabs need free navigation; flows keep S4-D5's guarantee; gap 36. |
| P6-D15 | **Notifications and network checks come from an in-repo plugin** (`device_services`), Kotlin on the Android framework only; no launch URL scheme. Amended after review: it also keeps the process-wide set of attached engines and the take-over of dead locks (P6-D36), and launch ids are honoured only for recognitions it notified (P6-D41). | No download (about 8.8 MB saved); it registers in the background engine (fact 15); `MainActivity` is exported, so the launch extra needs its own check (fact 26; Q3). |
| P6-D16 | **Notification permission is asked only from "Allow notifications" on the Saved screen.** Amended after review (A6): **no notification names the brand, the ad, the station or the outcome**, on the lock screen or anywhere: "Look Up" / "Your saved clip has been checked. Tap to see the result." | Asks when the listener sees why, after a tap, like the microphone (S4-D22); Android shows a private notification in full on most lock screens, so only generic words keep which ad someone heard private (gap 17; Q4). |
| P6-D17 | **Background sending uses `workmanager` 0.10.10 if approved**, with a network-constrained one-off job and a six-hourly expiry job; foreground-service parts removed. | P6-OFFLINE-08 names WorkManager; writing a background engine runner by hand is more code to secure; without it clips wait for the next open (Q2, sized in full in §3.3). |
| P6-D18 | **Slow upload shows after 5 seconds**: "Still working — the connection is slow." with the share of the clip sent, or "Clip sent — waiting for the answer". | Gap 4 sets no threshold; a live answer normally takes under 3 seconds (2.5 s server wait plus the trip from Zambia). |
| P6-D19 | **The update gate on the app side**: register again whenever the running version differs; 426 shows "Please update the app" with no button; the outbox keeps everything; no card `min_app_version` field. Amended after review (A2): the pause ends when the version changes, when a live identify gets any answer other than 426, or when a probe (one item at each start and every 6 hours) does. | Gap 37 and contract §5.2; ALL-USABILITY-05 forbids a control that leads nowhere (Q14); the reader's `schema_version` rule plus the gate meets P6-COMPATIBILITY-03 (Q19); a minimum set by mistake must not freeze an outbox until its clips expire. |
| P6-D20 | **"Report this" is a sheet with four fixed reasons, sent through the outbox**, one per recognition, "Reported" afterwards. | Gap 5; no free text means nothing personal can be sent; it works with no signal (Q6). |
| P6-D21 | **"Used this month" counts request and answer bodies and pictures, per calendar month; "mobile data" means a metered network; with the switch off, no picture is requested and no box is drawn; WebP and widths wait.** | Gap 21 (Q11); a metered test also covers a phone's hotspot; P6-DATASAVER-01 cannot be met before pictures exist. |
| P6-D22 | **Every string in `app_en.arb`, a fallback Material localisation for unsupported locales, the app's own words for every error**, and (amended after review) English date symbols for a locale `intl` lacks (P6-D47). | P6-LOCALISATION-03 must hold for Bemba and Nyanja (fact 11); gap 23 (S4-D13 kept). |
| P6-D23 | **A dark theme from the generated dark tokens, following the phone.** | P6-THEME-01; the tokens already exist (fact 12); no card accent colour exists to adapt (gap 45). |
| P6-D24 | **One window-size helper on the tokens' breakpoints; a rail from medium; side panel at medium; two panes per tab at expanded; flow screens in one centred column.** | Plan §Mobile C; gap 4's tablet layouts. |
| P6-D25 | **Golden images with `flutter_test` and the SDK's fonts, loaded by their exact lower-case file names; the system font stays.** | No download; gap 22 settled for the app as `tokens.json` allows; the Linux run at P8 sees case (fact 10). |
| P6-D26 | **APKs split per ABI with a blocking 15,000,000-byte check; native libraries compressed if approved.** | Fact 13; gap 25 (local until P8's continuous integration; Q10). |
| P6-D27 | **Taps are one outbox item per (recognition, button) with the first tap's time, from live and saved results, with `sent_at`.** | Contract §5.4; gap 31; a History tap is a real use of the button (Q16). |
| P6-D28 | **Crash reports with no answer are queued (scrubbed, `occurredAt`, 20 at most, 7 days); a queued report shows no code.** | P6-ERRORREPORTING-05; Step 4's rule that a code means a log line exists. |
| P6-D29 | **Test numbers come from +44 7700 900000–900999 and links from `example.com` in every new or edited fixture**; the remaining sweep waits for approval. | The user asked whose the sample numbers are; this range will not be allocated (Q13). |
| P6-D30 | **The stand-in gets a control page, refuses forwarded control requests, and adds `slow-upload` and `match-with-images`** (and, after review, the checks of P6-D50). | The user's "tools must be usable" standard for walkthroughs; the ngrok tunnel would expose its controls (fact 24). |
| P6-D31 | **Emulator proofs**: the stand-in's "No signal" switch where the network should look connected, `dumpsys notification`, the shade or `am start` with the same intent, `am kill` never `am force-stop`. Amended after review: also **a real network change with the app open** (airplane mode, or `svc wifi` and `svc data`, whichever piece 0 proves), whatever Q2's answer; the notification permission granted through "Allow notifications" before any notification is expected; no picture step on the emulator. | Facts 8, 17 and 22; each proof works on the existing image with no download; the stand-in switch never makes Android report a network change. |
| P6-D32 | **Every deferred outcome has a History entry and, when answered, a notification**, with the wording of §2.16. | The Saved screen promises a result; a clip must never disappear silently (gap 17). |
| P6-D33 | **History shows the phone's capture time.** | Contract §5.14: a row does not jump when the answer arrives. |
| P6-D34 | **History is the app's "review what was made" control; behaviours this design adds (the oldest-clip note, unsent rows, panel variants, the report sheet, "Clear history", the first-open note, the control page) become checklist items once approved.** Amended after review: Home's instruction line no longer stands for the first-open note; P6-D40 builds one. | Gap 44; ALL-USABILITY-03; ALL-CHECKLIST-06. |
| P6-D35 | **The outbox retries by itself (A1), from piece 1**: no answer is a failure of the item being sent; while in the foreground one timer starts a run at the earliest `next_attempt_at`; the development base is 5 s, staging and production 30 s. From piece 3, a network reported back clears the no-answer waits, and no send is tried while Android reports no network at all. | Without it nothing was retried after "no answer" until a restart or resume, and on a network that looks connected but carries nothing, never (fact 25). Clearing no-answer waits when the network returns keeps P6-OFFLINE-02's "sent when back online" quick; not trying with no network keeps the backoff from growing in airplane mode. |
| P6-D36 | **Lock files name their process and engine and are never taken over by age**; a dead process's or a detached engine's lock is taken over by a checked rename inside the plugin; a deferred outcome is written to History before its outbox item is deleted; the background run starts no send after 8 minutes. | A live but slow engine kept its lock in the draft only for 30 s, which could lose a clip item and then its clip; a crash between History and the outbox now only causes a resend that the server answers with the same recognition id. |
| P6-D37 | **A clip is deleted at 23 h 58 min of the phone's clock, and at once when its capture time is more than 2 minutes ahead of the clock.** | The Permission screen promises "never kept longer than 24 hours"; a clock moved back must not stretch that, and the server would refuse such a clip anyway (`CAPTURE_TIME_INVALID`). |
| P6-D38 | **Pauses follow the server's allowances**: a 429 or 503 pauses only its group (clips, follow-ups, crash reports); a 426 pauses all. A 502, 503 or 504 to a deferred clip with no `Retry-After` waits a random 60–300 s. | A deferred clip's 429 can ask for an hour and must not hold a listener's choice or taps; the three follow-up kinds share one server allowance, so pausing them one by one would only spend two more requests to learn the same thing. The floor keeps saved clips from returning every 10 seconds when the server is busiest. |
| P6-D39 | **Every status has an action**: `acknowledgement-rules.json` gains a default row per kind and status class, and a test walks 200–599 for every kind; a second test checks files and items on disk per row. | "An unknown code is handled by its HTTP status" (contract §1.0) needs explicit rows; P6-OFFLINE-06 and -13 to -19 are verified by what is left on disk. |
| P6-D40 | **A one-time "How Look Up works" note on Home**, shown on the first launch only and dismissible with "Got it". | ALL-USABILITY-04 asks for a note on first open and not on later launches; Home's instruction line shows every time (gap 44; Q20). |
| P6-D41 | **Notifications carry generic words (A6), a request code each, and open only what this app notified**: a launch id is honoured only for a History entry marked `was_notified`. | Two intents differing only in extras are one `PendingIntent` (fact 27); `MainActivity` is exported (fact 26). |
| P6-D42 | **The chooser's sentence is chosen by "every candidate is a default card", and a default card's note is "These are [client name]'s usual contact details." (A7)**, both pending Q15. | The answer does not say why a card is a default card; from P4 an in-window chooser or result can show default cards (a campaign at its limit or paused after the capture), and both sentences must be true in every case. |
| P6-D43 | **A queued crash report has a `report_id`, sent as its `X-Request-Id` on every attempt.** | P6-OUTBOX-03 asks for one key reused on every retry; the API already takes a well-formed caller id and only logs reports, so a lost answer gives two log lines under one id instead of two unrelated reports. |
| P6-D44 | **When 200 follow-ups wait, taps go first, then reports, then choices, and never a choice with a queued tap.** | A recognition must not lose its listener's choice while its taps wait. |
| P6-D45 | **Values both engines touch in `shared_preferences` are read after `reload()`; the data-use count lives in a locked file.** | Each engine caches `SharedPreferences` (fact 9); a stale token costs a needless re-registration, and a lost byte count makes "Used this month" wrong. |
| P6-D46 | **A deferred outcome reaches History through `DeferredResultSink`** (an interface in `identify/domain`, implemented in `lib/app`). | §3.2 forbids one feature's data layer importing another's. |
| P6-D47 | **Day and month names fall back to English date symbols** when `intl` has none for the language. | `intl` 0.20.2 has no symbols for Bemba or Nyanja, and `DateFormat` would throw in History (fact 11). |
| P6-D48 | **A re-registration carries the install's own unexpired token (A3).** | Many listeners share one carrier address and all register again after an update; the server counts a re-registration against the install, not the address. |
| P6-D49 | **Pictures are shown live on the user's phone through the `https` tunnel to the stand-in; the app never accepts `http` pictures, in any flavour.** | No picture can load on the emulator (fact 17); a development exception for `http` would be a rule to keep out of staging and production for ever. |
| P6-D50 | **The stand-in's control routes need a JSON content type, its own origin and host; "No signal" acts before any queued answer is taken; the number replacement comes from the control page and never appears in the state, the log or the panel.** | Any web page could otherwise drive it (fact 24); a queued "Busy" must not be spent on a dropped request; a number on a command line lands in shell history and session records (ALL-LOGGING-02). |
| P6-D51 | **The phone's APK is always built with Docker closed, before Docker starts**; a phone check against the stand-in uses the same APK through the same tunnel (§5.0 (b), (c)). | ALL-BUILD-MACHINE-07 and -09; the Step 4 freezes on this 4-processor, low-memory machine. |
| P6-D52 | **Three points are recorded as deferrals the user sees, shared with the P4 design's Q13**: crash reports are logged only, never stored (checklist-3 gap 46); picture addresses in saved entries are decided with the picture screens and must then stay valid for History's 30 days or be re-signed (gap 38); how long the server keeps recognitions, candidates, taps and reports is decided in P8 with O7 and the data-protection review (checklist-5 gap 9). | Each touches the app but is decided once, on the server's side; the app's rule meanwhile is in §3.14 and §3.20. |

---

## 8. Questions only the user can answer

Each has a recommended answer. The build goes ahead on the recommendation unless the user says
otherwise. Amended after review: each question names the checklist items that depend on it and the
piece that waits for it; **Q6, Q13, Q16 and Q17 block piece 0**, the first piece, because piece 0
writes the shared contract's schemas and fixtures in the same commit as the P4 design's piece 1. Four
questions are the same as the P4 design's (§10 there) and need one answer for both: **Q6 = P4 Q6**,
**Q13 = P4 Q7**, **Q15 = P4 Q8** and **Q16 = P4 Q14**. The P4 design's Q13 also settles three app
points (crash reports logged only, picture addresses, how long server records are kept; P6-D52), so
they are not asked here again. The draft's lock-screen question (part of Q4) is answered by amendment
A6 and dropped.

| # | Question | Recommended answer | Why | Items that depend on it | Piece that waits |
|---|---|---|---|---|---|
| Q1 | Where should the phone keep waiting clips and History? The plan says the Drift database. | **App-private files with a small index file** (no download), and reword P6-OUTBOX-01 from "Drift" to "app-private files". If you want a real database: sqflite (0.2 MB), not Drift. | Drift costs about 22 MB plus a SQLite download at every fresh build, and code generation; the outbox holds at most 5 clips and a few hundred small records. | P6-OUTBOX-01, -02; P6-HISTORY-01 | Piece 1 (the outbox store) |
| Q2 | May the app send saved clips in the background when the signal returns, even with Look Up closed (P6-OFFLINE-08)? | **Yes: approve `workmanager` 0.10.10.** Exact download: **3,174,229 bytes** (208,277 of Flutter packages + 2,965,952 of 13 Android libraries and their metadata), **at most 3,262,830** if Gradle also reads 88,601 bytes of metadata it then discards. Android only, foreground-service parts removed, no build tool version change (§3.3 lists every file, its size and its publication date). | Without it a clip waits until the app is opened, the notification promise is weak, and a never-opened app deletes its clip only at the next start. | P6-OFFLINE-08; the 24-hour promise when the app is never opened (gap 17); ALL-BUILD-MACHINE-04, ALL-TESTS-04 | Piece 3 (the background job only) |
| Q3 | How should the "result is ready" notification and the Wi-Fi or mobile-data check be built? | **No new package**: a small Look Up plugin in Kotlin using Android's built-in services; permission through the already-pinned `permission_handler`; iOS later. | `flutter_local_notifications` costs about 8.4 MB and a build change, `connectivity_plus` another 0.4 MB, for one notification and one yes/no check. | P6-OFFLINE-20, -21, -27; P6-DATASAVER-05, -06 | Piece 3 |
| Q4 | When should the app ask for notification permission (Android 13+)? | **An "Allow notifications" button on the Saved screen**, the first time a clip is kept. (What the notification says is settled by amendment A6: only "Look Up" / "Your saved clip has been checked. Tap to see the result.") | No source says (gap 17); asking after a tap, at the moment it matters, is the microphone pattern. | P6-OFFLINE-20, -27 | Piece 3 |
| Q5 | Five clips already wait and the listener records a sixth with no signal. What happens? | **Keep the new clip, delete the oldest waiting one, and say so on the Saved screen.** One random 0–2 minute wait per run, not per clip. | Refusing would throw away the ad the listener cares about now. | P6-OFFLINE-04, -12 | Piece 3 |
| Q6 (= P4 Q6) | What should "Report this" do? | **Approve the report route (contract §1.6)** with the four reasons of §2.14, "Thanks — we'll check this ad.", one report per phone per result, kept with the station and an anonymous code for the phone (a keyed hash), read by super admins only once 5a exists; the Privacy page says so. | WhatsApp would show the listener's number to support; a stored report with fixed reasons carries nothing personal. | P6-RESULT-04, -05; P4-REPORTS-01 | **Blocks piece 0** (its schema and fixtures); the sheet waits for piece 4 |
| Q7 | How much should History keep, and can the listener clear it? | **The last 50 results, at most 30 days, and a "Clear history" row in Settings** (not in the wireframe) that also deletes waiting clips. Saved cards are not refreshed; a cancelled "Which station?" is not saved. | History records which ads a person heard, and a withdrawn number should not stay callable for ever (gap 20). | P6-HISTORY-01, -07; P6-SETTINGS (a new row) | Piece 2 |
| Q8 | What should the "My station" chip say before a station is chosen? | **"My station: Not set"**, opening Settings like the normal chip. | The wireframe only shows a chosen station (gap 2). | P6-NAVIGATION-03 | Piece 2 |
| Q9 | What should the Privacy and About pages say before the Phase 8 privacy notice? | **The interim texts in §2.13**, Privacy marked as a short summary until the full notice; About with the version and the support link once the number exists. | The wireframe has the rows but no content; legal wording is Phase 8 (O15). | P6-SETTINGS-06, -07 | Piece 2 |
| Q10 | The 15 MB per-APK limit fails today (about 19–20 MB). How should it be met? | **Compress native libraries in release builds and split per ABI**, keeping 15 MB per APK. The cost: Android unpacks the libraries at install, so the app takes about 17 MB more storage on the phone. If storage matters more, measure the download size (zipped) instead. | Flutter stores its libraries uncompressed, so a per-ABI APK is about 19 MB before any P6 code (fact 13); WorkManager, if approved, adds some code too. | P6-PERFORMANCE-01, -02; P6-TESTS-12 | Piece 6 |
| Q11 | What should "Used this month" count, and how are pictures handled while stations cannot add any? | **Every byte the app's own requests and answers carry, plus pictures; reset on the 1st.** Build the pictures switch now, shown on your phone with the stand-in's sample pictures; sizing and WebP come with the portal's picture screens. | No source defines the counter (gap 21); no station can attach a picture yet. | P6-DATASAVER-01, -03, -05, -06 | Piece 4 |
| Q12 | Which phones should the real-device checks use? Which Android version is your phone ("POWER 80")? And was Look Up reinstalled between the two registrations seen on 10 October? | **TalkBack and offline checks on your phone. Slow 2G/3G shown on the emulator's own network-speed setting** (no download) as a stand-in. The 2 GB Android 8/9 phone and the radio-at-3-metres field test move to the pilot (Phase 8) unless you have such a phone. | Those items need hardware only you have (gap 24). | P6-TESTS-05, -10, -11; P6-ACCESSIBILITY-02 | Piece 6 (the phone checks of pieces 1–5 go ahead on your phone) |
| Q13 (= P4 Q7) | Which numbers should the test data use instead of +260 97 712 3456 and +260 96 612 3456? | **+44 7700 900000–900999** (the UK range kept for films and TV, never assigned) and `example.com` links in every new and edited fixture (piece 0), and a separate mechanical sweep of the rest after piece 0, in every written form (E.164, grouped, `0977 123 456`, `977123456`, the `wa.me` digits), screen text and comments included: **45 fixture files** (41 in E.164 form, and 4 that test that a local or spaced form is refused), **49 code, test and script files** and **5 documents** (recounted after review; fact 20). The portal's hint becomes a pattern with no real digits, "Like 09XX XXX XXX". `+260` stays only in the tests of how a Zambian number is displayed. A Zambian test number only after checking ZICTA's numbering plan for an unallocated range (none known). | You asked whose the numbers are; the realistic ones may belong to real people, and the portal shows one to every station user. | ALL-DECISIONS-03; the fixtures of contract §2.6; P6-LOCALISATION-04's test data | **Blocks piece 0** (the numbers in its new fixtures); the sweep comes after it |
| Q14 | The update gate has no app-store listing to send people to. Is a plain message acceptable? | **Yes**: "Please update the app" / "This version of Look Up is too old to identify ads.", with no button until a Play listing exists. These are the screen's only words; the contract's shorter line is a summary (§10, correction 9). | The app must not tell people to do something it gives them no control for. | P6-COMPATIBILITY-02; ALL-USABILITY-05 | Piece 3 |
| Q15 (= P4 Q8) | Two sentences on the listener's screens. (a) When every station offered in "Which station?" shows only the advertiser's usual buttons, "This ad is on more than one station right now." may be untrue. (b) The usual-buttons note said "This ad isn't on air right now…", which from P4 is untrue when a campaign reached its tap limit or was paused while the ad is on air. | (a) **"This ad is played on more than one station."** whenever every candidate is a default card. (b) **"These are [client name]'s usual contact details."** for every default card (amendment A7). | No wireframe covers either (contract §5.6); the answer does not say why a card is a default card, so each sentence must be true in every case. | P6-CHOOSER-13; P4-FALLBACK-02 (app half), P4-LIMITS-05, P4-TIMERULE-06 | Piece 1 |
| Q16 (= P4 Q14) | May each button tap carry the time it was sent as well as the time it happened (`sent_at`)? | **Yes**: the server corrects a wrong phone clock the same way it does for clips. If not, the field and the correction are dropped on both sides together. | Contract §5.4; without it a phone with a wrong clock files taps at the wrong time. | P6-OUTBOX-06; P4-ENGAGEMENTS-01, -03, -04 | **Blocks piece 0** (the tap body's schema and fixtures); taps wait for piece 5 |
| Q17 | In what order should the pieces be built and shown to you? | **As §5**: 0 groundwork, 1 Which station?, 2 tabs/History/Settings, 3 offline and notifications, 4 data saver and Report this, 5 tap counting, 6 tablets, goldens, size and the gate; a walkthrough after each. | It follows the plan's order (chooser before offline, engagements last), and each piece can be shown on its own. | P6-SCOPE-01 | **Blocks piece 0** |
| Q18 (new) | P6-STRUCTURE-02 says the app "handles the deep link `/r/<recognition_id>`". May it say "an internal route `/r/<recognition_id>`, opened from History and from a notification"? | **Yes, reword it.** No shareable link in version 1: no URL scheme and no link another app or a browser can open. | A result exists only on the phone that heard it (gap 19), so a shared link could open nothing for anyone else; an open link would also be one more way in from outside. | P6-STRUCTURE-02 | None for the build (piece 2 builds the route either way); the item is ticked only after the answer |
| Q19 (new) | P6-COMPATIBILITY-03 gates cards by `schema_version` **and a card's `min_app_version`**. May "and `min_app_version`" be dropped? | **Yes**: cards get no version field; the app's own reader shows "update" for a newer `schema_version`, and the 426 gate refuses an app below the configured minimum. The item's own test (minimum set above the build, identify gives the update message) is met by the gate. | A per-card field would need the portal to set it and every card version to carry it, for no case the two existing rules miss (contract §5.2). | P6-COMPATIBILITY-03; P4's 426 gate | None for the build (piece 3); the item is ticked only after the answer |
| Q20 (new) | The rule says every app shows a short "how it works" note on first open (ALL-USABILITY-04), and no wireframe has one. Is the note of §2.3 right? | **Yes**: a card on Home on the first launch only, "How Look Up works" — "Tap Identify while an ad plays on the radio, and Look Up shows the advertiser's buttons: call, chat, directions or website." and "Ads you identify are saved in History, so their buttons work even without data." — with "Got it". If you prefer no card, the other way is to reword ALL-USABILITY-04 so Home's instruction line counts; not recommended, because the line shows every time. | Home's instruction line shows on every launch, so it cannot meet "on first open, and not on later launches". | ALL-USABILITY-04 | Piece 2 |

---

## 9. Items in other parts of the checklist this phase touches

- **P4 (checklist 2)**: the app needs the P4 gate's first part (P4-RESOLUTION-16: resolution with the
  hint, `CHOOSE_STATION` with inline cards, the choice route, the station list, the 426 gate, the
  deferred allowance and shedding) before the phone walkthroughs of pieces 1–3 — in the P4 design's
  pieces 2 and 3 for this design's pieces 1 and 2, and its piece 4 for pieces 3 and 4 — and its second
  part (P4-RESOLUTION-17: engagements and limits, the P4 design's piece 5) before piece 5. The app
  halves of P4-DEFERRED-01, P4-RESOLUTION-10, P4-CHOICE-02 and P4-ENGAGEMENTS-02 are the sender tests of
  §4.2. The S3-REQUEST-13 evidence is re-run when the per-install count moves (contract §2.8 and the
  server design's Correction 1).
- **S4 items whose evidence changes on purpose**: S4-SCOPE-05 (its two "absent in Step 4" tests are
  retired; the gate review of Steps 1–4 stands), S4-STATE-03 (nine states become eleven; the nine are
  still there), the S4 Error and flow tests named in fact 4, S4-USABILITY-02 (support number,
  unchanged), and S4-INSTALLS-02 (a re-registration now carries the token, A3).
- **S3-RESPONSE-17**: the station id stays the one public reference; the chooser, the hint, the choice
  and taps all use it.
- **Security baseline (ALL-SECURITY-06)**: the rows of §3.22 are added and the changed rows edited
  before the gate; each new store and call is checked against it.
- **ALL rules met here**: visible navigation (ALL-USABILITY-01, the tab bar), a review control
  (ALL-USABILITY-03, History), a first-open note (ALL-USABILITY-04, §2.3, Q20; added after review), no
  instruction without a control (ALL-USABILITY-05, the update screen and the notification panel),
  dependencies checked on 3.41.9 before adding (ALL-TESTS-04), downloads listed with exact sizes for
  approval (ALL-BUILD-MACHINE-04, §3.3), Docker and the emulator never together (ALL-BUILD-MACHINE-06),
  the phone's APK built with Docker closed (ALL-BUILD-MACHINE-07, -09, P6-D51), full-word names
  (ALL-NAMING-02: `notification_icon.xml`), no phone number in a log or a command line
  (ALL-LOGGING-02, P6-D50), mobile patterns and responsiveness in the design (ALL-DECISIONS-02), and
  new behaviour added to the checklist first (ALL-CHECKLIST-06).

---

## 10. The interface contract

The contract below is copied verbatim; this design builds the app side of it. The **contract
amendments after review (A1–A8)** follow it, also verbatim, and win where they differ from it.
**Corrections**, stated here instead of editing the copy (5 to 16 added after review; the server
design states the same ones it shares):
1. Contract §2.7 calls `SAMPLE_PHONE` "the development seed's": it is in `apps/api/scripts/sample-ads.ts`,
   which the seed (`scripts/seed-development-data.ts`) uses. The change is the same.
2. Contract §2.7 says the other files with the realistic numbers are "about 54 fixture files plus
   tests". Recounted after review over the files git tracks, in every written form: 54 fixture files
   hold them in E.164 form (13 of them the recognize-response fixtures edited now, so **41** others),
   **4 more fixture files** hold them in local or spaced form (`action-card/invalid/local-phone-number`,
   `phone-with-spaces`, `zambian-number-ten-digits` and `action-card/reader/bad-phone-skipped`), and
   **49 code, test and script files** and **5 documents** hold them too (fact 20). The server design's
   count of 41 fixture files leaves out those 4.
3. Contract §5 point 16 says to diagnose Step 4 emulator run 4: run 5 then passed all 17 steps and the
   gate record calls run 4 a one-off drop. The precondition kept here is to make the emulator evidence
   record the app's no-answer reason before the no-answer path is rewritten (piece 0).
4. Additions to contract §4 (the stand-in), not corrections: the control page, the refusal of
   forwarded control requests, the `slow-upload` and `match-with-images` scenarios (P6-D30), and the
   checks of P6-D50 (§4.7). Its `CLIENT_ERROR_FIELDS` must gain `occurredAt`, and `/installs` must
   accept a token it issued (A3); `station_hint` is already accepted (fact 7, corrected after review).
5. **Hints for unlisted stations** (the server design's Correction 3, adopted). §1.2's `station_hint`
   row and §5 point 8 ignore a hint for an "unlisted" station. The server uses a hint for **any**
   station that is a candidate, listed in the app or not, and ignores it silently only when the
   station is unknown, suspended or not a candidate; being listed decides only whether a station
   appears in `GET /stations`. The app needs no change (§3.13).
6. **Order of checks** (the server design's Correction 1, adopted). §1.0's order is exact for no route.
   For `POST /recognize`, the places in flight (503) are checked when the text fields have arrived,
   with the per-install allowance chosen by `is_deferred` (or the replay allowance, 60 an hour, for a
   key the server already holds; 429). So no 503 is answered before the fields, the sentence in §1.2
   about "a 503 refused by the in-flight limit before the text fields are read" no longer applies, and
   every 503 to a deferred send carries the deferred 60–300 s `Retry-After`. A 429 to a resend of a
   held key is handled by the 429 row like any other.
7. **A deferred clip's busy wait** (app side; an addition, not a change). The app still honours
   whatever `Retry-After` arrives. For a `DEFERRED_CLIP`, a 502, 503 or 504 that carries no
   `Retry-After` pauses the clips group for a random 60–300 s instead of the short item backoff (§3.9
   point 9). After correction 6 only an answer from something in front of the API (a proxy's 502 or
   504) lacks one; `acknowledgement-rules.json` gains those rows.
8. **Pauses by allowance** (app side). R8 and §3's table say "pause the whole sender" for 429 and 503.
   The app pauses only the group of the route that answered — clips, follow-ups (choice, taps and
   reports share one server allowance) or crash reports — and keeps "pause everything" for 426 (§3.9
   point 4). The server design says its allowances are independent, so this needs nothing from it.
9. **The 426 words.** §1.2's live column gives "This version of Look Up is too old. Please update the
   app." The screen's words are §2.15's: heading "Please update the app", body "This version of Look Up
   is too old to identify ads." (Q14). The column only summarises them; nothing on the wire changes.
10. **A queued crash report's request id.** §1.0 says `X-Request-Id` is new on every attempt. For a
    `CLIENT_ERROR_REPORT` item the app sends the item's `report_id` as its `X-Request-Id` on every
    attempt (P6-D43); the API already keeps a well-formed caller id. Every other request is unchanged.
11. **Default acknowledgement rows.** §3's table leaves "—" in several cells. `acknowledgement-rules.json`
    gains a default row for every kind and status class (another 2xx: delete, plus a report for a clip;
    another 3xx or 4xx: delete plus a report, never a report about a crash report; another 5xx: keep and
    back off; a 409 of any kind: keep and wait for its `Retry-After`, 3 s by default). The rows name no
    code, so the server's test, which checks each row's code against `ERROR_CATALOG`, skips them.
12. **The stand-in's number replacement.** §4's `--replace-phone-numbers-with <E.164>` command-line flag
    is replaced by a form on the control page (a POST from the PC's own browser). The number is never
    echoed, logged or written, and `/__fake/state` and the panel show no stored answers (P6-D50).
13. **Clip expiry on a clock that moves.** R5 deletes a clip at `captured_at` + 24 h. The app deletes it
    at `captured_at` + 23 h 58 min, and at once when `captured_at` is more than 2 minutes ahead of the
    phone's clock (P6-D37). The server's 24-hour rule is unchanged.
14. **Network back and no network** (app side, with A1). When Android reports the network back, the
    waits that came from "no answer" are cleared and a run starts with its 0–120 s wait; waits the
    server asked for stay. While Android reports no network at all, no send is tried and no failure is
    counted (§3.9 points 7 and 9).
15. **`/installs` and the token.** §1.0 says the token is never sent to `/installs`. Amendment A3 wins: a
    re-registration carries the install's own unexpired token (§3.12).
16. **A report for another station.** §1.6 says a report's validity is that of §1.5. With amendment A4,
    a report naming another station than the chosen one gets 422 `STATION_ALREADY_CHOSEN` (delete plus
    a report, the follow-ups' 422 row); the app always names the shown or chosen station.

# Listener app and API contract for P4 and P6

Paths are relative to `C:\dev\Look Up`. This contract is checked against these files: `packages/contracts/src/recognition/recognize-schemas.ts` and its fixtures, `apps/api/src/features/recognition/*`, `apps/api/src/common/{errors,rate-limiting,listener-authentication}`, `apps/mobile/lib/core/network/*`, `apps/mobile/lib/features/identify/{data,domain}`, `apps/mobile/tool/fake_listener_api.py`, the checklists and the approved plan. Where the two maps disagreed, the decision is stated here once, and section 5 lists each one.

**Gates.** Gate part 1 (P4-RESOLUTION-16) builds the recognize changes, the choice route, the station list and the update gate (426). The P6 chooser, outbox, History and Settings are built against those. Gate part 2 (P4-RESOLUTION-17) then builds the engagements route, which is specified in full now so the outbox is built once.

---

## 1. Endpoints

### 1.0 Rules for every listener route

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
| Per-address ceiling | `LISTENER_ROUTES` in `apps/api/src/common/rate-limiting/limit-requests-per-client-address.ts` gains `/api/v1/stations`, `/api/v1/engagements` and the pattern `^/api/v1/recognitions/[0-9a-f-]{36}/(choice|report)$`. All of these count against `LISTENER_REQUESTS_PER_CLIENT_ADDRESS_PER_MINUTE` (600). The test "covers exactly the listener app's routes" changes with it. |
| App client | `ApiClient.listenerRoutePaths` (`apps/mobile/lib/core/network/api_client.dart`) becomes a matcher for `recognize`, `stations`, `engagements` and `recognitions/<uuid>/(choice|report)`. `ApiClient` gains `getJson(path, {installToken, ifNoneMatch})`, which returns `ApiAnswer` and never throws, like the existing methods. |

### 1.1 `POST /api/v1/installs` (existing, one behaviour change)

- The request `{install_id, platform, app_version}` and the answer `{install_token, expires_at}` are unchanged.
- **App change:** the app keeps the `app_version` it registered with. When the running `AppVersion.current` differs, it registers again (same install id) before its next listener request. If that registration gets no answer, the request counts as "no answer", so a clip is kept and nothing is sent with the old token.
- **Server:** registration never answers 426. It always records the version, so an updated app can clear the gate.
- Checklist: P6-COMPATIBILITY-01 (how the version travels, gap 37), S4-INSTALLS-02.

### 1.2 `POST /api/v1/recognize` (existing; P4 changes)

**Request** (`multipart/form-data`). The fields are unchanged; two rules are new.

| Part | Value | P4/P6 rule |
|---|---|---|
| `clip_duration_milliseconds`, `codec`, `idempotency_key`, `captured_at`, `sent_at` | as today (S4 §3.10) | Deferred sends: `captured_at` and `idempotency_key` are the original values; `sent_at` is taken fresh before every attempt. |
| `is_deferred` | `"true"` or `"false"` | `"true"` for **every send made by the outbox**, `"false"` for every send made by the live flow. **The field as sent chooses the allowance, the admission threshold, the Retry-After range, the queue priority and the wait (2.5 s or 5 s).** The `is_deferred` that is stored and answered is the computed one: the flag, or receipt more than 120 s after the corrected capture time. |
| `station_hint` | the "My station" id, or absent | The station that was "My station" **when the clip was captured**. It is stored with an outbox clip and is not re-read at send time. The server uses it (HINT, P4-FALLBACK-01). A hint for an unknown, unlisted, suspended or non-candidate station is ignored silently, never refused. `hinted_station_id` is stored only when the station exists. |
| `audio` | file part, **last** | **New contract rule:** every text field comes before the audio part. If an audio part arrives before all the text fields, the server answers 400 `VALIDATION_FAILED` with `fields:[{path:"audio", code:"audio_part_before_fields"}]`. The app already sends in this order (S4-D8), and the fake already checks it. |

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

### 1.3 `POST /api/v1/recognitions/{recognition_id}/choice` (new, gate part 1)

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

### 1.4 `GET /api/v1/stations` (new, gate part 1)

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

### 1.5 `POST /api/v1/engagements` (new, gate part 2: build with P6-OUTBOX-06)

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

### 1.6 `POST /api/v1/recognitions/{recognition_id}/report` (new; build only if the user approves "Report this", P6-RESULT-04)

- **Body** `ReportRecognitionInput`: `{station_id, reason}`, where `reason` is one of `WRONG_OR_MISLEADING_BUTTONS`, `NUMBER_OR_LINK_DOES_NOT_WORK`, `LOOKS_LIKE_A_SCAM`, `SOMETHING_ELSE`. There is no free text.
- **Answer:** 204. There is one report per recognition: the first wins, and a repeat gets 204, even with another reason.
- Validity, errors and limits are the same as 1.5, without ACTION_NOT_ON_CARD.
- Reports are stored for the 5a console and are never shown to stations with any listener identity. They go through the outbox.
- **Checklist:** P6-RESULT-04, -05.

### 1.7 `POST /api/v1/client-errors` (existing)

- `ClientErrorReport` gains an optional `occurredAt` (ISO with offset, camelCase like the rest of that schema) for reports queued offline. Answers stay 202, 400 and 429.
- **Checklist:** P6-ERRORREPORTING-05.

### 1.8 Not a server route

`/r/<recognition_id>` opens a result from the local History cache only (gap 19). No server route is added.

---

## 2. Changes to `packages/contracts`

### 2.1 Schemas

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

### 2.2 Constants and functions

- **`src/recognition/listener-app-versions.ts`**
  - `compareListenerAppVersions(first, second): -1 | 0 | 1 | null`. It parses `^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:\+(\d{1,9}))?$`, compares major, minor, patch, then build (a missing build counts as 0), and returns `null` when either value cannot be parsed.
  - `isBelowMinimumAppVersion(registered, minimum)`: true on −1, or on `null` when the minimum is not `0.0.0`.
  - The API configuration validates that `LISTENER_MINIMUM_APP_VERSION` (default `0.0.0`, gate off) parses.
- **`src/recognition/listener-outbox-rules.ts`**: the values the app and the server must agree on, equal to `fixtures/listener-outbox/timing-rules.json` (section 3).

### 2.3 Reason codes

| Code | Where | Relayed in `VALIDATION_FAILED`? |
|---|---|---|
| `audio_part_before_fields` | recognize reader | yes: add `RECOGNIZE_REQUEST_REASONS` to `VALIDATION_REASON_CODES` |
| `candidate_station_repeated` | `RecognizeResponse` refinement | no (response rule; contract tests only) |
| `station_listed_twice` | `ListenerStationList` refinement | no |

### 2.4 Error catalogue (`apps/api/src/common/errors/error-catalog.ts`) and envelope fixtures

| Code | HTTP | Message | Envelope fixture (new, `fixtures/errors/envelopes/`) |
|---|---|---|---|
| APP_UPDATE_REQUIRED | 426 | "Please update the app." | `app-update-required.json` |
| STATION_NOT_A_CANDIDATE | 422 | "That station isn't one shown for this recording." | `station-not-a-candidate.json` |
| STATION_ALREADY_CHOSEN | 422 | "A station was already chosen for this recording." | `station-already-chosen.json` |
| ACTION_NOT_ON_CARD | 422 | "That button isn't on this card." | `action-not-on-card.json` |
| NOT_FOUND (exists) | 404 | "Not found." | `not-found.json` |

`CODES_THE_APP_MAPS` in `packages/contracts/test/error-envelope-fixtures.test.ts` gains these five codes. The deferred Retry-After variants do **not** go in `errors/envelopes`, because that test allows one envelope per code with fixed Retry-After values. They live in the outbox fixture (2.6).

### 2.5 Emitted JSON Schemas (`packages/contracts/schemas/`, `scripts/emit-json-schemas.ts`)

- New: `listener-station-list.schema.json`, `recognition-station-choice-input.schema.json`, `record-engagement-input.schema.json`, `report-recognition-input.schema.json`.
- Regenerated: `recognize-response.schema.json` (city), `client-error-report.schema.json`.
- `$id`s follow `https://contracts.lookup.invalid/<name>/1.json`.
- The three input schemas must stay flat objects of strings so the Dart `ContractSchemaChecker` can read them.

### 2.6 Shared fixtures

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

### 2.7 Data rules for fixtures and the seed

- **Phone numbers:** only Ofcom's drama range, **+44 7700 900000–900999** ("will not be allocated to communications providers in the foreseeable future"). Use `+447700900NNN` with NNN unique per card within a fixture. There is no such reserved range known for Zambia. The card schema accepts any E.164 number, and the +260 nine-digit rule only applies to +260.
- **Links:** `https://example.com/...` (reserved by RFC 2606). `example.co.zm` is not reserved and is used in 16 fixture files today.
- **Edit and replace now:** the 13 recognize-response fixtures (4 valid, 9 invalid) and the development seed's `SAMPLE_PHONE` must be edited in this phase anyway (city, Station B), so their numbers and links change in the same commit. The other files with `+260977123456` or `+260966123456` (about 54 fixture files plus tests) wait for the separate sweep the user is asked about. `phone_number_display_test`'s +260 formatting cases stay.

### 2.8 Tests that change on purpose

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

## 3. Rules for deferred clips and outbox entries

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

## 4. Python stand-in API (`apps/mobile/tool/fake_listener_api.py`)

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

## 5. Open points the two designs must decide the same way (recommended decision)

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

## The user's answers (11 October 2026)

- **Every recommended answer is accepted**, as presented to the user in one list of 29 (the server design's Q1–Q14 and the app design's Q1–Q20, with the four shared questions asked once). Each is decided as this design recommends it; a checklist item that one of them rewords is changed in the checklist, with this date as its source, before it is ticked.
- **Download approved:** `workmanager` 0.10.10 with its Android libraries (3,174,229 bytes, at most 3,262,830), for sending saved clips with the app closed. It is downloaded when the P6 design's piece 3 starts, not before.
- **The ngrok token pasted in chat on 10 October 2026 is not rotated yet.** The tunnel stays off, and no phone walkthrough (set-up B) starts, until the user confirms it is rotated and has added the new token in their own terminal.

---

## Step 1 record (11 October 2026): P4 piece 1 and P6 piece 0

**Built:**
- The shared contract and safe sample data (`ff683c1`, the P4 design's piece 1).
- The app's groundwork (`232d188`, this design's piece 0).
- The two halves joined (`72c2bce`): the app's tests read the new fixtures.

**Suites at the join:**

| Suite | Result |
|---|---|
| Contracts | 641 |
| API | 553, in 38 files |
| Portal | 657 |
| Python | 189 |
| Flutter | 1,678 (analyze and format clean) |
| Tool tests | 97 |

The evidence checker was green.

**Review.** Five lenses, each finding checked by a sceptic, found 21 problems (5 medium) and refuted 8. All but three are fixed in `bca440d`:
- The outbox rules gain status-level 429 and 426 rows, so an answer with no code never deletes a saved item.
- The install repository re-reads the store before each decision (P6-D45). Its test now fails on the old code.
- The scan for words outside the language file catches every pattern the screens use.
- Every fixture folder of step 1 is scanned for realistic numbers.
- The stand-in's control page gets checklist items P6-TESTS-14 to -21.
- Smaller fixes to the stand-in and to the tests that could not fail.

Left for the lead:
- **The seed test's number outside the drama range.** It is fixed after step 2, which changes the seed.
- **The emulator command proofs of fact 8.** They are run with Docker closed, at the next emulator session.
- **A recorded deviation.** The design asked for step 1 as one commit, but it landed as three. Both halves were built in parallel, so the Flutter suite is red at `ff683c1` and `232d188`, and green from `72c2bce`. The commits are kept as they are (no history rewrite); anyone bisecting should skip those two.

**The stand-in's replacement phone number (amends §4.7).**
- The number is put only into answers to the one install the user picks on the control page. The page lists the last six registrations with a short label, the time and whether they came through the tunnel, and never shows the address.
- It is forgotten after three answers that carry it, or after five minutes.
- Through the tunnel nobody else's identify gets it.

**Still realistic, for the approved sweep:**
- `action-card/valid/six-actions.json`, which the stand-in's "Match with six buttons" scenario serves;
- `+260971234567` in `test/support/example_app_configurations.dart`;
- the 45 fixture files and 49 other files counted in Correction 2 of the P4 design.


## Step 2 record (13 October 2026): P4 piece 3 and P6 pieces 1 and 2

**Built:**
- The listener's station choice and the station list on the server (`0b4370d`, the P4 design's piece 3): the choice
  route, `GET /stations`, the follow-up allowance, the wider listener-route ceiling, and the stand-in's choice and
  station-list routes with the scenarios the walkthroughs use.
- "Which station?" in the app, with the outbox's first item (`9555993`, this design's piece 1).
- The tab bar, History and Settings (`1c2137b`, piece 2).
- The emulator journeys of §4.8 steps 1 to 5 and 17 (`b519dd4`).
- Alongside: the app stays English only (`5499b50`, the user's decision); a never-assigned number in the start-up
  tests (`0de7cda`).

**Suites at the end of the step:**

| Suite | Result |
|---|---|
| API | 873, in 54 files (typecheck clean) |
| Flutter | 2,303 (analyze and format clean) |
| Tool tests | 142 (the stand-in 56, the emulator runner 86) |
| Contracts, portal, Python fingerprinter | unchanged by this step, not run again |

The evidence checker was green.

**Reviews and fixes.**
- **Piece 3 and piece 1 (one reviewer, five lenses):** nothing on the server; five findings in the outbox, one medium.
  - The medium one: a wait stored while the phone's clock was ahead was cut to an hour only when it was read, so the
    cut moved forward with the clock and a choice could wait days. Fixed in `7684836`: the clean-up before each run
    writes the cut (an hour for an item or a group, 6 hours for a 426 probe).
  - A 426 probe with no answer ended the pause. Fixed in `7684836`: only an answer from the server ends it.
  - A storage that cannot be written led to a resend loop. Fixed in `7684836`: the folder is tried again, failed runs
    back off up to 30 minutes, and a settled item is never sent again in that app session.
  - A Zambian-format number in a test. Fixed in `0de7cda`.
  - An empty lock file could be taken over once a second engine exists. Carried into piece 3 (`a8d61df`).
  - A check of the fixes found four rules no test held (a probe's registration with no answer; probes answered 500,
    429 or a twice-refused token; the cut-off points; the failure ceiling). Tests in `a97106d`, each failing when its
    rule is broken on purpose.
- **Piece 2:** its review run was stopped when the user asked, on 13 October 2026, that the rest of the system be
  built without helper agents; the lead then reviewed the riskiest parts (the station list kept for 24 hours, the
  History store, navigation, what crash reports record) and found one defect: History, like the outbox before it,
  kept a folder that could not be made as failed until the app restarted. Fixed in `f9d3322`.

**Emulator run (13 October 2026, Docker closed): 24 of 24 steps passed.** The eight Step 4 journeys, the six new ones
(the chooser with no signal and the choice arriving once after it; "Remember my station"; Cancel; History with no
signal; the station list asked for once; the first-open note), the request sizes, the device log (17,883 lines, no
private value), the clip, the production build's refusal of plain http, and the emulator commands of fact 8:
airplane mode, `svc wifi` and `svc data`, and `dumpsys notification` all work; the test image has **no notification
shade**, so step 18 (two notifications opened through the shade) is shown on the phone in piece 3 (b), as §4.8 says.
This also closes the step 1 review's leftover on fact 8. P6-MYSTATION-02 is ticked on this run; P6-TESTS-07,
P6-CHOOSER-15, P6-HISTORY-02 and ALL-USABILITY-04 record their emulator halves and wait for the phone check (or, for
ALL-USABILITY-04, the portal).

**Deviations and readings, recorded for the gate:**
- **Built later, by design:** the update gate (426) and the hashed `actor` on listener log lines come with the P4
  design's piece 4; a 426 pause ending because a live identify got another answer, the chooser opened from a saved
  recognition, History's waiting rows, and "Clear history" deleting waiting clips come with piece 3; the Privacy
  page's points on saved clips and "Report this" come with pieces 3 and 4.
- **The outbox:** after "no answer", the next run never starts before the failed item's own wait (this design's
  reading of A1, so untried items are not sent into the same silence); a registration that fails counts as a failure
  of the item and ends the run, and a 429 on a registration marks the item limited without pausing its group.
- **The answer reader is stricter than Step 4's:** a `MATCH` without a version-7 recognition id is unreadable.
- **The station list:** the ETag is compared exactly (a weak `W/"…"` copy, or `*`, gets the list); Express's own weak
  ETags remain on the other answers, which all say `no-store`; a list naming the nil or the max UUID is refused whole.
- **The stand-in** answers a choice on another install's recognition with a refusal (400), as contract §4's
  "refuse" column says, where the real API answers 404.
- **Screens:** the "Remember" checkbox is Material's 18 dp (the wireframe draws 22) and its label 16 sp (15); rows
  that touch by design (the chooser, Settings, the picker) are not given the 8 dp gap check; the Home chip takes the
  room the title leaves and moves under it when even half its width does not fit; the first-open note keeps "Tap to
  identify" on screen at 320 × 640; day names come from `DayLabelWords`, since the domain layer may not import
  `intl`; P6-ACCESSIBILITY-06 is ticked on a widget test of the selected tab's bold label and pill, while the
  greyscale golden review stays with P6-ACCESSIBILITY-04 at the gate.
- **Q15's wordings** ("This ad is played on more than one station.", "These are [client]'s usual contact details.")
  are used as the recommended answers the user accepted on 11 October 2026.
- **`development:show-recognitions`** prints "Chosen by the listener: Station B" and "Decided by: the listener's
  "My station" (Station B)" where the P4 design's piece 3 walkthrough expects "Decided by: the listener's choice" and
  "Decided by: My station"; the walkthrough uses the tool's words.

**Phone walkthrough (b), 13 October 2026** (the user's phone, the real API on port 3100 through the tunnel):
- **Passed:** two stations in window gave the sheet (14:01, `CHOOSE_STATION`, two candidates); Station A chosen with
  "Remember" ticked; the next two identifies (14:43, 14:44) answered `MATCH` by `HINT` with no sheet, so
  **P6-CHOOSER-15 is ticked**. With "My station" cleared, the sheet came back (14:47) and a choice of Station B made
  with signal reached the server at once (204).
- **Skipped by the user:** the choice made in airplane mode (the recognition of 14:52) had not reached the server by
  16:25. The app's code was checked: a phone with no network fails with a socket error, which the outbox reads as
  "no answer" and keeps the item, so the choice was not lost; in this piece it is sent only while Look Up is open in
  front (the retry timer) or when it is reopened, and the app was not reopened. The user chose to skip the rest of
  the check and the History check (Call in airplane mode). Both move into piece 3's walkthrough (b), steps 6 and 7,
  where the network-back event sends the choice without reopening the app; P6-TESTS-07 and P6-HISTORY-02 stay open
  until then.
