# Step 4 — Listener app (basic): design

*Decided 8 October 2026, with the user's answers to the questions in §7. This file decides how the
listener app is built; the build follows it, and a decision that changes during the build is changed
here first.*

**Scope.** The thin slice's last step (approved plan, "Step 4 — Listener app (basic)"): a Flutter app
in `apps/mobile` with which a listener taps Identify, records 8 seconds, sends the clip to
`POST /api/v1/recognize`, and sees the buttons the station attached to that ad (call, WhatsApp, map,
link). Screens: Home, Permission, Listening, Result, No match, Busy and Error, plus the states the
checklist requires that have no wireframe yet (identifying, the advertiser's default card, permission
refused once or for good, and the error variants in §2.10).

**Requirements.** Every `S4-` item in `docs/requirements/checklist-3-listener-app.md` — **235 items** —
is mapped in §5. The "Rules from the ALL part that bind the listener app" at the end of that file
apply, as do `docs/conventions.md` and the error, logging and test rules in the user's CLAUDE.md.

**Sources read.**
- The checklist (how to read it, conflicts 1–19, the whole S4 section, the ALL rules, gaps 1–50).
- The approved plan: Step 4, pinned stack, Recognition flow, Mobile design patterns A–C and E,
  Cross-cutting errors/logging/tests, Verified facts (Flutter), Phases row 6, Open decisions O10.
- The wireframes, read from the claude.ai Design canvas
  (https://claude.ai/artifact/58CSaciWPmduzeYn63TSt8, version 1791426756-16b1): Main, Permission,
  Listening, Result, Chooser, NoMatch, Busy, Offline, Error, History, Settings (360 × 800) and
  Result320 (320 × 720). Their wording below is copied from the boards. The local copies in
  `c:\tmp\lookup-workflows\wireframes\` have the same byte sizes.
- `packages/contracts`: `recognize-schemas.ts`, `listener-install-schemas.ts`,
  `action-card-reader.ts`, `action-uris.ts`, `action-card-schema.ts`, `error-envelope-schema.ts`,
  `client-error-schemas.ts`, `zambian-phone-numbers.ts`, the JSON Schemas in `schemas/` and the
  fixtures in `fixtures/`.
- `docs/design/step-3-engine-hookup.md` (S3-D12 to S3-D23), `apps/api/src/common/errors/error-catalog.ts`,
  `all-exceptions.filter.ts`, `assign-request-id.ts`, the install-token guard, the recognize
  controller, service and multipart reader, `features/client-errors/` and the server's scrubber.
- `spike/capture_app/` (recorder settings, Android set-up), ADR-001, `packages/design-tokens/tokens.json`
  and the portal's token generator, `docs/conventions.md`, `docs/security-baseline.md`.
- The installed Flutter SDK (3.41.9, Dart 3.11.5) and the packages already in the local pub cache,
  read from disk only (no download), to check facts the plan left open (§6, S4-D3, S4-D6).

**What this design settles.** 33 decisions (§6, S4-D1 to S4-D33), each with its reason, and the
user's answers to the five questions only the user could answer (§7). Where a decision answers a
numbered gap in the checklist, the gap is named.

**Facts found while reading that change the work.**
1. The contracts already resolve several checklist gaps: wire names are full words
   (`clip_duration_milliseconds`, `is_deferred`; gap 39), the default card is marked
   `result.kind: CLIENT_DEFAULT` (gap 27), the station's public reference is its id (gap 8), and the
   codec list is `aac` and `opus` (gap 48).
2. The shared map builder still makes a *search* address; the directions form the checklist chose
   (conflict 19) needs the TypeScript builder, its fixtures and three portal tests to change first
   (§3.21, S4-D16).
3. `record` 6.2.1's Android part (`record_android` 1.5.2) has minimum SDK 23 and refuses Opus below
   Android 10, so the plan's "Verified facts" hold for the pinned version (gap 40). The app's minimum
   is SDK 24 all the same, because `url_launcher` and `shared_preferences` need it (S4-D6).
4. Dart's own HTTP client (used by `dio` and by `Image.network`) cannot be relied on to obey
   Android's network-security configuration (Flutter's attempt to make it do so in 1.22 was
   withdrawn), so "cleartext only in the development flavour" must be enforced in Dart; the Android
   settings are a second line (§3.7, S4-D25). The emulator test in §4.7 step 5 proves the Dart
   refusal whatever the platform does.
5. The response contract has no field for the Result card's offer text, so S4-RESULT-08 cannot be
   built in Step 4 (S4-D1).
6. `record`'s `hasPermission()` shows the system prompt itself by default; the app must never call
   it, or the explainer screen would be skipped (§3.16).

---

## 1. The slice at a glance

```
first launch ─► make install id ─► POST /installs (in the background) ─► Home

Home ── "Tap to identify" ──► microphone allowed? ── no ──► Permission ── "Allow microphone" ──► system prompt
                                     │ yes                                                        │ allowed
                                     ▼                                                            ▼
                               Listening (8 s, level ring, countdown, Cancel) ◄───────────────────┘
                                     │ 8 s reached
                                     ▼
                               Identifying ── POST /recognize ──► Result (matched)
                                     ▲                         ├► Result (advertiser's default card)
                                     │ countdown ends          ├► No match
                                     │ or "Try now"            ├► Busy (keeps the clip) ──┘
                                     └─────────────────────────┴► Error (reference code, or a variant)
```

What the listener can do: open the app (it registers itself silently), tap "Tap to identify",
allow the microphone once, hold the phone near the radio for 8 seconds, and see the result card with
the station's buttons. A button opens the dialler, WhatsApp, Google Maps directions or the browser.
Every outcome other than a result is a designed screen with a way back and, where it makes sense, a
way to try again.

The server side is built (Steps 1–3): install tokens, the recognize route with its order of checks,
clock correction, idempotent replays, `503 + Retry-After` admission, the client-error route.

Not in Step 4 (S4-SCOPE-05, S4-D1): bottom navigation, History, Settings, "My station", the station
chooser, offline capture and the outbox, "Report this", data-use figures, the dark theme,
localisation, the full golden matrix. None of them is half-built: no route, provider, table, string
or dead control for them exists.

---

## 2. Screens and states

### 2.1 Rules every screen follows

- **Frame.** `SafeArea`, then a `CustomScrollView` whose last sliver is
  `SliverFillRemaining(hasScrollBody: false)`: the footer sits at the bottom on a tall phone and the
  whole screen scrolls when the text is large. No fixed width or height around text.
- **Header.** One 48 × 48 dp icon button at the top left — a Back arrow or a Close × — with its
  screen-reader label. 8 dp side padding, as drawn.
- **Footer.** Primary action: `FilledButton`, full width, at least 52 dp tall. Secondary action:
  `TextButton`, full width, at least 48 dp. 8 dp between them, 24 dp padding.
- **Design values** come from the generated tokens (§3.18). Where a wireframe value falls between two
  tokens (gaps of 6, 10, 14 or 18 px; 12 px radii), the nearest token is used.
- **Touch.** Every tap target is at least 48 × 48 dp and at least 8 dp from its neighbour; controls
  the wireframes draw 44 px tall are 48 dp (conflict 11).
- **Words.** Text in double quotes is shown exactly; text in [brackets] is filled from data. The app
  never shows exception text, a status line, a file path or the API's `message` (S4-D13).
- **System back** does what the screen's own Back or Close does.
- **Less motion.** When the phone asks for it ("Remove animations", `MediaQuery.disableAnimations`),
  nothing moves: screen changes, the Listening rings, the Identifying bar, and the copy sheet and
  the "copied" snackbars, which appear and go at once (`AnimationStyle.noAnimation`). Otherwise
  the copy sheet slides in over motion.slow and out over motion.base, and the snackbars in and out
  over motion.base, never Material's own durations (S4-ACCESSIBILITY-04).
- **No ads list** anywhere (D8).

### 2.2 Home — state `idle`, route `/`

Wireframe *Main* (360 × 800). Top to bottom:

| Part | Content | Behaviour |
|---|---|---|
| Header | "Look Up" (title token, 24/30, 700) at top left, 20 dp padding | — |
| ~~My station chip~~ | Wireframe: "My station: Station A" at top right | **Not in Step 4** (S4-D1; P6-NAVIGATION-03) |
| Main area | Aligned to the **bottom** of the screen (thumb zone), centred, 24 dp sides, 48 dp bottom, 32 dp between groups | — |
| Heading | "Heard an ad on the radio?" (display token, 30/36, 700) | Marked as a heading |
| Instruction | "Tap the button and hold your phone near the radio while the ad plays." (body, muted) | Serves as the first-open "how it works" note (gap 44) |
| Identify control | Round, 200 dp across at normal text and 200 dp × the text scale at larger text, no wider than the screen less a halo ring on each side, so the label is drawn at the listener's size (it shrinks only when even that widest disc cannot hold it, and never breaks inside a word; S4-RESPONSIVE-03), accent fill; microphone icon (56 dp) above the label "Tap to identify" (18, 700), both in the on-accent colour; two soft concentric halo rings (14 dp and 28 dp wide) | Screen-reader label "Identify the ad playing now", role button. Tap → Listening if the microphone is allowed, else Permission (T1, T2). Ignored while an identify is already under way |
| Data note | "About 8 seconds of listening · about 25 KB of data" (caption, muted), 12 dp above | The "8" comes from the clip-length setting (S4-LISTENING-03); what "25 KB" counts is S4-D31 |
| ~~Bottom navigation~~ | Wireframe: Identify · History · Settings | **Not in Step 4** (S4-D1; P6-NAVIGATION-01) |

Development flavour only, and only with `LOOKUP_SHOW_DEVELOPER_TOOLS=true`: a text button
"Send a test error" at the top right that throws on purpose (the debug-throw check, P6-TESTS-13 run
first at the S4 gate). It never exists in staging or production builds (S4-D26).

### 2.3 Permission — state `permissionNeeded`, route `/permission`

Wireframe *Permission*. Shown only after an Identify tap while the microphone is not allowed. The
system prompt appears only after "Allow microphone" (S4-PERMISSION-02).

| Part | Content | Behaviour |
|---|---|---|
| Header | Back arrow, label "Back" | → Home; no permission request |
| Icon | 88 dp circle, accent-soft fill, microphone icon (40 dp, accent) | Decorative |
| Heading | "Look Up needs your microphone" (headline token, 28/34) | Heading |
| Body | "We listen for a few seconds to recognise the ad on the radio. We don't keep the recording." | — |
| List, item 1 | Green tick + "Only when you tap Identify — never in the background." | Tick hidden from screen readers |
| ~~List, item 2~~ | Wireframe: "No signal? The clip waits on your phone and is deleted once it's sent — never kept longer than 24 hours." | **Not in Step 4**: offline capture does not exist yet, so the promise would be false (S4-D1; P6-PERMISSION-01; gap 3) |
| List, item 3 | Green tick + "Radio stations see how many people used their buttons — never who you are." | Tick hidden from screen readers |
| Primary | "Allow microphone" | Asks the system (T3–T5) |
| Secondary | "Not now" | → Home; no request |
| Footer line | "Said no before? Open phone settings" — "Open phone settings" is a 48 dp text button | Opens the app's page in the phone's settings (T6) |

Three variants (S4-D22; gap 31). Each is the same screen with these differences:

| Variant | When | Differences |
|---|---|---|
| Not asked yet | The app has never shown the system prompt | None (as drawn) |
| Refused once | The listener chose "Don't allow" in the system prompt | Above the buttons, in ink: "You chose not to allow the microphone. Look Up can't identify an ad without it." "Allow microphone" asks again |
| Refused for good | The system will not ask again (permanently denied, or restricted) | Above the buttons: "The microphone is turned off for Look Up. You can turn it on in your phone's settings." The primary button reads "Open phone settings"; the "Said no before?" line is hidden (it would repeat the button). "Not now" stays |

Returning from the phone's settings with the microphone now allowed goes to **Home**; nothing is
recorded until the next tap (T7). Returning without it keeps the screen.

### 2.4 Listening — state `recording`, route `/listening`

Wireframe *Listening*.

| Part | Content | Behaviour |
|---|---|---|
| Header | Close ×, label "Cancel listening" | Stops the recorder, deletes the partial clip, sends nothing → Home (T12) |
| Ring | Round accent disc, 164 dp, microphone icon (52 dp), inside three soft halo rings (18, 38 and 60 dp wide) | Decorative and **not tappable** (the wireframe's tap-to-finish is a prototype shortcut; gap 30, S4-D1). The rings scale with the live level: scale = 1 + 0.15 × level, transform only, 150 ms (motion.fast), no animation when `MediaQuery.disableAnimations` is set |
| Heading | "Listening…" (headline) | Live region (status), 36 dp below the ring |
| Text | "Keep your phone near the radio" | — |
| Level bars | 16 bars, 6 dp wide, 4 dp apart, fixed heights 10, 18, 26, 14, 32, 42, 22, 30, 46, 36, 20, 28, 16, 24, 12, 8 dp in a 48 dp row. The first round(level × 16) bars are accent, the rest line colour | Hidden from screen readers |
| Progress | 220 dp wide (less if the screen is narrower), 6 dp track (line-soft), accent fill; fraction = seconds passed ÷ 8 (0.625 with 3 seconds left) | — |
| Countdown | "[n] seconds left": "8 seconds left", then one less each second; "1 second left" (singular); "0 seconds left" for the instant the file is finished | — |
| Footer | "Cancel" (outlined: surface fill, line border, 52 dp) | As Close (T12) |

After 8 seconds the app moves on by itself (T11). Leaving the app, a phone call or another app
taking the microphone cancels the listening (T13). A recorder that cannot start or finish leads to
Error, phone failure (T14).

### 2.5 Identifying — state `uploading`, route `/identifying` (no wireframe)

Proposed (S4-D28): the Listening layout with the ring still and no level bars; heading
"Identifying…" (live region); text "This usually takes a few seconds."; an indeterminate progress bar
(still when animations are off); footer "Cancel" → aborts the request, deletes the clip, Home (T28).
The ring stays exactly where Listening had it, so nothing jumps when the clip is sent: both screens
use one layout (`ListeningLayout`), Identifying keeps the rows of the level bars and the countdown
empty, and each screen's heading and line of text keep the room the other screen's words would take
there (laid out, never drawn or read out).
It covers getting an install token when one is needed, the send, and the silent resends after a 409
or a 401 (T15, T22, T23). The slow-upload "still working" state is Phase 6 (P6-LISTENING-01).

### 2.6 Result — state `matched`, route `/result`

Wireframes *Result* (360 × 800) and *Result320* (320 × 720).

| Part | Content | Behaviour |
|---|---|---|
| Header | Back arrow (label "Back to home") + "Found it" (16, 700) | → Home (T35). "Found it" is read as a heading and announced as the screen appears (a live region with the status role, as the state headings of §2.4–§2.10), because the result arrives without a tap |
| Card | Surface fill, line-soft border, radius 16 (lg), clipped | — |
| Banner box | Only when the card has `header_image`: card width × half the card width (2:1), line-soft fill while loading and if loading fails; image fills the box (cover), decoded at box width × device pixel ratio (`cacheWidth`), or at box height (`cacheHeight`) when the answer's `width_pixels`/`height_pixels` say it is wider than 2:1, so it still covers the box sharply; `https` addresses only, at every hop: the image loader turns the HTTP client's own redirects off and follows one only to another `https` address (at most 5) | Nothing moves when the image arrives. No box at all when there is no banner (S4-D20). The wireframe placeholder "[Ad image · 2:1]" is never shown |
| Client row | Round logo, 40 dp (36 dp below 360 dp): the client's logo if the answer has one, else the first letter of the client's name, upper case, in the surface colour (white) on ink. Beside it: client name (16, 700) and "via [station name] · [frequency label]" (13, muted), e.g. "Brand A" / "via Station A · 98.1 FM" | Logo hidden from screen readers; the name is read |
| Title | The ad title (cardTitle token 22/28; cardTitleCompact 20/26 below 360 dp) | Marked as the main heading |
| ~~Offer text~~ | Wireframe: "[Short offer text written by the station — two lines at most.]" | **Not in Step 4**: the answer has no field for it (S4-D1; gap 6) |
| Card notes | Only when they apply: update hint "Some buttons need a newer version of Look Up." (reader rule R7/R8); a card with no usable button: "This ad has no buttons right now." | A statement, not an instruction (S4-USABILITY-02; no update control exists before a store listing) |
| Buttons | 16 dp below the card; one per shown action, **in card order**; full width; at least 52 dp tall; 8 dp apart. Each: type icon (20 dp) + label. Below 360 dp wide the icons are dropped, as Result320 draws | Styles: `PRIMARY` → `FilledButton` (accent / on-accent); `SECONDARY` → `FilledButton.tonal` (accent-soft / accent-hover); `OUTLINE` → `OutlinedButton` (surface, line border, ink). Icons: phone (call), speech bubble (WhatsApp), map pin (map), globe (link) |
| Labels | Exactly as the station wrote them, e.g. "Call Brand A", "Chat on WhatsApp", "Get directions", "Visit website" | A label over 32 code points shows its first 31 and "…"; screen readers get the full label (S4-D20) |
| More options | Only when 5 or 6 actions are usable: a full-width text button "More options" with a chevron, under the fourth button | Shows the rest below it, in card order, and disappears (S4-D18) |
| ~~Footer~~ | Wireframe: "Saved to History" and "Report this" | **Not in Step 4** (S4-D1; History and "Report this" are Phase 6) |

Entering the screen gives one haptic tick (S4-LISTENING-14).

**Tapping a button.** The app builds the address itself (§3.14) and opens it with
`launchUrl(…, mode: LaunchMode.externalApplication)`. If the phone cannot open it, a bottom sheet
appears (S4-D19; no wireframe, gap 15):

| Action | Sheet |
|---|---|
| Call or WhatsApp | Heading "Couldn't open this"; text "Your phone couldn't open it. You can copy the number instead."; the number in the +260 display form, e.g. "+260 97 712 3456"; primary "Copy number" (copies the E.164 form `+260977123456`, then a snackbar "Number copied"); secondary "Close" |
| Map or link | Heading "Couldn't open this"; text "Your phone couldn't open it. You can copy the link instead."; primary "Copy link" (copies the built address, then "Link copied"); secondary "Close" |

**At 320 dp** (Result320): the same order — banner, client row, title, buttons — with 12 dp side
padding, 12 dp gaps, 12 dp card padding, the 36 dp logo, the smaller title and no button icons. Four
buttons fit without sideways scrolling; with large text the screen scrolls.

### 2.7 Result, advertiser's default card — state `fallback`, route `/result` (no wireframe)

The Result layout with one addition under the title (muted text): "This ad isn't on air right now,
so these are [client name]'s usual contact details." Same buttons, same haptic tick (S4-D21; gaps 27
and 29).

### 2.8 No match — state `noMatch`, route `/no-match`

Wireframe *NoMatch*.

| Part | Content | Behaviour |
|---|---|---|
| Header | Close ×, label "Close" | → Home |
| Icon | 88 dp circle, line-soft fill, magnifying glass (muted) | Decorative |
| Heading | "We couldn't recognise that" | Live region (status) |
| Body | "It may not be an ad we know yet, or it was too noisy to hear clearly." | — |
| Panel | Surface, border, radius 16, 16 dp padding. Heading "Try this" (15, 700), then an ordered list with numbered badges (24 dp accent-soft circles, accent-hover digits): 1 "Turn the radio up, or move your phone closer." 2 "Tap while the ad is playing — not during music or talk." 3 "Step away from traffic or other noise if you can." | List and list-item semantics; the drawn numbers hidden |
| Primary | "Try again" | A new listening (permission checked first; T36) |
| Secondary | "Back to home" | → Home |

### 2.9 Busy — state `busy`, route `/busy`

Wireframe *Busy*.

| Part | Content | Behaviour |
|---|---|---|
| Header | Close ×, label "Close" | Stops the retry, deletes the kept clip → Home (T33) |
| Icon | 88 dp circle, warning-soft fill, refresh icon (warning) | Decorative |
| Heading | "Lots of people are listening right now" | Live region (status) |
| Body | "We kept your clip and will try again automatically. You don't need to record again." | True while the app runs (S4-D7) |
| Panel | Polite live region. "Trying again in" (15, 600) beside the countdown "[n] s" (display token, tabular figures), e.g. "12 s"; under it a progress bar (warning fill on line-soft) showing how much of the wait has passed | Starts from `Retry-After`; at 0 the same clip is sent again (T30) |
| Primary | "Try now" | Sends at once and stops the countdown (T32) |
| Secondary | "Cancel" | As Close |

The countdown pauses while the app is in the background (S4-D23). After the fourth send of one clip
is still answered "busy", the app stops and shows Error (S4-D11).

### 2.10 Error — state `error`, route `/error`

Wireframe *Error* for the server and phone failures; the other variants reuse its layout (S4-D28;
gap 10). Common parts: Close × (label "Close") → Home, deleting any kept clip; an 88 dp icon circle;
heading; body; an optional reference-code panel; footer.

| Variant (failure) | When (§3.11) | Icon | Heading (role) | Body | Code panel | Primary / secondary |
|---|---|---|---|---|---|---|
| **Server failure** | 5xx, an unreadable answer, a 4xx caused by the app | Warning triangle, danger on danger-soft | "Something went wrong on our side" (alert) | "Please try again. If it keeps happening, share this code with support so we can find the problem." | Yes | "Try again" (new listening) / "Back to home" |
| **Phone failure** | Something failed on the phone (recorder, file, an unexpected exception in the flow) | As above | As above | Same as server failure once the report was accepted; before that, or if it was not: "Please try again." | Only after the API accepted the crash report | As above |
| **Recording unusable** | 400 `INVALID_AUDIO` | Microphone-off icon, ink on line-soft | "We couldn't use that recording" (status) | "Please try again, with your phone close to the radio." | Yes | "Try again" / "Back to home" |
| **No connection** | No answer at all (no network, timeout, connection dropped) | Signal-off icon, ink on line-soft | "No connection" (status) | "We couldn't reach Look Up. We kept your clip, so you can send it again when you have signal." | No | "Send again" (the same clip; T37) / "Back to home" |
| **Too many tries** | 429 `RATE_LIMITED` | Clock icon, warning on warning-soft | "Too many tries" (status) | `Retry-After` ≤ 60 s: "You've identified a lot in a short time. Please wait a minute, then try again." Otherwise: "Please try again later." | No | "Back to home" |
| **Newer app needed** | `CHOOSE_STATION`, a status the app doesn't know, or 426 | Info icon, accent on accent-soft | "This needs a newer Look Up" (status) | For `CHOOSE_STATION`: "This ad is on more than one station, and this version of the app can't show that yet." Otherwise: "We found an answer this version of the app can't show yet." | No | "Back to home" |

**Support** (S4-D32): when the build has a support WhatsApp number, the server-failure, phone-failure
and recording-unusable variants show a secondary link under the code panel, "Message support on
WhatsApp", which opens a chat with "Hello Look Up support, my reference code is 6F1C-2D3E." filled
in. Staging and production builds always have the number: without it they refuse to start (§3.7),
so the body's "share this code with support" is never shown with no way to reach support. Only a
development build may lack it; there the link is not shown, and the code with "Copy" stands alone.

**Reference-code panel** (wireframe): surface, border, radius 16; label "Reference code" (12, 600,
muted); the code in the system monospace font (18, 700, letter spacing 1), e.g. "6F1C-2D3E"; a "Copy"
button (48 dp) that copies the displayed code, then a snackbar "Code copied". How the code is made,
and when it may be shown, is S4-D9.

Development flavour with `LOOKUP_SHOW_ERROR_DETAILS=true` only: an expandable "Details (development
only)" section under the panel shows the failure's type and text. Never in staging or production
(S4-ERRORHANDLING-08).

### 2.11 Outside the flow

- **A widget that fails to build** (`ErrorWidget.builder`): a small plain box reading "This part
  couldn't be shown." in place of Flutter's red screen, in every build. The development flavour with
  the details flag shows the error text instead. The error is reported once (§3.19).
- **A build that is set up wrongly** (no or malformed API address, `http` outside the development
  flavour, no support number in a staging or production build, a Gradle flavour that disagrees with
  the defined one; §3.7): one full screen, "This copy of
  Look Up isn't set up correctly." No request is made and nothing is reported (there is nowhere
  safe to send it). This only happens to a mis-built app, never to a listener's correct install.

### 2.12 The state machine

Nine top-level states (S4-STATE-03): `idle`, `permissionNeeded`, `recording`, `uploading`, `matched`,
`fallback`, `noMatch`, `busy`, `error`. The error state carries one of six failures (§2.10, §3.4).

| # | From | Event | Condition | To | What the app does |
|---|---|---|---|---|---|
| T1 | idle | "Tap to identify" | microphone allowed | recording(level 0, 8 s left) | makes the idempotency key and the capture time, opens the microphone |
| T2 | idle | "Tap to identify" | not allowed | permissionNeeded(not asked yet / refused once / refused for good) | reads the status only; no system prompt |
| T3 | permissionNeeded (not for good) | "Allow microphone" | system prompt → allowed | recording | as T1 |
| T4 | permissionNeeded (not for good) | "Allow microphone" | → refused | permissionNeeded(refused once) | — |
| T5 | permissionNeeded (not for good) | "Allow microphone" | → refused for good | permissionNeeded(refused for good) | — |
| T6 | permissionNeeded | "Open phone settings" (link, or the primary button when refused for good) | — | unchanged | opens the app's page in the phone's settings |
| T7 | permissionNeeded | app back in the foreground | now allowed | idle | nothing is recorded until the next tap |
| T8 | permissionNeeded | Back, "Not now", system back | — | idle | no request |
| T9 | recording | level sample (every 100 ms) | — | recording(new level, same seconds) | — |
| T10 | recording | one second passes | seconds left > 0 | recording(level, seconds − 1) | — |
| T11 | recording | 8 seconds reached | — | recording(level, 0), then uploading | stops the recorder, reads the clip into memory, deletes the file, sends |
| T12 | recording | Close ×, "Cancel", system back | — | idle | cancels the recorder (file deleted); sends nothing |
| T13 | recording | app hidden or paused; recorder paused by a call or another app | — | idle | as T12 |
| T14 | recording | recorder cannot start or finish, reports an error, or stops on its own before the clip ends; clip file missing or empty | — | error(phone failure), at once | reports it (§3.19); recording cancelled, file deleted, nothing sent |
| T15 | uploading | — | no usable install token | uploading | registers first (§3.9) |
| T16 | uploading | 200 `MATCH`, kind `CAMPAIGN` (or a kind the app doesn't know) | — | matched | deletes the clip; one haptic tick |
| T17 | uploading | 200 `MATCH`, kind `CLIENT_DEFAULT` | — | fallback | deletes the clip; one haptic tick |
| T18 | uploading | 200 `NO_MATCH` | — | noMatch | deletes the clip |
| T19 | uploading | 200 `CHOOSE_STATION` or an unknown status; 426 | — | error(newer app needed) | deletes the clip |
| T20 | uploading | 502, 503 (any code) or 504 | sends of this clip < 4 | busy(delay, delay) | keeps the clip |
| T21 | uploading | 502, 503 or 504 | the 4th send | error(server failure; phone failure if the answer carried no API id) | deletes the clip |
| T22 | uploading | 409 `RECOGNITION_IN_PROGRESS` | waits for this clip < 2 | uploading | waits `Retry-After`, sends the same clip and key again |
| T23 | uploading | 401 `INSTALL_TOKEN_INVALID` | first 401 for this clip | uploading | registers again (same install id), sends again |
| T24 | uploading | 429 `RATE_LIMITED` | — | error(too many tries) | deletes the clip |
| T25 | uploading | 400 `INVALID_AUDIO` | — | error(recording unusable) | deletes the clip; reports it |
| T26 | uploading | any other 4xx or 5xx; a 409 or 401 past its limit; a 200 the app cannot read | — | error(server failure) | deletes the clip; reports app-side causes (§3.11) |
| T27 | uploading | no answer from the network (no connection, timeout, dropped); a request the phone itself stopped (a fault in the app, or plain http outside development) is a reported phone failure instead, and drops the clip (§3.11) | — | error(no connection) | keeps the clip |
| T28 | uploading | "Cancel", system back | — | idle | cancels the request; deletes the clip |
| T29 | busy | one second passes | in the foreground, seconds > 1 | busy(delay, seconds − 1) | — |
| T30 | busy | countdown reaches 0 | in the foreground | uploading | sends the same clip and key (new request id, new send time) |
| T31 | busy | app hidden | — | busy, paused | resumes counting on return |
| T32 | busy | "Try now" | — | uploading | stops the countdown; sends now |
| T33 | busy | Close ×, "Cancel", system back | — | idle | stops the countdown; deletes the clip |
| T34 | matched / fallback | an action button | — | unchanged | opens its address; on failure, the copy sheet |
| T35 | matched / fallback | Back, system back | — | idle | — |
| T36 | noMatch; error(server, phone, recording unusable) | "Try again" | — | as T1 or T2 | a new capture with a new key |
| T37 | error(no connection) | "Send again" | — | uploading | the kept clip, same key |
| T38 | noMatch; error(any) | Close ×, "Back to home", system back | — | idle | deletes any kept clip |
| T39 | error(phone failure, report sending) | the report is answered | accepted / not | error(phone failure, accepted / not accepted) | the code appears only when accepted |
| T40 | error | "Copy" | — | unchanged | copies the code; "Code copied" |
| T41 | any state but idle | another identify request (double tap) | — | unchanged | ignored (one identify at a time) |

Rules the table relies on: only `idle` accepts a new identify (T41); the clip is held privately by
the flow and is never part of a state; the clip leaves memory on T12, T13, T16–T19, T21, T24–T26,
T28, T33 and T38; navigation always follows the state (§3.6); every row has a unit test
(S4-TESTS-02).

---

## 3. Architecture

### 3.1 Folders

Created with `flutter create --org zm.lookup --project-name lookup_listener --platforms android,ios apps/mobile`
(templates ship with the SDK; no download), then edited. Each Dart file is named after its one main
type (S4-NAMING-04); every name is in full words (S4-NAMING-01 to -05).

```
apps/mobile/
  pubspec.yaml, pubspec.lock, analysis_options.yaml
  config/                         --dart-define-from-file inputs (no secrets)
    development.json              emulator → local API   (http://10.0.2.2:3100/api/v1)
    development-fake.json         emulator → fake API    (http://10.0.2.2:3999/api/v1)
    development-phone.example.json  phone → PC over Wi-Fi (copied to development-phone.json, git-ignored)
    staging.json, production.json https placeholders on .invalid hosts until deployment (P8)
  lib/
    main.dart                     calls bootstrap()
    app/
      bootstrap.dart              configuration check, global error handlers, ProviderScope, runApp
      look_up_app.dart            LookUpApp: MaterialApp.router, theme
      app_router.dart             AppRouter: GoRouter, routes, redirect from the recognition state
      app_route.dart              AppRoute: one value per route, with its path
    core/                         shared by both features; not a feature
      configuration/  app_configuration.dart (AppConfiguration, AppFlavour), app_version.dart
      network/        api_client.dart (ApiClient), api_answer.dart (ApiAnswer), retry_after.dart (RetryAfter)
      identifiers/    random_uuid.dart (RandomUuid), reference_code.dart (ReferenceCode)
      time/           clock.dart (Clock)
      listener_install/
                      listener_install_credentials.dart, listener_install_store.dart,
                      listener_install_repository.dart, listener_install_registration.dart
      error_reporting/
                      client_error_reporter.dart, global_error_handlers.dart,
                      isolate_error_listener.dart, personal_data_scrubber.dart, development_log.dart
      theme/          look_up_tokens.dart (GENERATED from tokens.json), look_up_theme.dart
      widgets/        screen_frame.dart, state_icon_circle.dart, plain_error_fallback.dart,
                      set_up_problem_screen.dart
    features/
      identify/
        presentation/ recognition_flow.dart (RecognitionFlow), home_screen.dart, permission_screen.dart,
                      listening_screen.dart, identifying_screen.dart, listening_layout.dart,
                      no_match_screen.dart, busy_screen.dart, error_screen.dart, level_ring.dart,
                      level_bars.dart, reference_code_panel.dart
        domain/       recognition_state.dart, recognition_failure.dart, captured_clip.dart,
                      clip_settings.dart, microphone_access.dart, recognition_answer.dart,
                      recognition_outcome.dart, send_policy.dart
        data/         recognition_repository.dart, recognize_request_builder.dart,
                      recognize_response_parser.dart, clip_recorder.dart, microphone_permission.dart
      result/
        presentation/ result_screen.dart, action_registry.dart, action_button.dart,
                      action_button_list.dart, more_options_button.dart, launch_failure_sheet.dart,
                      client_logo.dart, banner_box.dart
        domain/       recognition_result.dart, ui_action.dart, read_action_card.dart,
                      action_card_reader.dart, action_uri_builder.dart, canonical_https_link.dart,
                      phone_number_display.dart
        data/         action_launcher.dart, clipboard_writer.dart, https_image_provider.dart
  android/  ios/                  one codebase, both platform projects (S4-STRUCTURE-08)
  test/                           mirrors lib/; support/ (fakes, fixture loader, schema checker);
                                  structure/ (import, folder and source scans)
  tool/                           generate_design_tokens.dart, fake_listener_api.py,
                                  test_fake_listener_api.py, check_received_clip.py,
                                  run_emulator_tests.py
```

`identify` and `result` are the only features in Step 4 (S4-STRUCTURE-04); each has exactly
`presentation`, `domain` and `data` (S4-STRUCTURE-02). Phase 6 adds `history` and `settings`.

### 3.2 Layer rules (S4-D2)

Calls flow presentation → domain → data, as the plan says. Imports are pinned down so the rule can
be checked by a test (S4-STRUCTURE-03):

| Layer | Holds | May import | Must not import |
|---|---|---|---|
| `presentation` | widgets, the `RecognitionFlow` notifier, `ActionRegistry` | Flutter, Riverpod, go_router, its feature's `domain`, the *repository* and *provider* files of a feature's `data`, `core/` | `package:dio`, `package:shared_preferences`, `package:record`, `package:permission_handler`, `package:url_launcher`, `package:path_provider`, `dart:io`, any other `data/` file |
| `domain` | entities, sealed classes, pure rules (state mapping, card reader, address builders) | `dart:core`, `dart:convert`, `dart:math`, `package:meta`, another feature's `domain` | Flutter widgets, any package above, `data/`, `presentation/` |
| `data` | repositories, the recognize request builder and response parser, the recorder, permission and launcher adapters | packages above, `dart:io`, `domain/`, `core/` | `presentation/` |

No one-class-per-use-case layer and no BLoC (ALL rules). `identify/data` reads cards through
`result/domain` (the answer carries the card), the only cross-feature import.

### 3.3 Dependencies (S4-D3)

```yaml
environment:
  sdk: ^3.11.5
  flutter: ">=3.41.0"          # admits the installed 3.41.9; no global upgrade (S4-STACK-01)
dependencies:
  flutter: { sdk: flutter }
  flutter_riverpod: 3.3.2      # exact pins (S4-STACK-02 … -08)
  go_router: 17.5.0
  dio: 5.11.1
  record: 6.2.1
  url_launcher: 6.3.3
  permission_handler: 12.0.3   # not the plan's 13.0.2, which cannot build on Flutter 3.41.9 (S4-D33)
  shared_preferences: 2.5.5
  path_provider: 2.1.6         # the one addition: record needs a file path; already in the pub cache
dev_dependencies:
  flutter_test: { sdk: flutter }
  flutter_lints: 6.0.0         # already in the pub cache
  fake_async: 1.3.3            # the version flutter_test already pins; already in the pub cache
```

- No code generation (no `freezed`, `json_serializable`, `riverpod_generator`, `build_runner`):
  sealed classes, providers and parsers are written by hand, which also keeps downloads down.
- No `uuid` package: a 20-line version-4 generator on `Random.secure()` (`RandomUuid`), tested
  against the API's UUID pattern (as the API wrote its own UUIDv7 generator, S3-D22).
- No font files, image cache, secure-storage, connectivity or Play-services plugin.
- Download before the first `flutter pub get`: `flutter_riverpod`, `go_router`, `dio`,
  `permission_handler` and `url_launcher` 6.3.3 with their platform parts are not in the pub cache
  (the user approved these on 8 October 2026): about 22 MB of package archives (riverpod's alone is
  15.7 MB), plus an estimated 3–6 MB of AndroidX libraries on the first Android build. No new Gradle,
  Android Gradle Plugin, Kotlin, NDK, SDK platform or Flutter engine is needed (S4-D33). `record`, `shared_preferences`, `path_provider`, `flutter_lints` and
  `crypto`/`http_parser` are already cached.
- `flutter pub get` must succeed on 3.41.9 with no override (S4-STACK-09).

### 3.4 The recognition state

```dart
// features/identify/domain/recognition_state.dart — every subclass lives in this one library.
sealed class RecognitionState { const RecognitionState(); }
final class IdleState extends RecognitionState { const IdleState(); }
final class PermissionNeededState extends RecognitionState { final MicrophoneAccess microphoneAccess; … }
final class RecordingState extends RecognitionState { final double levelFraction; final int secondsLeft; … }
final class UploadingState extends RecognitionState { const UploadingState(); }
final class MatchedState extends RecognitionState { final RecognitionResult result; … }
final class FallbackState extends RecognitionState { final RecognitionResult result; … }
final class NoMatchState extends RecognitionState { const NoMatchState(); }
final class BusyState extends RecognitionState { final int retryDelaySeconds; final int secondsUntilRetry; … }
final class ErrorState extends RecognitionState { final RecognitionFailure failure; … }

enum MicrophoneAccess { notAskedYet, refusedOnce, refusedForGood }

// features/identify/domain/recognition_failure.dart
sealed class RecognitionFailure { const RecognitionFailure(); }
final class ServerFailure extends RecognitionFailure { final String requestId; … }
final class PhoneFailure extends RecognitionFailure { final String reportRequestId; final ReportDelivery reportDelivery; … }
enum ReportDelivery { sending, accepted, notAccepted }
final class RecordingUnusableFailure extends RecognitionFailure { final String requestId; … }
final class ConnectionFailure extends RecognitionFailure { const ConnectionFailure(); }
final class TooManyTriesFailure extends RecognitionFailure { final bool isShortWait; … }
final class NewerAppNeededFailure extends RecognitionFailure { final bool isSeveralStations; … }
```

- Each state carries only its own data and every field is non-null (S4-STATE-07): only `matched` and
  `fallback` hold a result, only `busy` a retry delay, only `error` a failure (and through it a
  request id), only `recording` a level. Units are in the names (`retryDelaySeconds`,
  `secondsUntilRetry`; S4-NAMING-02); yes/no fields read as questions (`isShortWait`; S4-NAMING-03).
- Every screen selector is an exhaustive `switch` over these types with no default branch
  (S4-STATE-09), so a new state or failure cannot compile without its screen.
- `CapturedClip` (domain) — bytes, idempotency key, capture time, clip length in milliseconds,
  codec — is held privately by `RecognitionFlow`, never inside a state.
- `ClipSettings` (domain) is the one place for the clip: length 8,000 ms, codec `aac`, 16,000 Hz,
  one channel, 24,000 bit/s (S4-LISTENING-03). The countdown, the recording duration, the field
  sent and the Home note all read it.
- `SendPolicy` (domain): at most 4 sends of one clip for busy answers, at most 2 waits after 409, at
  most 1 re-registration after 401, `Retry-After` limits (S4-D11).

### 3.5 Providers (Riverpod 3.3.2)

| Provider | Kind | Holds | Overridden in tests |
|---|---|---|---|
| `appConfigurationProvider` | `Provider<AppConfiguration>` | flavour, API address, development flags | yes (production or development) |
| `apiClientProvider` | `Provider<ApiClient>` | the one Dio-backed client (built in `bootstrap`, also used by the reporter) | yes (fake adapter) |
| `clockProvider` | `Provider<Clock>` | wall-clock time and timers | yes (fake clock) |
| `randomUuidProvider` | `Provider<RandomUuid>` | UUID source | yes (fixed ids) |
| `listenerInstallRepositoryProvider` | `Provider<ListenerInstallRepository>` | install id, token, and the one registration in progress (`ensureRegistered`, `registerAgainAfterRefusal`) | yes |
| `clientErrorReporterProvider` | `Provider<ClientErrorReporter>` | crash reports | yes (recording fake) |
| `recognitionRepositoryProvider` | `Provider<RecognitionRepository>` | `POST /recognize` | yes |
| `clipRecorderProvider` | `Provider<ClipRecorder>` | the microphone | yes (fake levels and bytes) |
| `microphonePermissionProvider` | `Provider<MicrophonePermission>` | permission status and request | yes |
| `actionLauncherProvider`, `clipboardWriterProvider` | `Provider` | opening addresses, copying | yes |
| `recognitionFlowProvider` | `NotifierProvider<RecognitionFlow, RecognitionState>`, kept alive | the state machine | — (it is what is tested) |
| `appRouterProvider` | `Provider<GoRouter>` | routes and the redirect | — |

- `RecognitionFlow` is a `Notifier` over the sealed state, not an `AsyncNotifier`: the sealed state
  already models waiting and failure, and `AsyncValue` would add a second, conflicting channel
  (S4-STATE-01 allows either; S4-D4).
- **Registration is not a provider of its own.** It is built inside `ListenerInstallRepository`,
  behind the plain `listenerInstallRepositoryProvider`: the repository keeps the one registration
  in progress as a `Future` that every concurrent caller shares (the background registration after
  the first frame, a fast first tap, two 401s), so the install never registers twice at once
  (§3.9, S4-D14). No screen shows registration state, so there is nothing for an `AsyncNotifier`'s
  `AsyncValue` to drive; a failed registration reaches the listener through the identify that
  needed it, as that identify's failure (§3.11). An `AsyncNotifier` was planned here and dropped for
  this reason (S4-D4).
- **Riverpod 3 retries a failing provider automatically by default.** That would resend clips and
  registrations silently, so `ProviderScope(retry: (retryCount, error) => null)` turns it off for
  the whole app (S4-D4). After every `await`, the notifier checks `ref.mounted` before setting state.
- Tests replace dependencies only through `ProviderScope`/`ProviderContainer` overrides; `lib/` has
  no test-only branches (S4-TESTS-01).

### 3.6 Routes (go_router 17.5.0)

| Route | Path | Screen | Shown for |
|---|---|---|---|
| `AppRoute.home` | `/` | Home | idle |
| `AppRoute.permission` | `/permission` | Permission | permissionNeeded |
| `AppRoute.listening` | `/listening` | Listening | recording |
| `AppRoute.identifying` | `/identifying` | Identifying | uploading |
| `AppRoute.result` | `/result` | Result | matched, fallback |
| `AppRoute.noMatch` | `/no-match` | No match | noMatch |
| `AppRoute.busy` | `/busy` | Busy | busy |
| `AppRoute.error` | `/error` | Error | error |

- **Navigation follows the state** (S4-D5): the router's `redirect` maps the current
  `RecognitionState` to its route with an exhaustive switch (`routeForState`) and a
  `refreshListenable` fed by `ref.listen(recognitionFlowProvider)`. Screens never call
  `context.go`; their buttons call the notifier, and the route follows. A location that does not
  match the state (an unknown path, a stale `/result`) is sent to the state's route; go_router's
  error page is replaced by a redirect to `/`.
- Every move uses `go` (replace), so the stack is flat and Back always leads Home.
- System back is handled per screen with `PopScope(canPop: false, onPopInvokedWithResult: …)`,
  calling the same notifier method as the screen's Back or Close.
- Page transitions: a fade lasting motion.base (200 ms), none when animations are off.
- No route lists or browses ads (S4-SCOPE-06); P6 adds `/r/<recognition_id>`.

### 3.7 Configuration and flavours (S4-D25)

- **Three Android product flavours** in `android/app/build.gradle.kts` — `development`, `staging`,
  `production` — with application ids `zm.lookup.listener.development`, `zm.lookup.listener.staging`
  and `zm.lookup.listener`, and labels "Look Up (dev)", "Look Up (staging)", "Look Up". The flavour's
  Dart settings come from `--dart-define-from-file=config/<file>.json`:

  | Define | Meaning |
  |---|---|
  | `LOOKUP_FLAVOUR` | `development`, `staging` or `production` |
  | `LOOKUP_API_BASE_URL` | the API address, ending `/api/v1` |
  | `LOOKUP_SHOW_ERROR_DETAILS` | development only: error details on screen |
  | `LOOKUP_SHOW_DEVELOPER_TOOLS` | development only: the "Send a test error" control |
  | `LOOKUP_VERBOSE_LOGS` | development only: request lines in the device log (§3.19) |
  | `LOOKUP_SUPPORT_WHATSAPP_NUMBER` | the support WhatsApp number in E.164 (S4-D32): required in staging and production, optional in development; checked at start-up like the address |

  Example: `flutter run --flavor development --dart-define-from-file=config/development-fake.json`.
- **Fails closed** (`AppConfiguration.fromEnvironment`): the app refuses to start (the screen in
  §2.11) when the address is missing or malformed, when it is not `https` outside the development
  flavour, when a development-only flag is set outside development, when a staging or production
  build has no support number (the Error screen asks the listener to share a code with support, so
  a build for listeners must say how to reach support, as it must say where the API is), when the
  number is not E.164, or when Flutter's `appFlavor` (the Gradle flavour) differs from
  `LOOKUP_FLAVOUR`. iOS has no flavours in the MVP, so there only the define is used.
- **The staging and production files are placeholders until deployment (P8).** `config/staging.json`
  and `config/production.json` hold `https` addresses on `.invalid` hosts and an empty
  `LOOKUP_SUPPORT_WHATSAPP_NUMBER`, so a build made from them shows the set-up screen instead of
  starting; deployment fills in the real address and the support number (asked for at the gate,
  Q1). JSON has no comments, so this paragraph is where that is written. The emulator run's
  production APK (§4.7 step 5) is given a valid support number, so the only thing wrong with it is
  its `http` address.
- **Cleartext only in development.** Dart's HTTP client cannot be relied on to obey Android's
  network-security configuration, so the rule is enforced in Dart first: `ApiClient` refuses any
  request whose address is not `https` unless the flavour is development, and images are loaded only
  from `https` addresses, at every hop: `HttpsImageProvider` (in `result/data`) turns the HTTP
  client's own redirects off and follows a redirect itself only to another `https` address, where
  `Image.network` would follow one to plain `http`. The Android settings are the second line: the main manifest sets
  `usesCleartextTraffic="false"` (Android 6, which has no network-security configuration) and a
  network-security configuration with cleartext off and system certificate authorities only (no
  user-installed ones); the `development` source set overrides both to allow cleartext, so the
  emulator can reach `10.0.2.2` and a phone can reach the PC.
- No API address literal in `lib/` (S4-STRUCTURE-07); the only `https://` literals are the two
  button-address prefixes in `action_uri_builder.dart`, which the scan allows by name.
- No secret is in the source or the config files (S4-SECURITY-01); the install token is obtained at
  run time.

### 3.8 The API client (dio 5.11.1)

- **Base address** from `LOOKUP_API_BASE_URL`; paths are relative (`installs`, `recognize`,
  `client-errors`).
- **Every request** carries `X-Request-Id`: a new version-4 UUID per HTTP attempt, made before the
  request so the flow knows it even if no answer comes (S4-REQUEST-05). Retries of one clip get new
  request ids and keep their idempotency key.
- **The install token** goes only to listener routes, as `Authorization: Bearer <token>`; never in a
  URL, a body, a log or a crash report (S4-INSTALLS-03). `/installs` and `/client-errors` carry no
  token.
- **Timeouts**: connect 15 s, send 30 s (an 8 s clip over slow 2G), receive 15 s (the API waits at
  most 2.5 s for a worker). A timeout is "no answer" (§3.11).
- **Answers are read by the app, not by Dio**: `validateStatus` accepts every status and
  `responseType` is plain text, so a non-JSON body or an unexpected status never raises an exception
  carrying technical text. `ApiAnswer` holds the status, the headers the app uses (`X-Request-Id`,
  `Retry-After`) and the decoded body or "unreadable".
- **The API id of an answer** is the `X-Request-Id` response header when it is a UUID, else
  `error.request_id` (error envelope) or `request_id` (recognize answer) from the body. An answer
  with neither (a proxy's error page) has no API id (S4-ERROR-08).
- **The error envelope** is read as `{error: {code, message, request_id, fields?}}`; a code that does
  not match `^[A-Z][A-Z0-9_]{1,63}$` counts as unknown. `message` and `fields` are never shown
  (S4-D13).
- **`Retry-After`** (`RetryAfter.parse`): whole seconds (`^[0-9]{1,6}$`) or an HTTP date, clamped to
  1–60 s; missing or unreadable → 10 s (the API's `BUSY_RETRY_AFTER_SECONDS`) for 502–504 and 429,
  3 s for 409.
- **No request logging** outside the development flavour with `LOOKUP_VERBOSE_LOGS`; even then only
  method, path, status, duration and the request id — never headers, bodies or audio
  (S4-PRIVACY-04).
- **Cancellation**: each send has a `CancelToken`; "Cancel" on Identifying cancels it.

### 3.9 The listener install (S4-D14)

- **Install id**: on first launch, a random version-4 UUID (not a hardware, Android, advertising or
  IMEI id) stored in `shared_preferences` (`SharedPreferencesAsync`) under `listener_install_id`
  (S4-INSTALLS-01). It is sent only in the registration body.
- **Registration**: `POST /api/v1/installs` with `{"install_id": …, "platform": "ANDROID" | "IOS",
  "app_version": "<version>"}` (S4-INSTALLS-04). The platform comes from `defaultTargetPlatform`;
  the version is the constant in `core/configuration/app_version.dart`, which a test keeps equal to
  `pubspec.yaml`'s `version` (it matches the contract's `^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$`).
- **When**: in the background after the first frame of the first launch; again only when the stored
  token is missing, expired or within 24 hours of `expires_at`, or after a 401 (S4-INSTALLS-02). All
  callers share one registration in progress, so a fast first tap cannot register twice. The phone's
  clock can be wrong, so the 401 is the real signal; the local expiry check only saves a wasted
  request.
- **Token storage**: `listener_install_token` and `listener_install_token_expires_at` in
  `shared_preferences` — app-private storage. Android backup is switched off
  (`allowBackup="false"`, `fullBackupContent="false"`, data-extraction rules that exclude everything),
  so neither the id nor the token is copied to another phone. A keystore-backed store would add an
  unpinned plugin that is known to fail on some low-end devices, for a token that only allows
  rate-limited recognitions; recorded in the security baseline (gap 12).
- **Registration failures** follow the same mapping as recognize answers (§3.11): no answer → no
  connection; 429 → too many tries; 5xx → busy or server failure.
- **No integrity verdict** (Play Integrity or App Attest) in Step 4: it needs a Google Cloud project,
  a Play Console listing and network calls to Google, none of which exist; O10 makes it a soft
  signal anyway, and the per-address limits stay the abuse control (S3-D18). S3-INSTALLS-10 and -12
  stay open, deferred to hardening (P8). (Question Q4.)

### 3.10 The recognize request (S4-REQUEST-01 to -06)

One identify is one `POST <base>/recognize`, `multipart/form-data`, carrying one clip:

| Part | Value | Rule |
|---|---|---|
| `clip_duration_milliseconds` | `"8000"` | from `ClipSettings`, never measured |
| `codec` | `"aac"` | from `ClipSettings` |
| `idempotency_key` | lower-case version-4 UUID | made once at capture (T1/T3); the same on every send of that clip |
| `captured_at` | UTC ISO 8601 with milliseconds and `Z`, e.g. `2026-10-08T09:15:02.123Z` | the wall-clock moment recording started |
| `sent_at` | same format | taken immediately before each send; later than `captured_at` whenever a send is delayed |
| `is_deferred` | `"false"` | live sends only in Step 4 |
| `station_hint` | not sent | "My station" is Phase 6 |
| `audio` (file part, last) | the recorded bytes; file name `clip.m4a`; content type `audio/mp4` | AAC-LC in MP4, so the first bytes carry `ftyp`, which the API checks |

Headers: `Authorization: Bearer <install token>`, `X-Request-Id: <uuid>`, `Accept: application/json`.
No other field, no fingerprint, no device detail (S3-ARCHITECTURE-09's app half).

**Size.** At 24,000 bit/s, 8 seconds of audio is about 24,000 bytes, plus about 1 KB of MP4 header
and 1 KB of form overhead: about 26 KB, inside the "about 24–32 kilobytes, never more than 32"
of S4-REQUEST-02 (ADR-001 measured 25.7 kB for this setting). The limit is checked as
≤ 32,768 bytes for the whole request body, on the emulator and the phone; if a phone's encoder
overshoots, the bit rate is the setting to lower.

### 3.11 Answers to states (S4-D10; gap 10)

| Answer | Next state | Clip | Crash report | Code shown |
|---|---|---|---|---|
| 200 `MATCH`, kind `CAMPAIGN` | matched (T16) | deleted | — | — |
| 200 `MATCH`, kind `CLIENT_DEFAULT` | fallback (T17) | deleted | — | — |
| 200 `MATCH`, a kind the app doesn't know | matched | deleted | — | — |
| 200 `NO_MATCH` | noMatch (T18) | deleted | — | — |
| 200 `CHOOSE_STATION` (from Phase 4 on the server) | error, newer app needed, several stations (T19) | deleted | — | — |
| 200 with a status the app doesn't know | error, newer app needed | deleted | — | — |
| 200 that cannot be read (not JSON; `MATCH` without a readable result) | error, server failure | deleted | yes, `relatedRequestId` = API id | yes |
| 400 `INVALID_AUDIO` | error, recording unusable (T25) | deleted | yes | yes |
| 400 `BAD_REQUEST`, `VALIDATION_FAILED`, `INVALID_JSON`; 413 `PAYLOAD_TOO_LARGE`; 415 `UNSUPPORTED_MEDIA_TYPE` | error, server failure | deleted | yes (the app sent something wrong) | yes |
| 401 `INSTALL_TOKEN_INVALID`, first time for this clip | uploading: register again, resend (T23) | kept | — | — |
| 401 again | error, server failure | deleted | yes | yes |
| 409 `RECOGNITION_IN_PROGRESS`, first two | uploading: wait `Retry-After` (3 s), resend the same key (T22) | kept | — | — |
| 409 a third time | error, server failure | deleted | — | yes |
| 422 `CAPTURE_EXPIRED`, `CAPTURE_TIME_INVALID` | error, server failure (a live clip should never be refused for its time) | deleted | yes | yes |
| 426 (`APP_UPDATE_REQUIRED`, Phase 6) | error, newer app needed | deleted | — | — |
| 429 `RATE_LIMITED` | error, too many tries (T24); `isShortWait` when `Retry-After` ≤ 60 s | deleted (no outbox before Phase 6) | — | — |
| 500 `INTERNAL`, other 5xx except 502–504 | error, server failure | deleted | — (the API logged it with its stack) | yes |
| 502, 503 (`RECOGNITION_BUSY`, `RECOGNITION_TIMEOUT`, `SERVICE_UNAVAILABLE`, any code), 504, sends < 4 | busy, delay from `Retry-After` (T20) | kept | — | — |
| the same on the 4th send | error, server failure if the answer had an API id; else phone failure (T21) | deleted | phone failure: yes | per the rule below |
| any other status (403, 404, 405, 3xx …) | error, server failure | deleted | yes | when it has an API id |
| an error code the app doesn't know | handled by its HTTP status as above; the code is never shown | | | |
| no answer: no connection, DNS failure, timeout, connection dropped | error, no connection (T27) | kept | — | — |
| no answer because the phone itself stopped the request: a fault in the app (`unexpectedFailure`), or plain `http` refused outside development (`plainHttpRefused`) | error, phone failure | deleted | yes: "Recognize request stopped on the phone: a fault in the app (StateError).", the fault's type name only, never its text | the report's id, once accepted |
| the listener cancels | idle (T28) | deleted | — | — |

**When a code may be shown** (S4-ERRORHANDLING-03, S4-ERRORREPORTING-08): only for an API id (the
API logs every refusal at info and every fault at error, with the id) or for the id of a crash
report the API accepted with 202. Anything else shows no code, so "share this code with support"
is only ever said when support can find it.

The clip rule follows the plan's acknowledgement rule (delete on 200, 422 and `INVALID_AUDIO`; keep
on 409, 429, 503 and network errors), except that Step 4 has nowhere to keep a clip after a 429, so
it is deleted (P6's outbox keeps it).

**Network or phone** (S4-D12): only the network's reasons for no answer (no connection, a timeout, a
dropped connection) are "No connection", because only there can "Send again" help. A request the
phone stopped itself would fail the same way on every resend and would never reach a developer, so
it is the phone failure, reported, with the clip dropped. The API client keeps the fault's type
name (`ApiAnswerNotReceived.faultTypeName`, e.g. `StateError`) and never its text, which can quote
addresses or answers; a fault inside the install check is kept the same way.

**A failed install registration** leads where the same answer to the clip would (§3.9), but its
crash report names the registration: "Install registration answer HTTP 400 VALIDATION_FAILED …",
"Install registration answer HTTP 200: the body could not be read: …" or "Install registration
request stopped on the phone: …" (the answer's `answeredRequest`), so a developer never looks for a
recognize request that was not sent.

### 3.12 Reading the card: the Dart mirror of the shared reader (S4-RENDERER-12; S4-D17)

`readActionCard(Object? card, {int supportedSchemaVersion = 1}) → ReadActionCard` in
`result/domain/action_card_reader.dart` follows the TypeScript reader's rules R1–R9 exactly:

- R1 skip an action whose `type` is a string other than `CALL`, `WHATSAPP`, `MAP`, `LINK`
  (counted as unknown); a non-string type is invalid.
- R2 ignore unknown fields (an extra `url` on a call action is never read).
- R3 an unknown or missing `style` reads as `SECONDARY`.
- R4 any `layout` reads as `VERTICAL_STACK`.
- R5 skip a known action with a missing or blank `id` or `label`, a phone number not matching
  `^\+[1-9][0-9]{6,14}$`, a link that is not canonical `https` (§3.14), or coordinates out of range
  (latitude −90…90, longitude −180…180); a blank optional field (`prefilled_text`, `place_name`) is
  dropped and the action kept.
- R6 keep the first of duplicate ids; show at most 6; the first 4 are `visibleActions`, the rest
  `moreOptionsActions`.
- R7 a `schema_version` that is not an integer, or is newer than 1 → no actions and the update hint.
- R8 nothing shown and at least one unknown type → the update hint (skips for invalidity alone do
  not show it).
- R9 never throw: anything that is not an object reads as an empty card.

Its output is a list of sealed `UiAction`s — `CallUiAction`, `WhatsAppUiAction`, `MapUiAction`,
`LinkUiAction` — plus the counts and the hint flag (S4-RENDERER-04).

**Mirroring traps** the tests pin down with shared fixtures (§3.21):
1. JSON `1.0` decodes to a Dart `double`; JavaScript's `Number.isInteger(1.0)` is true, so a
   whole-valued double counts as an integer for `schema_version`.
2. "Is a number" is `value is num` in Dart (JSON has no NaN or infinity).
3. Blank text: JavaScript's `trim()` and Dart's `trim()` disagree on U+0085; `isNonEmptyText` uses
   JavaScript's whitespace set explicitly.
4. `-0.0.toStringAsFixed(6)` is `-0.000000` in Dart but `0.000000` in JavaScript; the map builder
   prints zero without a sign.
5. Label length (for the ellipsis) counts code points (`runes.length`), as the contract does.
6. The canonical-link check (`new URL(url).href === url` in TypeScript) has no Dart equivalent; see
   §3.14.

### 3.13 The ActionRegistry renderer (S4-RENDERER-01 to -11)

- `ActionRegistry` maps each action type to an `ActionRegistration`: a widget builder (presentation)
  and an address builder (domain). It has exactly four entries — call, WhatsApp, map, link
  (S4-RENDERER-02, -03). The registry is the only place a type meets a widget.
- `ActionButtonList` takes a `ReadActionCard` and renders, for `VERTICAL_STACK`, one full-width
  button per row in a `Column` with 8 dp gaps; other layouts (`GRID`) come later and already read as
  `VERTICAL_STACK` (S4-RENDERER-09).
- Style → button variant (S4-RENDERER-06 to -08): `PRIMARY` → `FilledButton`, `SECONDARY` →
  `FilledButton.tonal`, `OUTLINE` → `OutlinedButton`, colours from the tokens.
- An action the reader skipped never reaches the registry; a `UiAction` with no registration (not
  possible today) would be skipped too, so an older app shows every action it knows from a newer
  server (S4-RENDERER-05).
- No campaign label, phone number or link is written in the source (S4-RENDERER-01): everything on a
  button comes from the answer, so a station's edit shows on the next identify with no app update
  (S4-RENDERER-11).
- Order: the card's order, never re-sorted (conflict 18); the card builder puts the primary button
  first (S4-RESULT-10; question Q5).

### 3.14 Button addresses and opening them (S4-LINKS-01 to -13; S4-D16, S4-D19)

`buildActionUri(UiAction action) → String?` in `result/domain/action_uri_builder.dart` — a pure
function, no platform or input/output calls, mirroring `action-uris.ts` after its map change:

| Type | Address | Nothing (null) when |
|---|---|---|
| Call | `tel:` + the E.164 number, e.g. `tel:+260977123456` | the number does not match E.164 |
| WhatsApp | `https://wa.me/` + the digits without `+`, e.g. `https://wa.me/260966123456`; with prefilled text, `?text=` + `Uri.encodeComponent(text)` (same unreserved set as `encodeURIComponent`: spaces `%20`, line breaks `%0A`, `&`, `#`, `+`, `%` and emoji encoded) | the number does not match; the text cannot be encoded |
| Map | `https://www.google.com/maps/dir/?api=1&destination=<latitude>%2C<longitude>`, each printed with six fixed decimals, e.g. `…destination=-15.416700%2C28.283300` (directions, never a place search) | a coordinate is out of range or not finite |
| Link | the link itself, unchanged | it is not canonical `https` |

- The app never opens an address supplied by the server for call, WhatsApp or map; it builds them
  from validated fields. Every address it can produce starts with `tel:+`, `https://wa.me/`,
  `https://www.google.com/maps/dir/?api=1&destination=` or is a canonical `https` link
  (S4-LINKS-12). `javascript:`, `data:`, `http:` and anything else give nothing, and a button whose
  address is nothing opens nothing (S4-LINKS-07).
- **Canonical `https` link in Dart.** The regex is copied from the contract; then, because Dart has
  no WHATWG URL parser, the "already canonical" test is written out: the host is lower case; a `/`
  follows the host; the path has no `.` or `..` segment (also as `%2e`); no `\`; no character the
  WHATWG parser would percent-encode in that part (expected today: in the path `"`, `<`, `>`,
  `` ` ``, `{`, `}` and possibly `^`; in the query `"`, `<`, `>`, `'`; in the fragment `"`, `<`,
  `>`, `` ` ``). The exact sets are whatever Node's parser does: a new shared fixture,
  `fixtures/action-card/canonical-links.json`, whose expected answers the TypeScript test checks with
  the real `new URL`, holds one case per character and per rule, and the Dart rule must agree on all
  of them (S4-D17). If the fixture shows Node refusing an `xn--` host that is not valid punycode, the
  Dart side adds a punycode decode for that check. Links have already passed the same rule when the
  station saved the card and when the API answered (`ListenerCard`), so this is the second line.
- **Opening**: `launchUrl(Uri.parse(address), mode: LaunchMode.externalApplication)` for all four
  types — the dialler, WhatsApp or the browser, Google Maps or the browser (phones without Google
  Play included). `canLaunchUrl` is never called (S4-LINKS-10). `false` or a `PlatformException`
  means "couldn't open" → the copy sheet (§2.6; S4-LINKS-11).
- **Android 11+ `<queries>`** (S4-LINKS-13): `VIEW` with scheme `https` (web links, `wa.me`, Google
  Maps), `VIEW` and `DIAL` with scheme `tel`.
- The phone number on the copy sheet uses the contract's display form (`+260 97 712 3456`); the
  clipboard gets the E.164 form.

### 3.15 The recorder (S4-LISTENING-01 to -04, -13; S4-D6, S4-D7)

```dart
RecordConfig(
  encoder: AudioEncoder.aacLc,     // AAC-LC: every Android version record supports (minimum SDK 23); never Opus
  sampleRate: 16000,
  numChannels: 1,
  bitRate: 24000,                  // ≈ 26 KB per 8 s request (ADR-001: 25.7 kB)
  noiseSuppress: false,            // set explicitly, in one place (ClipSettings)
  autoGain: false,
  echoCancel: false,
  audioInterruption: AudioInterruptionMode.none,    // other audio keeps playing (S4-D34)
  androidConfig: AndroidRecordConfig(
    audioSource: AndroidAudioSource.mic,
    manageBluetooth: false,        // a paired headset must not replace the phone's microphone
    muteAudio: false,
    service: null,                 // no background recording service, ever
  ),
  iosConfig: IosRecordConfig(      // S4-D34: mix with what plays, keep it on the speaker,
    categoryOptions: [             // and no allowBluetooth (a headset's microphone)
      IosAudioCategoryOption.mixWithOthers,
      IosAudioCategoryOption.defaultToSpeaker,
    ],
  ),
)
```

These are the Phase 0 capture app's defaults (`mic`, noise suppression off, automatic gain off,
24 kbit/s), the settings ADR-001's synthetic measurement used, provisional until the pilot (D10;
gap 41). The voice-recognition audio source is the first thing to compare at the pilot.

- A new `AudioRecorder` per capture, disposed after it, so the microphone is released at once.
- **Other audio keeps playing** (S4-D34). Listeners mostly hear the station on the same phone (a
  radio app or a stream), so recording must not stop it: with any interruption mode but `none`,
  `record_android` 1.5.2 takes the audio focus for good (`AUDIOFOCUS_GAIN`), which pauses that app
  for the whole clip and after it; on iOS, `record_ios` 1.2.1 sets `.playAndRecord` with exactly the
  options given, and its default list has no `mixWithOthers` and does have `allowBluetooth`, which
  would record from a headset's microphone. A call still ends the recording: the call screen hides
  the app, which cancels the clip (T13). A pause the platform reports anyway still cancels it.
- **A recorder that breaks while recording** (an error on `record`'s state stream, or the recorder
  stopping before the flow finishes it) is T14 at once: the phone failure, reported, the recording
  cancelled and its file deleted, nothing sent. The flow does not wait for the 8 seconds to end.
- Before starting: `isEncoderSupported(AudioEncoder.aacLc)`; false → phone failure.
- The file: `<getTemporaryDirectory()>/clips/<idempotency key>.m4a`. On stop, the bytes are read into
  memory and **the file is deleted at once**. On cancel, `cancel()` deletes it. Every app start and
  every return to Home deletes anything left in `clips/` (a crash between stop and delete).
- Level: `onAmplitudeChanged(Duration(milliseconds: 100))`, current dBFS mapped to
  `((current + 60) / 60).clamp(0, 1)` (silence, −160 dBFS, is 0).
- Duration: a monotonic stopwatch drives the countdown; at 8,000 ms the recorder stops (T11).
- The recorder is started only by `RecognitionFlow` on T1/T3 (S4-PRIVACY-02); `ClipRecorder` has no
  other caller, which a scan checks.

### 3.16 Microphone permission (S4-PERMISSION-01 to -15; S4-D22)

- `permission_handler` is the only way the app checks or asks: `Permission.microphone.status`,
  `.request()`, `.shouldShowRequestRationale` (Android) and `openAppSettings()`.
- **`record`'s `hasPermission()` is never called**: with its default `request: true` it would show
  the system prompt itself and skip the explainer.
- Mapping: granted → recording. Denied and never asked in this install (a flag
  `has_asked_for_microphone` in `shared_preferences`) → not asked yet. Denied after asking → refused
  once. Permanently denied or restricted → refused for good. Android reports "permanently denied" only
  after a request, so a "Allow microphone" tap that returns it at once leads to the refused-for-good
  variant.
- Identify never asks the system directly; only "Allow microphone" does (S4-PERMISSION-01, -02).
- Android: `RECORD_AUDIO` in the manifest. iOS: `NSMicrophoneUsageDescription` = "Look Up listens for
  a few seconds, only when you tap Identify, to recognise the ad on the radio." and the Podfile's
  `PERMISSION_MICROPHONE=1` macro (S4-PERMISSION-15).

### 3.17 Lifecycle and privacy (S4-PRIVACY-01 to -04; S4-D7, S4-D23)

- An `AppLifecycleListener` in `RecognitionFlow`: on hide or pause during recording → cancel and
  discard (T13); during busy → pause the countdown (T31), resume on show; during the wait after a
  409 → pause it too, and go on with the seconds left on show (T22); on resume during
  permissionNeeded → re-check (T7). `inactive` alone (the notification shade) changes nothing.
- No timed resend leaves a hidden app (S4-D23): Busy's countdown and the 409 wait count only in the
  foreground, and an answer that starts either while the app is hidden waits for it to be shown. A
  send already under way when the app is hidden finishes.
- No background recording: no recorder service, no `FOREGROUND_SERVICE` permission.
- The clip lives in memory only while uploading, busy or "no connection"; it is dropped on every
  outcome and every way out (§2.12). If the app is killed, it is gone. "We kept your clip" is true
  while the app runs; Phase 6's outbox keeps clips across restarts (gap 35).
- The install id leaves the phone only in the registration body; the token only as a bearer header.
- Nothing about the listener goes anywhere else: no device id, no location, no contacts. Crash
  reports carry no install id, token, audio, card content or phone number (§3.19).
- Android backup is off (§3.9).

### 3.18 Theme from the tokens (S4-THEME-01 to -05; S4-D24)

- `tool/generate_design_tokens.dart` (run with `dart run`; no download) reads
  `packages/design-tokens/tokens.json` and writes `lib/core/theme/look_up_tokens.dart`, headed
  "Generated from packages/design-tokens/tokens.json — do not edit by hand". It holds
  `LookUpTokens extends ThemeExtension<LookUpTokens>` (with `copyWith` and `lerp`) and its value
  classes: colours (light and dark), type styles, spacing, radii, sizes (touch minimum 48, gap 8,
  banner aspect 2), motion durations (150, 200, 300 ms). It is the only file with `Color(0x…)`.
  Widgets read `Theme.of(context).extension<LookUpTokens>()!` through one extension getter.
- `LookUpTheme.light()`: `useMaterial3: true`;
  `ColorScheme.fromSeed(seedColor: tokens.accent)` and then `copyWith` the exact token colours
  (primary = accent, on-primary = on-accent, secondary container = accent-soft, on-secondary-container
  = accent-hover, surface, on-surface = ink, on-surface-variant = muted, outline = line,
  outline-variant = line-soft, error = danger), because `fromSeed` alone would not reproduce the
  wireframes' copper; scaffold background = ground; button themes with minimum heights and the
  `md` radius; padded tap targets.
- Light theme only in Step 4 (`themeMode: ThemeMode.light`); the dark values are generated and wait
  for Phase 6 (P6-THEME-01).
- **Fonts**: the system font (Roboto on Android) for display and body text, no font files
  (S4-THEME-04; gap 22, which `tokens.json` allows). Tabular figures for the Busy countdown; the
  system monospace family for the reference code.
- **Tokens to add** to `tokens.json` (the wireframes use sizes it lacks): `headline` 28/34/700
  (state headings), `cardTitle` 22/28/700 and `cardTitleCompact` 20/26/700 (Result title at 360 and
  320 dp). The portal's generated CSS is regenerated with them (its drift test would otherwise fail).
- The halo rings use the accent-soft token and the accent token at reduced opacity, computed in code,
  not new literals.
- Drift (S4-THEME-05): a Flutter test runs the generator's pure function on `tokens.json` and
  compares the result with the committed file; the portal's existing test does the same for its CSS.
  Editing a colour without regenerating makes both fail.

### 3.19 Errors, crash reports and logging on the phone (S4-ERRORHANDLING, S4-ERRORREPORTING; S4-D26)

**Global handlers**, installed in `bootstrap()` before `runApp`:

| Handler | Report kind | Notes |
|---|---|---|
| `FlutterError.onError` | `render` | `FlutterError.presentError` (which prints to the device log) only in the development flavour |
| `PlatformDispatcher.instance.onError` | `uncaught` | returns `true` |
| `ErrorWidget.builder` | (reported through `FlutterError.onError`) | the plain fallback of §2.11; detail only in development with the flag |
| `Isolate.current.addErrorListener(listener.sendPort)` | `uncaught` | `IsolateErrorListener` decodes the `[message, stack]` pair |
| Explicit reports from the flow | `reported` | phone failures, unreadable answers, app-side 4xx |

**The reporter** (`ClientErrorReporter`), sending `POST <base>/client-errors` (Step 2's route):
- Body exactly as `ClientErrorReport`: `source: "listener-app"`, `kind`, `message` (≤ 500, never
  empty), `stack` (≤ 8,000), `location` (the current route path, e.g. `/listening`),
  `relatedRequestId` (the failing call's request id, when there is one), `appVersion` (≤ 40).
- Headers: a new `X-Request-Id` (the report's own id, which the API logs it under and which a phone
  failure's reference code is made from); no `Authorization`.
- **Scrubbed on the phone first** (S4-ERRORREPORTING-05): the stored install id and token are
  replaced by `[install]` and `[token]`; then the same patterns as the server's `scrubPersonalData`
  (emails, phone-number-like digit runs, 32+ character token-like strings, URL query strings). The
  text of a `FormatException` (it can quote the answer, cards included) and of a `DioException` is
  never used — only the type and the app's own description. Audio and card data never reach the
  reporter.
- Resolves to "accepted" (202) or "not accepted"; **never throws**; a failure while reporting is not
  reported. The same error (message and first stack line) is sent once a minute at most, and at most
  10 reports a minute leave the phone (the API allows 30 a minute per address, shared behind one
  carrier address).
- Offline reports are dropped in Step 4; queueing them is P6-ERRORREPORTING-05.

**Logging**: one `DevelopmentLog` that writes nothing unless the flavour is development and
`LOOKUP_VERBOSE_LOGS` is on; `print` and `debugPrint` appear nowhere else (lint `avoid_print` plus a
scan). Release builds therefore write no audio, token, install id, phone number or request body to
the device log (S4-PRIVACY-04).

### 3.20 Android and iOS project settings

- **Android** (`android/app`): minimum SDK **24** (Android 7.0: `url_launcher` and
  `shared_preferences` need 24, `record` 23; S4-LISTENING-02), compile and target SDK 36 (the
  Flutter defaults; the highest any plugin needs is 35). Android Gradle Plugin 8.11.1, Kotlin
  2.2.20 and Gradle 8.14, as cached from the capture app; `settings.gradle.kts` points the plugins'
  own build-script versions at those, so Gradle downloads none of the ~110 MB of tool versions the
  plugins declare but never use; `gradle.properties` caps the Gradle heap at 3 GB with two workers
  and the Kotlin compiler in process (the template's 8 GB would not fit this PC). Permissions:
  `INTERNET` (missing from Flutter's template for release builds),
  `RECORD_AUDIO` — nothing else; the merged manifest is reviewed and any permission a plugin adds
  that the app does not use is removed with `tools:node="remove"`, with the reason in a comment.
  `<queries>` as in §3.14; `allowBackup="false"`, `fullBackupContent="false"`,
  `dataExtractionRules` excluding everything; `usesCleartextTraffic` and the network-security
  configuration per flavour (§3.7). The sideloaded test builds are signed with the debug key; a real
  signing key is a deployment task (P8).
- **iOS** (`ios/`): the usage description and Podfile macro (§3.16); App Transport Security left at
  its default (https only). No iOS flavours, build or signing in the MVP; checked by file review only
  (gap 32).

### 3.21 Changes outside `apps/mobile`

1. **`packages/contracts`**
   - `action-uris.ts`: the map case builds the directions form (§3.14); the two map cases in
     `fixtures/action-card/action-uris.json` change; add cases for latitude `-0.0`, whole-number
     coordinates and a WhatsApp text that cannot be encoded (the TypeScript builder catches the
     `URIError` and returns `null`, as the Dart one does). Closes S2-BUTTON-ADDRESSES-04.
   - A separate `buildMapSearchAddress` for the portal's "Check on Google Maps" link in the buttons
     step (a station checking a pin wants the pin, not directions); the portal's map-link parser
     accepts both forms. Portal tests that expect the search form are updated
     (`ad-detail-page.test.tsx`, `buttons-step.test.tsx`, `parse-map-location.test.ts`).
   - `fixtures/action-card/canonical-links.json` (about 30 links with `is_canonical`), checked by a
     new contracts test with the real `isCanonicalHttpsLink`.
   - Reader fixtures for the mirroring traps: `schema_version` `1.0`, a label of only U+0085, a
     latitude of `-0.0`.
   - `referenceCodeForRequestId(requestId)` (first 8 hex digits, upper case, `XXXX-XXXX`) with
     `fixtures/errors/reference-codes.json`, so the app, the API's tests and any support tool agree.
   - `fixtures/errors/envelopes/*.json`: one error envelope per code the app maps (busy, timeout,
     internal, rate limited, install token invalid, invalid audio, in progress, validation failed with
     fields), each validated against `error-envelope.schema.json` by a contracts test.
   - `fixtures/recognition/recognize-request/valid/live-identify.json`: the text fields of a live
     identify, validated against `recognize-request-fields.schema.json`.
   - Emit `schemas/client-error-report.schema.json` (give `ClientErrorReport` a schema id and an emit
     function), so the app's reports are checked against the contract like every other body.
2. **`packages/design-tokens/tokens.json`**: the three type tokens of §3.18; the portal's
   generated CSS regenerated.
3. **`apps/api` tests** (no production change): a log-capture test that a forced 500 with a given
   `X-Request-Id`, and a client-error report sent with one, are each logged with that id (the 500
   with its stack) and found from the reference code (S4-ERROR-07 part 2, S4-ERRORREPORTING-08
   part 2); an end-to-end test that editing a button label in a published card changes the label in
   the next recognize answer (S4-RENDERER-11, API half).
4. **Docs**: this spec as `docs/design/step-4-listener-app.md`; the security-baseline rows for the
   app (built links, crash reports, token storage, cleartext, backup, clip lifetime, no background
   recording); how to find a log line from a reference code; how the phone reaches the PC
   (S4-TESTS-10); the checklist ticked at the gate with test evidence.
5. **`.gitignore`**: Flutter build outputs under `apps/mobile`, and
   `apps/mobile/config/development-phone.json`.

---

## 4. Tests

### 4.1 Rules

- Every test can fail the build: no `|| true`, no swallowed exit code, no skipped suite; at the
  gate `flutter test` has zero skips (ALL rules).
- Dependencies are replaced through provider overrides only (S4-TESTS-01). Fakes live in
  `test/support/`: `FakeClipRecorder` (scripted levels and bytes), `FakeMicrophonePermission`,
  `FakeActionLauncher` (records addresses; can answer false or throw), `FakeClock`,
  `FakeHttpClientAdapter` for Dio (scripted answers, records requests), `RecordingClientErrorReporter`,
  `FixedRandomUuid`.
- Fixtures are read from `../../packages/contracts/fixtures/` and `../../packages/contracts/schemas/`
  at test time, never copied (S4-TESTS-03). `test/support/contract_schema_checker.dart` checks a
  field map against an emitted JSON Schema's `required`, `properties`, `additionalProperties: false`,
  `enum` and `pattern` (enough for these flat schemas, with no new dependency).
- Leak assertions use one helper, `expectNoTechnicalText`, which fails if the screen shows any of
  `Exception`, `Error:`, `SocketException`, `DioException`, `FormatException`, `at `, `/data/`,
  `package:`, `.dart`, `SQLSTATE`, `Fatal error`, an HTTP status line, or the API's `message` text.
- Heavy commands run one at a time with the Look Up containers stopped (§4.10).

### 4.2 Unit tests (`test/`, mirroring `lib/`)

| File | Proves |
|---|---|
| `core/configuration/app_configuration_test.dart` | flavour parsing; `https` required outside development; address must end `/api/v1`; development flags refused elsewhere; `appFlavor` mismatch refused; staging and production without a support number refused; the staging and production placeholders refused for that alone, and accepted once a number is filled in |
| `widget_test.dart` (start-up) | a refused configuration starts nothing; an accepted one installs the handlers, sweeps old clips, shows Home and registers; `bootstrap` tells the isolate error listener to listen to `Isolate.current` (seen through its `createIsolateErrorListener` parameter), and an error message on that port reaches the app's reporter with the route (S4-ERRORHANDLING-07) |
| `features/result/data/https_image_provider_test.dart` | an `https` image loads with one request; a redirect to another `https` address is followed by the app; a redirect to plain `http` fails the image and `http` is never asked for; more than five redirects fail; a non-`https` address is never asked for |
| `core/configuration/app_version_test.dart` | the version constant equals `pubspec.yaml`'s `version` and matches the contract pattern |
| `core/identifiers/random_uuid_test.dart` | version-4 shape accepted by the API's pattern; 10,000 draws all different |
| `core/identifiers/reference_code_test.dart` | every case in `fixtures/errors/reference-codes.json` |
| `core/network/retry_after_test.dart` | `12` → 12; `0` → 1; `999` → 60; an HTTP date; garbage or missing → the default per status |
| `core/network/api_client_test.dart` | `X-Request-Id` on every request, a valid UUID, new per attempt; base address from configuration; token only on listener routes; `http` refused outside development; timeouts set; nothing logged outside development |
| `core/listener_install/listener_install_repository_test.dart` | first launch stores a UUID, the second reads the same one; one `/installs` call on first launch, none later; body passes `register-install-input.schema.json` with platform and version; renewal near expiry; one re-registration after 401; two callers share one registration; no Android id, IMEI or advertising id is read |
| `core/error_reporting/client_error_reporter_test.dart` | body passes `client-error-report.schema.json`; `source` `listener-app`; trimmed to limits; no `Authorization`; own `X-Request-Id`; phone number, token and install id scrubbed; `FormatException` and `DioException` text never used; "accepted" only on 202; never throws; one report per repeated error a minute; at most 10 a minute |
| `core/error_reporting/personal_data_scrubber_test.dart` | the same cases as the server's scrubber test, plus the install id and token |
| `core/error_reporting/global_error_handlers_test.dart` | `FlutterError.onError` reaches the reporter once; `PlatformDispatcher.instance.onError` reaches it and returns `true`; `presentError` only in development; `IsolateErrorListener` decodes and reports an error raised in a spawned isolate wired to its port, and `bootstrap` registers it on `Isolate.current` |
| `core/theme/look_up_tokens_test.dart` | regenerating from `tokens.json` gives the committed file byte for byte; every text/background token pair the app uses meets 4.5:1 |
| `core/theme/look_up_theme_test.dart` | `useMaterial3`; seed and primary equal the accent token; no font family declared |
| `features/identify/domain/recognition_state_test.dart` | the nine subclasses exist; every field of every state and failure is non-null |
| `features/identify/domain/recognition_outcome_test.dart` | every row of §3.11, including unknown codes → generic server failure and the "code may be shown" rule |
| `features/identify/domain/send_policy_test.dart` | 4 sends, 2 waits, 1 re-registration |
| `features/identify/data/recognize_request_builder_test.dart` | fields pass `recognize-request-fields.schema.json` and match `recognize-request/valid/live-identify.json` in shape; `audio` part name, file name, type and bytes; clip length equals the setting; codec `aac`; same key on two sends of one clip, different keys for two captures; `sent_at` taken at send time and later than `captured_at` when delayed; `is_deferred` `false`; no `station_hint`; token absent from body and URL; whole body ≤ 32,768 bytes for an 8 s clip |
| `features/identify/data/recognize_response_parser_test.dart` | the response fixtures (§4.4) |
| `features/identify/data/recognition_repository_test.dart` | API id from header, then body, else none; status and `Retry-After` passed through; each Dio failure type → "no answer"; cancel |
| `features/identify/data/clip_recorder_test.dart` | the `RecordConfig` values of §3.15 exactly; file under `clips/`, deleted after stop and on cancel; leftovers swept; dBFS → level; `hasPermission` never called |
| `features/identify/data/microphone_permission_test.dart` | status → `MicrophoneAccess` mapping, including "permanently denied only after a request" |
| `features/identify/presentation/recognition_flow_test.dart` | every row T1–T41 with fakes and fake time: granted gives idle → recording → uploading → matched; not granted gives idle → permissionNeeded; seconds left 8 → 0 and levels in 0–1; `Retry-After: 12` gives busy carrying 12; a 500 with `request_id` X gives an error carrying X; the busy retry resends the same bytes and key; 4-send limit; cancel, close and background send nothing; the clip is dropped on every way out |
| `features/result/domain/action_card_reader_test.dart` | the card fixtures (§4.4) and the mirroring traps |
| `features/result/domain/action_uri_builder_test.dart` | `action-uris.json`; hostile inputs only ever give the allowed prefixes; runs with no Flutter binding |
| `features/result/domain/canonical_https_link_test.dart` | `canonical-links.json` |
| `features/result/domain/phone_number_display_test.dart` | `+260977123456` → `+260 97 712 3456`; foreign numbers unchanged |
| `features/result/data/action_launcher_test.dart` | `launchUrl` with external mode; `canLaunchUrl` never called; `false` and exceptions → "couldn't open" |

### 4.3 Widget tests (decorations asserted in place of golden images)

Each screen test checks its wording, controls, transitions (through a fake-backed notifier),
semantics (headings, live regions, labels, hidden decorations), `androidTapTargetGuideline` and
`labeledTapTargetGuideline`, 8 dp gaps between targets (in logical pixels), visible words on every
control other than Back and Close (S4-USABILITY-01; `expectEveryControlShowsText`, itself proven to
fail on an icon-only button), no overflow at 360 × 800 and 320 × 640, no overflow and no clipped
text at text scale 2.0, a notch and gesture-bar `MediaQuery` padding (controls inside the safe
area), `disableAnimations` (no pending frames; the copy sheet and the "copied" snackbars in place on
their first frame), and `expectNoTechnicalText` with hostile exceptions on every failure path.

| File | Specific checks |
|---|---|
| `home_screen_test.dart` | one primary control, labelled "Tap to identify", with the microphone icon and two rings; the decorations of S4-HOME-06 and -07: an accent disc 200 dp across, the 56 dp microphone and the label in on-accent, rings 12 and 28 dp wide in accent-soft and half-faded accent-soft; its centre below the middle at 360 × 800; "Look Up"; heading semantics on "Heard an ad on the radio?"; the instruction and data note; label "Identify the ad playing now"; granted → recording, not granted → permission |
| `permission_screen_test.dart` | the three variants, each with the microphone in accent on an 88 dp accent-soft circle (S4-PERMISSION-06); no request before "Allow microphone"; Back and "Not now" make none; "Open phone settings" calls the settings function; ticks have no semantics; grant → recording |
| `listening_screen_test.dart` | Close and "Cancel" stop the fake recorder, send nothing, show Home; the decorations of S4-LISTENING-06: a 164 dp accent disc, the 52 dp microphone in on-accent, three rings 20, 40 and 60 dp wide in the soft accent, only the rings inside the scaling; a louder level gives a larger ring scale; 16 bars and the filled count; progress ≈ 0.62 with 3 s left; "8 seconds left" then "3 seconds left" five seconds later, "1 second left"; "Listening…" is a live region; the bar row has no semantics |
| `identifying_screen_test.dart` | wording; "Cancel" cancels the request and shows Home |
| `result_screen_test.dart` | header and label; "Found it" a heading and a live region with the status role; the card's decorations (S4-RESULT-03): surface fill, line-soft border drawn over the banner, 16 dp corners, clipped; at 360 and 320 dp (S4-RESULT-15) the order banner, client row, title, buttons, with 16 or 12 dp sides, card padding and gap, the 22 or 20 dp title and the 40 or 36 dp logo; no "Saved to History" and no "Report this" (S4-D1); card with banner box 2:1 the same size before and after a fake image loads, at 360 and 320; no box without a banner; "Brand A" and "via Station A · 98.1 FM"; initial letter "A" without a logo; logo hidden; title is a heading; full-width buttons at 360 and 320 in card order; icons per type, none below 360; heights ≥ 52, gaps 8; exact labels from the four-action card; a 32-character label on one line at 320 × 640 and scale 1.0; a longer label ellipsised with the full label in semantics; "More options" with 6 actions; taps launch the built address; a launcher answering false shows "Copy number" and the clipboard gets the E.164 number; a `javascript:` link never reaches the launcher; a call action with an extra `url` opens only `tel:`; update hint and empty-card note; the fallback note; one haptic call on entering matched and fallback; no download other than the banner, no media player |
| `action_registry_test.dart` | exactly four types, each with both builders; `FilledButton`, `FilledButton.tonal`, `OutlinedButton` per style; one column for `VERTICAL_STACK`; a card with call, `ACTION_SHOP` and link renders two buttons and throws nothing |
| `no_match_screen_test.dart` | wording; the magnifying glass in muted on an 88 dp line-soft circle (S4-NOMATCH-03); status role; panel heading and three tips in order; list semantics, badges hidden; "Try again" → recording; "Back to home" and the × found by its label "Close" → Home (S4-ACCESSIBILITY-11) |
| `busy_screen_test.dart` | wording and status role; the refresh icon in warning on an 88 dp warning-soft circle (S4-BUSY-03); "12 s" then "11 s" with tabular figures; the bar grows from 0 to 1; polite live region; a send at zero; "Try now" sends at once and no second send follows; "Cancel" and the × found by its label "Close" send nothing more and leave no clip file (S4-ACCESSIBILITY-11) |
| `error_screen_test.dart` | each variant's wording, role, icon and buttons; each variant's icon colour and circle colour as §2.10 lists them (S4-ERROR-03); the code derived from the fake API's id, in monospace; "Copy" puts the displayed code on the clipboard; "Try again" → recording; "Send again" resends the kept clip; "Back to home" and Close → Home; development details only with the flag, never in production |
| `result_fixture_cards_test.dart` | each shared reader fixture: the drawn labels, top to bottom, are exactly those of `visible_action_ids`, then after "More options" those of `more_options_action_ids`, in order; each valid card shows all its actions in card order |
| `public_image_view_test.dart` | an image of the box's shape or taller decoded at the box's width, a wider one at the box's height; the image loaded through `HttpsImageProvider`; a banner whose server redirects to `http` never fetched over `http`, the box keeping its fill |
| `launch_failure_sheet_test.dart`, `reference_code_panel_test.dart` | wording and copying; with "Remove animations" the sheet and the snackbars complete on their first frame, and slide when animations are on |
| `plain_error_fallback_test.dart` | a throwing widget in a production-flavour test shows "This part couldn't be shown." and no exception text; development with the flag shows the detail |
| `app_router_test.dart` | the route list (no ads route); Home → Listening → Result by route with fakes; an unknown path goes Home; system back on each screen does what its Back or Close does |

**No golden images in Step 4.** The decorations the checklist items name (S4-HOME-06, -07,
S4-PERMISSION-06, S4-LISTENING-06, S4-RESULT-03, -15, S4-NOMATCH-03, S4-BUSY-03, S4-ERROR-03) are
asserted in the widget tests above instead: the fill and icon colours against the tokens, the
sizes, ring widths, radius and border, and the order and spacing at 320 dp. Those assertions run on
any machine and fail on the exact value that changed, where a golden image needs a reviewed
reference picture per platform font. How the screens look as a whole is reviewed by eye from
screenshots at the gate (S4-D28). Phase 6 adds golden images with the full matrix (four sizes × two
text scales × two themes).

### 4.4 Shared-fixture tests (S4-TESTS-03; the app halves of S3-RESPONSE-15 and S4-RENDERER-12)

| Fixture set | Expected in the app |
|---|---|
| `action-card/reader/*.json` (15) | `readActionCard` gives exactly the fixture's visible ids, more-options ids, styles, counts and hint; the widget shows those buttons and the hint |
| `action-card/valid/*.json` (13) | every action shown, nothing skipped, never more than 6 |
| `action-card/invalid/*.json` (36) | never throws; every address the builder makes starts with an allowed prefix; the cases the reader also refuses (non-canonical, `http:`, `data:`, `javascript:` links, local or spaced numbers, out-of-range coordinates, missing id) are skipped |
| `action-card/action-uris.json` | `buildActionUri` gives each `expected_uri` exactly (after the map change) |
| `action-card/canonical-links.json` (new) | the Dart check agrees with every case |
| `recognition/recognize-response/valid/*.json` (6) | `match-campaign` and `match-with-images` → matched (image fields read); `match-client-default` → fallback; `no-match` and `no-match-deferred-with-offset` → noMatch; `choose-station` → newer app needed |
| `recognition/recognize-response/invalid/*.json` (13) | never throws and never shows a forbidden value. Fields the app does not use are ignored (`missing-is-deferred`, `recognition-id-version-4`, `no-match-with-candidates`, `no-match-with-result` read normally); extra internal fields (`tenant-id`, `audio-asset-number`, `match-scores`, `station-engagement-limit`) are ignored and never displayed; `header-image-not-https` shows the card without the image; `unknown-result-kind` → matched; `ambiguous-status` and `match-found-status` → newer app needed; `match-without-result` → server failure |
| `errors/envelopes/*.json` (new) | each maps to its row of §3.11 |
| `errors/reference-codes.json` (new) | each id gives its code |
| schemas `register-install-input`, `recognize-request-fields`, `client-error-report` (new) | the bodies the app builds pass them |

### 4.5 Structure and source scans (`test/structure/`)

- `feature_folders_test.dart`: `identify` and `result` exist; each feature has exactly
  `presentation`, `domain`, `data`.
- `layer_imports_test.dart`: the import rules of §3.2.
- `source_scan_test.dart` over `lib/` (and `test/` where named): no `http://`/`https://` literal
  except the two button prefixes; no `canLaunchUrl`; no `Color(0x` or `Colors.` outside
  `look_up_tokens.dart`; no `BackdropFilter` or `ImageFilter.blur`; every `Image` sets its decode
  size (`cacheWidth`, or `cacheHeight` for an image wider than its box); no `Image.network` or
  `NetworkImage`, which follow a redirect to `http` (images load through `HttpsImageProvider`);
  every animation duration in widget code (`app/`, `core/widgets/`, `presentation/`) is a motion
  token, `Duration.zero`, or a value the same file sets only from those, and every
  `showModalBottomSheet`, `showBottomSheet` and `showSnackBar` call passes an animation style read
  from the motion tokens (`AnimationStyle.noAnimation` for less motion; left out or `null`, Material's
  own durations apply); only a transform or the
  opacity animates (`ScaleTransition`, `AnimatedScale`, `FadeTransition`, `AnimatedOpacity`: any
  other `Animated…` widget, `…Transition`, `TweenAnimationBuilder` or `Hero` fails); no campaign
  label or phone number written in `lib/` (S4-RENDERER-01): no literal of eight digits or more, none
  equal to a label in the shared card or answer fixtures or the wireframes, none worded like a
  campaign button ("Call …", "Chat …", "Visit …", anything with "WhatsApp"), except the Error
  screen's own "Message support on WhatsApp" (S4-D32), allowed by file; no `print`/`debugPrint` outside
  `development_log.dart`; no `hasPermission(`; `ClipRecorder.start` called only from
  `recognition_flow.dart`; no Android id, IMEI or advertising-id API; no audio or video player; no
  fingerprinting code (S3-ARCHITECTURE-09); no `setPreferredOrientations`; banned short names
  (`req`, `res`, `err`, `cfg`, `ctx`, `btn`, `msg`, `idx`, `tmp`, `val`, `str`, `len`, `cnt`, a
  one-letter `catch (e)`) in `lib/` and `test/`, with the conventions' exceptions (`context`,
  `build`, record's `noiseSuppress`, `autoGain`, `bitRate`); the domain words (no `tenant`,
  `customer`, `spot`, `payload`); no key-like secrets. Each rule is proven to fail on a planted
  violation in a temporary copy of `lib/`, and the duration rule to pass the token forms it allows.
- `pubspec_test.dart`: the exact pins of §3.3; no `bloc`/`flutter_bloc`; no font family; the Flutter
  constraint admits 3.41.9; no Google Play services plugin.
- `android_project_test.dart`: minimum SDK 24; the three flavours and ids; permissions exactly
  `INTERNET` and `RECORD_AUDIO`; the `<queries>`; backup off; cleartext off in `main`, on only in
  `development`.
- `ios_project_test.dart`: `NSMicrophoneUsageDescription` present; the Podfile macro present.
- `flutter analyze` with `flutter_lints` plus `prefer_const_constructors`,
  `prefer_const_literals_to_create_immutables`, `avoid_print`, `unawaited_futures`: zero issues.

### 4.6 The fake API (S4-TESTS-05, -06; S4-D29)

`apps/mobile/tool/fake_listener_api.py`: Python standard library only (`http.server`, `json`,
`email.parser` for multipart — not `cgi`, which Python 3.13 removed), no Docker, bound to
`127.0.0.1:3999` (the emulator reaches it as `10.0.2.2:3999`).

- `POST /api/v1/installs`: checks the body exactly as `RegisterInstallInput` (keys, UUID, platform,
  version pattern) → 200 `{install_token, expires_at}` (a JWT-shaped fake token, 30 days).
- `POST /api/v1/recognize`: checks a bearer token it issued, an `X-Request-Id` UUID, multipart with
  exactly the contract's fields (refuses a request missing `audio`, `clip_duration_milliseconds` or
  `codec`, or carrying anything extra), `ftyp` at byte 4, 256 KiB at most; echoes `X-Request-Id`;
  answers with the next scenario. Answers are the shared fixtures
  (`recognize-response/valid/*.json`, with `request_id` replaced by the echoed id) and the shared
  envelope fixtures, so the fake cannot drift from the contract.
- Scenarios: `match`, `fallback`, `no-match`, `choose-station`, `match-more-options`
  (`match-campaign`'s card plus the buttons of `action-card/valid/six-actions.json` it does not hold,
  by id: six buttons, so "More options" shows), `busy` (503 `RECOGNITION_BUSY`, `Retry-After: 6`,
  long enough to be seen between two screen reads), `busy-without-request-id` (the same with no
  `X-Request-Id` header and no `request_id` in the body: four of them end in the phone failure, T21),
  `timeout` (503 `RECOGNITION_TIMEOUT`, `Retry-After: 6`), `error` (500 `INTERNAL` with the id),
  `rate-limited`, `token-invalid-once`, `invalid-audio`, `unreadable` (200, not JSON), `drop`
  (closes the connection: no answer).
- `POST /api/v1/client-errors`: checks `ClientErrorReport` → 202, kept for inspection.
- Control routes (fake only): `POST /__fake/scenarios` (a queue, e.g. `["busy", "match"]`),
  `GET /__fake/requests` (method, path, header names, request ids, idempotency keys, field names,
  audio and body sizes), `POST /__fake/reset`. The last recognize clip is saved to the path given by
  `--save-audio-to`.
- `tool/test_fake_listener_api.py` (`unittest`, standard library) proves the fake refuses bad
  requests, so a passing emulator run means the app's requests were right.

### 4.7 Emulator tests (S4-TESTS-04, -07, -08; S4-COMPATIBILITY-01)

The debug Flutter engines are not on this PC and cost about 114 MB, so the emulator tests run the
**release APK** and drive it from outside, as the Phase 0 capture app was tested (the user's choice,
8 October 2026; S4-D33). `apps/mobile/tool/run_emulator_tests.py` runs them, in order, and exits
non-zero on any failure:
1. Refuses to start if Docker Desktop or any Look Up container is running (it does not stop them:
   the user's other project's containers share Docker; it asks).
2. Builds `flutter build apk --release --flavor development --target-platform android-x64
   --dart-define-from-file=config/development-fake.json` (the address `http://10.0.2.2:3999/api/v1`,
   the developer tools on), starts the fake API and the `lookup_test` virtual device (Android 13
   `aosp_atd`, no Google Play services, headless, audio on so the recorder has an input), waits for
   boot and installs the APK.
3. Drives the app with `adb` and `uiautomator` (read the screen as an accessibility tree, tap by
   label), with the fake API's scenario queue choosing each answer: first launch registers once;
   Home → Permission → "Allow microphone" → the real system dialog → "Allow" → Listening (8 s, the
   real recorder) → Result with the fake's card; tap "Call us": the image has no dialler, so the
   open fails and the copy sheet shows "+260 97 712 3456" (the app tried `tel:+260977123456`);
   no match; busy then automatic retry → Busy, which must be seen on screen (the fake's
   `Retry-After` is 6 s, longer than two screen reads), then Result, and the fake's request log
   shows the same idempotency key on both sends; error → the code derived from the fake's echoed id; a dropped
   connection → No connection → "Send again" → Result; "Send a test error" → one report at
   `/client-errors` with its id (S4-ERRORREPORTING-07); a second start of the same installed app
   makes no new `/installs` call.
4. Every recognize request of step 3 is measured from the fake's request log (S4-REQUEST-02): the
   whole body ≤ 32,768 bytes, carrying at least 16,000 bytes of audio (a real 8-second clip is about
   25–27 KB). Then the last clip the fake received from the real recorder is checked by
   `services/fingerprinter/.venv` Python running `tool/check_received_clip.py` (PyAV): AAC, 16,000
   Hz, one channel, file ≤ 32,768 bytes, and 7.5–10.5 s here: the emulator's virtual microphone hands
   the recorder more audio than real time (Android logs a buffer overflow as recording starts; the
   recorder itself runs 8 seconds of wall-clock time, from start to stop in the device log), so the
   strict 7.5–8.5 s check runs on the phone (§4.9).
5. A production-flavour release APK built with an `http://` address shows the set-up problem screen,
   and the fake receives nothing (S4-SECURITY-02). Its define file has a valid support number (the
   development fake's), so the `http` address is the only thing wrong with it
   (`production_cleartext_defines`, unit-tested in `tool/test_run_emulator_tests.py`).
6. Stops the emulator and the fake; writes the device name and image, each step's outcome and the
   screen dumps of any failure to the run record.

Screens, providers and the flow are tested with fakes on the PC (§4.2, §4.3); the emulator run proves
the same flow with the real recorder, permission, Dio client, install store and network. Opening real
targets (dialler, WhatsApp, Maps, browser) is checked on the phone (§4.9).

### 4.8 API and contracts tests added (§3.21)

- Contracts (vitest): the map directions cases; `canonical-links.json` against `isCanonicalHttpsLink`;
  the new reader trap fixtures; `reference-codes.json`; the envelope fixtures against the schema; the
  recognize-request fixture against its schema; `client-error-report.schema.json` equals the zod
  schema (like the other emitted schemas).
- Portal (vitest): the three map-address tests updated; the token CSS regenerated and its drift test
  green.
- API (vitest, compose stack): the reference-code log-capture test; the card-edit end-to-end test.

### 4.9 The manual phone check (S4-TESTS-09, -10; S4-SLICEVERIFY-05 to -09)

After the emulator pass, on the user's own phone, sideloaded, against the local stack. Set-up
(S4-D30): an ngrok tunnel from the user's fixed ngrok `https` address to the API on port 3100,
run only during the session (ngrok is an 11.7 MB download and needs the user's free account and
token); `config/development-phone.json` with `https://<ngrok address>/api/v1`, so the phone uses no
plain http;
`flutter build apk --release --flavor development --target-platform android-arm64
--dart-define-from-file=config/development-phone.json`; install the APK. Then, with the compose stack, API, workers and portal running and the
emulator off:

1. In the portal, Station A uploads a synthetic ad made with `bench/synthetic_audio.py`, for
   "Brand A", with Call, WhatsApp, Map and Link buttons, scheduled now; it reaches Ready; publish.
2. Open the app: the explainer, then the system prompt after "Allow microphone" (the real OS dialog).
3. Play the ad from the PC's speaker near the phone; tap Identify → Result with Station A's buttons.
4. Call opens the dialler with the number; WhatsApp opens a chat; Map opens directions; Link opens
   the browser (S4-LINKS-13 on the phone's Android version).
5. Edit a button label in the portal; identify again → the new label (S4-RENDERER-11).
6. Stop the workers; identify → Busy; the API answers 503 with a request id; that id is found in the
   API log with the full error (S4-SLICEVERIFY-09).
7. Force a 500 (development-only test route or a stopped database) → Error with a code; the code is
   found in the log; "Send a test error" → the report's code is found in the log
   (S4-ERROR-07 part 3, S4-ERRORREPORTING-08 part 3).
8. Send the app to the background during Listening → back at Home, nothing sent.
9. The clip's length on real hardware: point the ngrok tunnel at the fake API
   (`python tool/fake_listener_api.py --port 3999 --save-audio-to clip.m4a`) for one identify, then
   `tool/check_received_clip.py clip.m4a` with its strict 7.5–8.5 s window (S4-LISTENING-01).

The record names the phone, its Android version, the flavour and build mode, and the outcome of each
step, and goes into the step's gate record.

### 4.10 Gate run order

1. Docker up: contracts, portal and API test suites (API with the real Python workers); `pytest`.
   Then stop the Look Up containers.
2. Docker Desktop closed: `flutter analyze`; `flutter test` (unit, widget, structure);
   `tool/test_fake_listener_api.py`; `tool/run_emulator_tests.py`.
3. Emulator off, Docker up: the slice verification (stack up, roles, migrate, seed — current names
   `npm run database:create-roles`, `database:migrate`, `database:seed`; API on 3100, workers,
   portal on 5180) and the manual phone check.

---

## 5. Item map

"Here?" says whether the item can be built and verified on this machine: **Yes**; **Partly** (what
cannot, and why); **No** (why). 235 items.

| Item | Covered by | Here? |
|---|---|---|
| S4-SCOPE-01 | §1, §2.12, §4.7 journey, §4.9 steps 1–3 | Partly — the real-ad run needs the user's phone (manual) |
| S4-SCOPE-02 | §3.1, §3.3 | Yes |
| S4-SCOPE-03 | §2 (every screen against its board), §3.1–§3.13 | Yes — screens with no board are reviewed as screenshots at the gate (S4-D28) |
| S4-SCOPE-04 | §2.12 T1–T16, §4.7 | Yes |
| S4-SCOPE-05 | §1, S4-D1 | Yes (gate review) |
| S4-SCOPE-06 | §3.6, `app_router_test` | Yes |
| S4-STACK-01 | §3.3 | Yes |
| S4-STACK-02 | §3.3, `pubspec_test` | Yes |
| S4-STACK-03 | §3.3, `pubspec_test` | Yes |
| S4-STACK-04 | §3.3, `pubspec_test` | Yes |
| S4-STACK-05 | §3.3, `pubspec_test` | Yes |
| S4-STACK-06 | §3.3, `pubspec_test` | Yes |
| S4-STACK-07 | §3.3, `pubspec_test` | Yes |
| S4-STACK-08 | §3.3, `pubspec_test` | Yes |
| S4-STACK-09 | §3.3 | Yes — after the approved download |
| S4-STRUCTURE-01 | §3.1, `feature_folders_test` | Yes |
| S4-STRUCTURE-02 | §3.1, `feature_folders_test` | Yes |
| S4-STRUCTURE-03 | §3.2, `layer_imports_test` | Yes |
| S4-STRUCTURE-04 | §3.1 | Yes |
| S4-STRUCTURE-05 | §3.6, `app_router_test` | Yes |
| S4-STRUCTURE-06 | §3.7 | Partly — Android flavours build here; iOS has no flavours in the MVP |
| S4-STRUCTURE-07 | §3.7, `source_scan_test` | Yes |
| S4-STRUCTURE-08 | §3.1, §3.20 | Partly — `flutter build ios` needs macOS (gap 32) |
| S4-STATE-01 | §3.5 (Notifier over the sealed state; registration a shared `Future` in the repository, no state to show) | Yes |
| S4-STATE-02 | §3.4 | Yes |
| S4-STATE-03 | §2.12, §3.4, `recognition_state_test` | Yes |
| S4-STATE-04 | §3.4, T9–T11, `recognition_flow_test` | Yes |
| S4-STATE-05 | §3.4, T20, `recognition_flow_test` | Yes |
| S4-STATE-06 | §3.4 (through `ServerFailure`), `recognition_flow_test` | Yes |
| S4-STATE-07 | §3.4, `recognition_state_test` | Yes |
| S4-STATE-08 | §2.12 T1–T3, T11, T16 | Yes |
| S4-STATE-09 | §3.4, every screen test | Yes |
| S4-STATE-10 | §3.11, T16 | Yes |
| S4-STATE-11 | §3.11, T17 (`kind: CLIENT_DEFAULT` settles gap 27) | Yes |
| S4-STATE-12 | §3.11, T18 | Yes |
| S4-STATE-13 | §3.11, T20, §3.8 Retry-After | Yes |
| S4-STATE-14 | §3.11, T26 | Yes |
| S4-INSTALLS-01 | §3.9, `listener_install_repository_test` | Yes |
| S4-INSTALLS-02 | §3.9, §4.7 | Yes |
| S4-INSTALLS-03 | §3.8, §3.10, request-builder test, fake API | Yes |
| S4-INSTALLS-04 | §3.9 | Yes |
| S4-REQUEST-01 | §3.10, §4.7 | Yes |
| S4-REQUEST-02 | §3.10, §3.15, §4.7 step 4, S4-D31 | Yes — measured on the emulator; the phone figure in §4.9 |
| S4-REQUEST-03 | §3.10, T1, T30 | Yes |
| S4-REQUEST-04 | §3.10 | Yes |
| S4-REQUEST-05 | §3.8 | Yes |
| S4-REQUEST-06 | §3.10, request-builder test, fake API refusals | Yes |
| S4-HOME-01 | §2.2 | Yes |
| S4-HOME-02 | §2.2 | Yes |
| S4-HOME-03 | §2.2 | Yes |
| S4-HOME-04 | §2.2 | Yes |
| S4-HOME-05 | §2.2 | Yes |
| S4-HOME-06 | §2.2, decorations asserted in the widget test (§4.3) | Yes |
| S4-HOME-07 | §2.2, decorations and ring count asserted in the widget test (§4.3) | Yes |
| S4-HOME-08 | §2.2, T1, T2 | Yes |
| S4-HOME-09 | §2.2 | Yes |
| S4-PERMISSION-01 | §3.16, T2 | Yes |
| S4-PERMISSION-02 | §2.3, §3.16 | Yes |
| S4-PERMISSION-03 | §2.3 | Yes |
| S4-PERMISSION-04 | §2.3 (refused for good), T6 | Yes |
| S4-PERMISSION-05 | §2.3, T8 | Yes |
| S4-PERMISSION-06 | §2.3, decorations asserted in the widget test (§4.3) | Yes |
| S4-PERMISSION-07 | §2.3 | Yes |
| S4-PERMISSION-08 | §2.3 | Yes |
| S4-PERMISSION-09 | §2.3 | Yes |
| S4-PERMISSION-10 | §2.3 | Yes |
| S4-PERMISSION-11 | §2.3 | Yes |
| S4-PERMISSION-12 | §2.3, T3 | Yes — the real OS prompt in §4.9 step 2 |
| S4-PERMISSION-13 | §2.3, T8 | Yes |
| S4-PERMISSION-14 | §2.3, T6 | Yes |
| S4-PERMISSION-15 | §3.16, §3.20, `ios_project_test` | Partly — file review only; no macOS, no iOS build in the MVP |
| S4-LISTENING-01 | §3.15, §4.7 step 4 | Yes |
| S4-LISTENING-02 | §3.15, §3.20 | Yes |
| S4-LISTENING-03 | §3.4 `ClipSettings` | Yes |
| S4-LISTENING-04 | §3.15 | Yes |
| S4-LISTENING-05 | §2.4, T12 | Yes |
| S4-LISTENING-06 | §2.4 | Yes |
| S4-LISTENING-07 | §2.4 | Yes |
| S4-LISTENING-08 | §2.4 | Yes |
| S4-LISTENING-09 | §2.4 | Yes |
| S4-LISTENING-10 | §2.4 | Yes |
| S4-LISTENING-11 | §2.4 | Yes |
| S4-LISTENING-12 | §2.4, T12 | Yes |
| S4-LISTENING-13 | §2.12 T11 | Yes |
| S4-LISTENING-14 | §2.6, T16, T17 | Yes |
| S4-RENDERER-01 | §3.13, `source_scan_test`, fixture widget tests | Yes |
| S4-RENDERER-02 | §3.13 | Yes |
| S4-RENDERER-03 | §3.13 | Yes |
| S4-RENDERER-04 | §3.12 | Yes |
| S4-RENDERER-05 | §3.12 R1, §3.13 | Yes |
| S4-RENDERER-06 | §3.13 | Yes |
| S4-RENDERER-07 | §3.13 | Yes |
| S4-RENDERER-08 | §3.13 | Yes |
| S4-RENDERER-09 | §3.13 | Yes |
| S4-RENDERER-10 | §2.6, §3.13, §3.14 | Yes |
| S4-RENDERER-11 | §3.13, §4.8 API test, §4.9 step 5 | Partly — the full portal-to-phone run is manual |
| S4-RENDERER-12 | §3.12, §4.4 | Yes |
| S4-LINKS-01 | §3.14 | Yes |
| S4-LINKS-02 | §3.14 | Yes |
| S4-LINKS-03 | §3.14 | Yes |
| S4-LINKS-04 | §3.14 | Yes |
| S4-LINKS-05 | §3.14, §3.21 (shared builder changes first), S4-D16 | Yes |
| S4-LINKS-06 | §3.14 (external browser, gap 15) | Yes |
| S4-LINKS-07 | §3.14 | Yes |
| S4-LINKS-08 | §3.14 | Yes |
| S4-LINKS-09 | §3.14 | Yes |
| S4-LINKS-10 | §3.14 | Yes |
| S4-LINKS-11 | §2.6 sheet, §3.14 | Yes |
| S4-LINKS-12 | §3.14 | Yes |
| S4-LINKS-13 | §3.14, `android_project_test`, §4.9 step 4 | Partly — the ATD emulator has no dialler or browser; opening targets is checked on the phone |
| S4-RESULT-01 | §2.6 | Yes |
| S4-RESULT-02 | §2.6 | Yes |
| S4-RESULT-03 | §2.6, decorations asserted in the widget test (§4.3) | Yes |
| S4-RESULT-04 | §2.6 banner box | Yes |
| S4-RESULT-05 | §2.6 client row | Yes |
| S4-RESULT-06 | §2.6 | Yes |
| S4-RESULT-07 | §2.6 | Yes |
| S4-RESULT-08 | §2.6, S4-D1 | **No** — the answer has no offer-text field; deferred until the card builder adds one (gap 6; Q5) |
| S4-RESULT-09 | §2.6 | Yes |
| S4-RESULT-10 | §3.13 order | Yes — needs the user's confirmation (gap 16; Q5) |
| S4-RESULT-11 | §2.6 | Yes |
| S4-RESULT-12 | §2.6 | Yes |
| S4-RESULT-13 | §2.6 | Yes |
| S4-RESULT-14 | §2.6, S4-D20 | Yes |
| S4-RESULT-15 | §2.6 at 320 dp | Yes — no footer exists in Step 4 (S4-D1) |
| S4-RESULT-16 | §2.6 | Yes |
| S4-RESULT-17 | §2.6 | Yes — as RESULT-15 |
| S4-RESULT-18 | §2.6, `source_scan_test` | Yes |
| S4-NOMATCH-01 | §2.8, §4.7 | Yes |
| S4-NOMATCH-02 | §2.8 | Yes |
| S4-NOMATCH-03 | §2.8 | Yes |
| S4-NOMATCH-04 | §2.8 | Yes |
| S4-NOMATCH-05 | §2.8 | Yes |
| S4-NOMATCH-06 | §2.8 | Yes |
| S4-NOMATCH-07 | §2.8, T36 | Yes |
| S4-NOMATCH-08 | §2.8, T38 | Yes |
| S4-BUSY-01 | §2.9, T20, T30, §4.7 | Yes |
| S4-BUSY-02 | §2.9, T33 | Yes |
| S4-BUSY-03 | §2.9 | Yes |
| S4-BUSY-04 | §2.9 | Yes |
| S4-BUSY-05 | §2.9 | Yes |
| S4-BUSY-06 | §2.12 T30, S4-D7 | Yes |
| S4-BUSY-07 | §2.9 | Yes |
| S4-BUSY-08 | §2.9, §3.8 | Yes |
| S4-BUSY-09 | §2.9 | Yes |
| S4-BUSY-10 | §2.9 | Yes |
| S4-BUSY-11 | §2.9, T32 | Yes |
| S4-BUSY-12 | §2.9, T33, §3.15 | Yes |
| S4-ERROR-01 | §2.10, §3.11, §4.7 | Yes |
| S4-ERROR-02 | §2.10 | Yes |
| S4-ERROR-03 | §2.10 | Yes |
| S4-ERROR-04 | §2.10 | Yes |
| S4-ERROR-05 | §2.10, S4-D32 | Yes — the support WhatsApp link needs the number, asked for at the gate (Q1) |
| S4-ERROR-06 | §2.10, S4-D9 | Yes |
| S4-ERROR-07 | S4-D9, §4.7, §4.8, §4.9 step 7 | Partly — part 3 is the manual phone record |
| S4-ERROR-08 | §3.8 API id | Yes |
| S4-ERROR-09 | §2.10, T40 | Yes |
| S4-ERROR-10 | §2.10, T36 | Yes |
| S4-ERROR-11 | §2.10, T38 | Yes |
| S4-ERRORHANDLING-01 | §2.1, §3.8, `expectNoTechnicalText` | Yes |
| S4-ERRORHANDLING-02 | §3.11, S4-D13 | Yes |
| S4-ERRORHANDLING-03 | §3.11 "when a code may be shown" | Partly — via S4-ERROR-07 (manual part) |
| S4-ERRORHANDLING-04 | §3.19 | Yes |
| S4-ERRORHANDLING-05 | §3.19 | Yes |
| S4-ERRORHANDLING-06 | §2.11, §3.19 | Yes |
| S4-ERRORHANDLING-07 | §3.19 | Yes |
| S4-ERRORHANDLING-08 | §2.10, §3.7 flags | Yes |
| S4-ERRORREPORTING-01 | §3.19, §4.7 | Yes |
| S4-ERRORREPORTING-02 | §3.19 | Yes |
| S4-ERRORREPORTING-03 | §3.19 | Yes |
| S4-ERRORREPORTING-04 | §3.19 | Yes |
| S4-ERRORREPORTING-05 | §3.19 | Yes |
| S4-ERRORREPORTING-06 | §3.19 (`relatedRequestId`; the report's own `X-Request-Id`) | Yes |
| S4-ERRORREPORTING-07 | §2.2 dev control, §4.7 | Yes |
| S4-ERRORREPORTING-08 | §3.11, §3.19, §4.8, §4.9 step 7 | Partly — part 3 is the manual phone record |
| S4-PRIVACY-01 | §3.17, T13 | Partly — background is simulated with a lifecycle event in tests; a real home-button press is in §4.9 step 8 |
| S4-PRIVACY-02 | §3.15, §3.17, `source_scan_test` | Yes |
| S4-PRIVACY-03 | §3.15, §3.17 | Yes |
| S4-PRIVACY-04 | §3.8, §3.19 | Partly — a production-flavour logcat run needs an HTTPS server (first staging deploy, P8); checked here on a development build in release mode with verbose logs off, plus the scan |
| S4-SECURITY-01 | §3.7, `source_scan_test` | Yes |
| S4-SECURITY-02 | §3.7, `android_project_test`, §4.7 step 5 | Yes |
| S4-SECURITY-03 | §3.21 docs | Yes (gate) |
| S4-COMPATIBILITY-01 | §3.3, §4.7 (ATD without Play services) | Partly — no real Huawei phone; the AOSP image stands in |
| S4-ACCESSIBILITY-01 | §2.1, §4.3 | Yes |
| S4-ACCESSIBILITY-02 | §2.1, §4.3 | Yes |
| S4-ACCESSIBILITY-03 | §2.4, `source_scan_test` | Yes |
| S4-ACCESSIBILITY-04 | §3.18 motion, `source_scan_test` | Yes |
| S4-ACCESSIBILITY-05 | §2.4 | Yes |
| S4-ACCESSIBILITY-06 | §2.2 | Yes |
| S4-ACCESSIBILITY-07 | §2.3 | Yes |
| S4-ACCESSIBILITY-08 | §2.4 | Yes |
| S4-ACCESSIBILITY-09 | §2.6 | Yes |
| S4-ACCESSIBILITY-10 | §2.6 | Yes |
| S4-ACCESSIBILITY-11 | §2.8–§2.10 | Yes |
| S4-ACCESSIBILITY-12 | §2.8 | Yes |
| S4-USABILITY-01 | §2.1 (only Back and Close are icon-only) | Yes |
| S4-USABILITY-02 | §2 wording, S4-D1, S4-D21, S4-D32 | Partly — "share this code with support" is backed by the WhatsApp link once the number is given (Q1) |
| S4-THEME-01 | §3.18 | Yes |
| S4-THEME-02 | §3.18 | Yes |
| S4-THEME-03 | §3.18, `source_scan_test` | Yes |
| S4-THEME-04 | §3.18 | Yes |
| S4-THEME-05 | §3.18 | Yes |
| S4-RESPONSIVE-01 | §2.1, §4.3 | Yes |
| S4-RESPONSIVE-02 | §2.1, §4.3 | Yes |
| S4-RESPONSIVE-03 | §2.1 | Yes |
| S4-RESPONSIVE-04 | §2.1, §2.6 (buttons are full-width rows; no side-by-side rows exist; `Wrap` for the footer line in §2.3) | Yes |
| S4-RESPONSIVE-05 | §2.1 | Yes |
| S4-PERFORMANCE-01 | §4.5 lints | Yes |
| S4-PERFORMANCE-02 | §4.5 scan | Yes |
| S4-PERFORMANCE-03 | §2.6 banner, §4.5 scan | Yes |
| S4-NAMING-01 | §3.1, §4.5 | Yes |
| S4-NAMING-02 | §3.4 | Yes |
| S4-NAMING-03 | §3.4 | Yes |
| S4-NAMING-04 | §3.1 | Yes |
| S4-NAMING-05 | §4.5 | Yes |
| S4-TESTS-01 | §3.5, §4.1 | Yes |
| S4-TESTS-02 | §2.12, `recognition_flow_test` | Yes |
| S4-TESTS-03 | §4.1, §4.4 | Yes |
| S4-TESTS-04 | §4.7 | Yes |
| S4-TESTS-05 | §4.6 | Yes |
| S4-TESTS-06 | §4.6 | Yes |
| S4-TESTS-07 | §4.7 step 1–2 | Yes |
| S4-TESTS-08 | §4.7 step 3 | Yes |
| S4-TESTS-09 | §4.9 | **No** — needs the user's phone and a sideload; the user runs it with the agent's script |
| S4-TESTS-10 | §4.9, S4-D30, §3.21 docs | Yes — through a tunnel (Q3) |
| S4-SLICEVERIFY-01 | §4.10 step 3 | Yes (current script names; gap 49) |
| S4-SLICEVERIFY-02 | §4.10 steps 1–2 | Yes |
| S4-SLICEVERIFY-03 | §4.10 step 1 | Yes |
| S4-SLICEVERIFY-04 | §4.10 step 3 | Yes |
| S4-SLICEVERIFY-05 | §4.7, Step 3's API end-to-end test, §4.9 step 3 | Partly — part 3 is manual |
| S4-SLICEVERIFY-06 | §3.14 test, §4.9 step 4 | Partly — the dialler opening is manual |
| S4-SLICEVERIFY-07 | §3.14 test, §4.9 step 4 | Partly — manual |
| S4-SLICEVERIFY-08 | §3.14 test, §4.9 step 4 | Partly — manual |
| S4-SLICEVERIFY-09 | §4.7 busy scenario, Step 3's 503 log test, §4.9 step 6 | Partly — the real-API run is manual |
| S4-DESIGN-01 | S4-D28 | Partly — built in the wireframes' style; the user reviews screenshots at the gate |

Count: 235 mapped (SCOPE 6, STACK 9, STRUCTURE 8, STATE 14, INSTALLS 4, REQUEST 6, HOME 9,
PERMISSION 15, LISTENING 14, RENDERER 12, LINKS 13, RESULT 18, NOMATCH 8, BUSY 12, ERROR 11,
ERRORHANDLING 8, ERRORREPORTING 8, PRIVACY 4, SECURITY 3, COMPATIBILITY 1, ACCESSIBILITY 12,
USABILITY 2, THEME 5, RESPONSIVE 5, PERFORMANCE 3, NAMING 5, TESTS 10, SLICEVERIFY 9, DESIGN 1).
Fully verifiable here: 214. Partly: 19. No: 2 (S4-RESULT-08, S4-TESTS-09).

---

## 6. Decisions

| # | Decision | Why |
|---|---|---|
| S4-D1 | **Step 4 leaves out the parts of the wireframed screens that belong to later phases**: Home's bottom navigation and "My station" chip; the Permission screen's offline bullet; the Result footer ("Saved to History", "Report this"); the Result offer text (no data field; S4-RESULT-08 deferred until the card builder adds one); the Listening ring's tap-to-finish. Nothing replaces them; the Home instruction line is the first-open note. | S4-SCOPE-05 forbids half-built History, Settings, My station, offline and reporting; dead tabs or a false offline promise would break S4-USABILITY-02 (gaps 2, 3, 6, 30, 44). |
| S4-D2 | **Layers**: calls flow presentation → domain → data; presentation may use repositories and providers but never Dio, the local store, the recorder, permission or launcher packages, or `dart:io`; domain is pure Dart; data never imports presentation. Shared infrastructure lives in `lib/core/`; the features are `identify` and `result`. | Makes S4-STRUCTURE-03 checkable by a test; the common Riverpod feature-first shape without a use-case layer (ALL-STRUCTURE-06). |
| S4-D3 | **Dependencies**: the seven pins plus `path_provider` 2.1.6 (already cached; `record` needs a file path); test tools from the SDK; no code generation, no `uuid` package, no font files. | Fewest downloads on a metered line, every package checked on 3.41.9, nothing the plan did not ask for. |
| S4-D4 | **State model**: `RecognitionFlow` is a `Notifier` over the sealed nine-state `RecognitionState`; the error state carries a sealed `RecognitionFailure` with six variants; registration is one shared `Future` inside `ListenerInstallRepository` (behind a plain `Provider`), not an `AsyncNotifier`; Riverpod 3's automatic retry is switched off app-wide. | One channel for waiting and failure; each state holds only its own data; concurrent callers share one registration and no screen shows its state, so an `AsyncValue` would hold nothing anyone reads; an automatic provider retry would resend clips silently. |
| S4-D5 | **Navigation follows the state**: go_router's `redirect` maps each state to one route (exhaustive switch); screens only call the notifier; every move replaces the page; system back goes through the notifier. | Screen and state can never disagree; Back always leads Home. |
| S4-D6 | **Recorder**: AAC-LC, 16 kHz, mono, 24 kbit/s, noise suppression, automatic gain and echo cancellation off, `mic` source, Bluetooth not managed, other audio left playing (S4-D34), no recording service; Android minimum SDK 24. | The Phase 0 capture app's settings and ADR-001's measurement (25.7 kB per 8 s); `record_android` 1.5.2 needs SDK 23, and `url_launcher` and `shared_preferences` need 24 (gaps 40, 41). |
| S4-D7 | **Clip lifetime**: recorded to `<cache>/clips/<key>.m4a`, read into memory and the file deleted at once; leftovers swept at start and on Home; the in-memory clip is kept only while uploading, busy or "no connection", and dropped on every outcome and way out. | "We don't keep the recording" and "We kept your clip" are both true; a crash leaves no file (gap 35). |
| S4-D8 | **Request times and fields**: `captured_at` is the wall-clock start of recording, `sent_at` is taken just before each send, `is_deferred` is `false`, no `station_hint`, field order text first and `audio` last, file `clip.m4a`, type `audio/mp4`. | Matches the contract; the server corrects clock skew from `sent_at` (S3-D15). |
| S4-D9 | **Request ids and reference codes**: a new version-4 UUID per HTTP attempt; the reference code is the first 8 hex digits of the API's id, upper case, as `XXXX-XXXX` (e.g. `6F1C-2D3E`); support finds the line by searching for a `requestId` starting with those digits; a code is shown only for an id the API echoed or for an accepted crash report; a shared helper and fixture in `packages/contracts`. | Short enough to read out, needs no server change, and never shown when no log line exists (gap 9; S4-ERRORHANDLING-03). |
| S4-D10 | **Every answer and network failure maps to a screen** as in §3.11: 503/502/504 → Busy; 409 and 401 handled silently once or twice; 429 → "Too many tries"; 400 `INVALID_AUDIO` → "We couldn't use that recording"; no answer → "No connection" with "Send again"; `CHOOSE_STATION`, unknown statuses and 426 → "This needs a newer Look Up"; everything else → the wireframe's Error with its code. | Gap 10 asks for exactly this; `RECOGNITION_TIMEOUT` is Busy because the API says "try again" (S3-D17, S3-D23). |
| S4-D11 | **Retry limits**: at most 4 sends of one clip on busy answers ("Try now" included), then Error; at most 2 waits after 409; one re-registration after 401; `Retry-After` clamped to 1–60 s with defaults 10 s (busy, 429) and 3 s (409). | Bounds the waiting, stays under the 6-a-minute install limit, and stops a bad header from freezing the screen (gap 11). |
| S4-D12 | **Network**: connect 15 s, send 30 s, receive 15 s; a network failure to get an answer (no connection, a timeout, a dropped connection) is "no connection", and the clip is kept so it can be resent with the same key (a replay if the server had it). A request the phone itself stopped (a fault in the app, or plain `http` refused outside development) is the phone failure, reported with the fault's type name only, and the clip is dropped (§3.11). | Fits an 8 s clip on slow 2G; the idempotency key makes resending safe. Resending cannot cure a fault on the phone, and calling it "No connection" would hide it from the developers. |
| S4-D13 | **The app never shows the API's `message`**; it maps each code to its own wording, and unknown codes to the generic Error. | Stricter than the rule allows, and ready for Bemba and Nyanja (gap 23). |
| S4-D14 | **Installs**: register in the background on first launch and again only when the token is missing, near expiry or refused; one registration at a time; install id, token and expiry in `shared_preferences` with Android backup off; no integrity verdict in Step 4. | The token only allows rate-limited recognitions; a secure-storage plugin is unpinned and unreliable on low-end phones; Play Integrity needs a Google Cloud project and a store listing that do not exist (gap 12; S3-INSTALLS-10, -12 stay open; Q4). |
| S4-D15 | **Reading answers**: required are `status` and, for `MATCH`, a readable result (station name and frequency, client name, title, card); unknown fields are ignored and never shown; images only from `https`; unknown kinds read as a campaign, unknown statuses as "newer app needed". | An older app keeps working against a newer server, and nothing internal can reach the screen. |
| S4-D16 | **Map buttons open Google Maps directions** — `https://www.google.com/maps/dir/?api=1&destination=<lat>%2C<lng>`, six decimals — and the shared TypeScript builder and fixtures change first; the portal's pin-check link keeps a search address through a separate helper; the portal's link parser accepts both. | Conflict 19 and S2-BUTTON-ADDRESSES-04; a station checking a pin wants the pin. |
| S4-D17 | **The Dart reader and builders mirror the TypeScript ones rule by rule**, with the canonical-link check written out and pinned by a new shared fixture whose answers come from the real `new URL`, plus fixtures for the known traps (`1.0`, U+0085, `-0.0`, an unencodable text). | The two languages differ in exactly these places; one fixture set keeps the app, the portal preview and the API in step. |
| S4-D18 | **"More options" is built in Step 4**: four buttons, then a "More options" control that reveals the rest in place. | The shared reader and its fixtures split the actions this way; without it a 5- or 6-button card would render differently from the portal preview (P6-RESULT-03 built early). |
| S4-D19 | **Opening buttons**: external application for all four types; on failure a sheet offers "Copy number" (call, WhatsApp) or "Copy link" (map, link). | No in-app web view to secure; works on phones without Google Play; gap 15. |
| S4-D20 | **Result rendering**: labels longer than 32 code points show 31 and "…", the full label for screen readers; shorter labels are shown whole and may wrap at large text sizes; icons are dropped below 360 dp; no banner box without a banner; the screen scrolls. | Satisfies both the reader rule (long labels shown) and "no clipped text" (S4-RESPONSIVE-03); Result320 drops icons (gap 14). |
| S4-D21 | **Default card and newer-app states**: the fallback is the Result layout with "This ad isn't on air right now, so these are [client name]'s usual contact details."; the haptic tick fires for both matched and fallback; update messages are statements ("Some buttons need a newer version of Look Up.") with no update control until a store listing exists. | Gaps 27 and 29; S4-USABILITY-02 forbids instructions without a control. |
| S4-D22 | **Permission variants**: not asked yet, refused once, refused for good (with "Open phone settings" as the primary button); only "Allow microphone" asks the system; `record.hasPermission()` is never called; coming back from settings with access goes to Home without recording. | Gap 31; recording only ever follows a fresh tap. |
| S4-D23 | **Lifecycle**: hide or pause during recording cancels and discards; during Busy the countdown pauses, and so does the wait after a 409, each going on when the app is shown; `inactive` alone changes nothing. | "Never in the background"; no surprise sends from a backgrounded app. |
| S4-D24 | **Theme**: a Dart generator turns `tokens.json` into one `ThemeExtension`; `ColorScheme.fromSeed(accent)` with the exact token colours copied over; light theme only; the system font; three new type tokens (`headline`, `cardTitle`, `cardTitleCompact`); nearest token for in-between wireframe values. | No hand-written design values, no drift, no font download (gap 22); the tokens gain the sizes the wireframes use (ALL: wireframes and tokens in sync). |
| S4-D25 | **Flavours and cleartext**: Gradle product flavours plus `--dart-define-from-file`, which must agree; `http` refused in Dart outside development, with Android's cleartext settings as the second line; fail-closed start-up. | Dart's HTTP client cannot be relied on to obey Android's network-security configuration, so the manifest alone would not enforce S4-SECURITY-02. |
| S4-D26 | **Crash reports and logs**: the four global handlers report to `/client-errors` with the report's own request id, no token, text scrubbed on the phone, at most one per error a minute and 10 a minute, never throwing; `presentError` and all logging only in development with the verbose flag; a development-only "Send a test error" control. | "Client crashes must reach the developer", no PII in reports or the device log, and the P6-TESTS-13 throw check can run at the S4 gate. |
| S4-D27 | **Contract additions** (§3.21): directions fixtures, canonical-link fixture, trap fixtures, reference-code helper and fixture, envelope fixtures, a recognize-request fixture and an emitted client-error-report schema. | The app is tested against shared files, never copies (S4-TESTS-03); every body the app sends gets a schema. |
| S4-D28 | **States with no wireframe are built first and reviewed at the gate**: Identifying, the fallback card, Permission refused once and for good, the five Error variants, the copy sheet, "More options", and every Step 4 screen at 320 dp are built in the wireframes' style with the wording in §2; the user reviews screenshots at 360 and 320 dp at the Step 4 gate, and any change is made before the gate closes. | The user's choice (8 October 2026): nothing waits on an approval before the gate; S4-DESIGN-01 is checked at the gate. |
| S4-D29 | **Fake API and emulator runner**: a standard-library Python fake on `127.0.0.1:3999` answering with the shared fixtures, strict about requests, with a scenario queue and a request log; the runner refuses to start while Docker runs and uses the `lookup_test` ATD device. | S4-TESTS-04 to -08; the fake cannot drift from the contract; Docker and the emulator never run together. |
| S4-D30 | **Phone to PC through an ngrok tunnel** (the user's choices, 8 October 2026): ngrok gives the API on port 3100 the user's fixed public `https` address, so the phone APK is built once; the phone build is the development flavour addressed to it, so the phone sends no plain http; cleartext stays only for the emulator's `10.0.2.2`. ngrok is an 11.7 MB download with a free account, asked for when the phone check is run, and runs only during the session, because it exposes the local API to the internet. | Works whatever network the phone and the PC are on; cloudflared needs no account but changes its address every run, and the address is built into the app. |
| S4-D32 | **Support on WhatsApp**: the Error screen's failure variants offer "Message support on WhatsApp" with the reference code filled in, when the build defines `LOOKUP_SUPPORT_WHATSAPP_NUMBER`; the link is built by the same WhatsApp address builder as the card's buttons; without a number the link is hidden. Staging and production builds refuse to start without a number (§3.7), so only a development build can ever lack it. | The user chose WhatsApp (8 October 2026); the number is asked for at the gate, so the code is never shown with a promise of support that cannot be reached. |
| S4-D33 | **Stack corrections from the check against this PC** (the user approved, 8 October 2026): `permission_handler` 12.0.3, not 13.0.2, whose Android part needs compile SDK 37 and an Android Gradle Plugin newer than Flutter 3.41.9 supports ("refused for good" is read from the result of `request()`); no `integration_test` and no debug or profile builds, because only the release engines are cached (about 114 MB for the emulator's debug engine): emulator tests drive the release APK with `adb` and `uiautomator`; the plugins' unused Gradle plugin and Kotlin versions are pointed at the cached ones; the clip is 24 kbit/s, because at 32 kbit/s the request passes 32 KB. | Keeps the first build to about 25–30 MB of downloads, with no new toolchain, on Flutter 3.41.9 as installed (S4-STACK-01); S4-STACK-07's pin is changed with the user's approval. |
| S4-D31 | **"About 25 KB of data" means the clip upload** (the recognize request), measured at about 26 KB; the answer (2–3 KB) and connection overhead are not counted; the measured total is recorded at the gate, and the wording is revisited if it exceeds 35 KB. | Gap 21; keeps the wireframe wording true for what it describes. |
| S4-D34 | **Recording leaves other audio playing** (review, 8 October 2026): `audioInterruption: AudioInterruptionMode.none`; on iOS `IosRecordConfig(categoryOptions: [mixWithOthers, defaultToSpeaker])`, without `allowBluetooth`. A call still ends the recording, because the call screen hides the app (T13). Replaces "interruptions pause" in S4-D6. | Listeners mostly hear the station on the same phone. With `pause`, `record_android` 1.5.2 takes the audio focus for good, which pauses the radio app or stream: the clip is near-silent and the radio stays paused. iOS's default session does not mix with other audio, and its default `allowBluetooth` would record from a headset's microphone instead of the phone's (§3.15). |

---

## 7. The user's answers (8 October 2026)

1. **Q1 — Support channel: a WhatsApp number.** The Error screen offers "Message support on
   WhatsApp" (S4-D32). The number was not given yet: it is a build setting, asked for at the gate;
   until then the link is hidden and S4-USABILITY-02 stays open with this reason.
2. **Q2 — Screens with no wireframe: build them, review at the gate.** They are built in the
   wireframes' style with the wording in §2 and reviewed as screenshots at 360 and 320 dp (S4-D28).
3. **Q3 — Phone to PC: a tunnel, ngrok** (S4-D30). ngrok is an 11.7 MB download with a free account,
   asked for when the phone check is run; the phone model and Android version are asked for then too.
6. **Also on 8 October 2026**: `permission_handler` 12.0.3 instead of 13.0.2, and the emulator tests
   on the release APK driven by a script instead of `integration_test` (S4-D33).
4. **Q4 — No Play Integrity in Step 4**: decided at hardening (P8), a soft signal (O10) (S4-D14).
5. **Q5 — The four choices are confirmed**: buttons keep the card's order (the card builder puts the
   primary first); the map button opens directions; "via <station>" sits under the brand name, above
   the title; the offer text waits for a card field (S4-RESULT-08 deferred).

---

## 8. Items in other parts of the checklist this step touches

- **S2-BUTTON-ADDRESSES-04** (part 1): closed by the directions change (S4-D16).
- **S3-ARCHITECTURE-09** (part 2): the app half — the request has no fingerprint field and the app
  has no fingerprint code (§3.10, `source_scan_test`).
- **S3-RESPONSE-15** (part 2): the app half — the app parses the shared response fixtures (§4.4).
- **S3-INSTALLS-10, -12** (part 2): stay open; the integrity verdict is deferred (S4-D14, Q4).
- **P6-RESULT-03**: built early (S4-D18). **P6-ACCESSIBILITY-01**'s labelled-tap-target guideline
  runs from Step 4 (§4.3). **P6-TESTS-13**'s debug throw runs first at this gate (S4-ERRORREPORTING-07).
- **Security baseline**: "The app builds call, WhatsApp and map links itself from validated fields"
  and "Client crashes … reach the developers" move to Built for the app with the named tests
  (S4-SECURITY-03); new rows for token storage and backup, cleartext only in development, clip
  lifetime and no background recording.
- **ALL rules**: no use-case layer, no BLoC, no swallowed exit codes, dependencies checked on 3.41.9,
  heavy commands one at a time without Docker, download sizes stated first, wireframes and tokens in
  sync (S4-D24, S4-D28), detailed errors only behind a development flag.

## Gate record (9 October 2026)

**Test runs** on the build machine; the compose Postgres, Valkey and object storage were up for the
API runs, and no emulator was running then. Flutter is the installed 3.41.9 (Dart 3.11.5), never
upgraded (S4-STACK-01).

| Suite | Result |
|---|---|
| Listener app (`flutter test`) | 1,534 passed, 0 skipped; `flutter analyze` clean; `dart format` changes nothing |
| Listener app tools (fake API, emulator driver; `unittest`) | 56 passed |
| API (vitest, real Python workers in `fingerprint-workers.test.ts`) | 38 files, 551 passed, 0 skipped |
| Contracts (vitest) | 15 files, 480 passed |
| Portal (vitest) | 44 files, 657 passed; typechecks clean |
| Fingerprint service (pytest) | 189 passed, 0 skipped |
| Evidence checker | every ticked requirement names a test that exists |

**Emulator run** (release APK on the `lookup_test` device, Android 13, against the fake API, Docker
closed): 15 of 16 steps passed on the final build — first launch registers once; Home → Permission →
the system dialog → Listening → Result; the copy sheet when a call cannot open; no match; Busy on
screen, then the automatic retry with one idempotency key; the reference code of the echoed request
id; No connection, then "Send again"; a crash report reaching `/client-errors`; no second
registration after a restart; every recognize request at most 32,768 bytes with a real clip (28–31
KB); a production build given an `http://` address refuses to start and sends nothing. The clip
check failed at 9.02 s against the strict 7.5–8.5 s window: the emulator's virtual microphone hands
the recorder more audio than real time (the device log shows the recorder ran 8.1 s of wall-clock
time), so the emulator now allows up to 10.5 s and the strict window moved to the phone (§4.7, §4.9).
The device-log privacy step (S4-PRIVACY-04) was added after that run and still has to run on the
emulator, which needs Docker closed.

**Screens for review** (S4-D28, S4-DESIGN-01): 49 screenshots of every state at 360 and 320 dp, and
at text scale 2.0, published for the user:
https://claude.ai/artifact/AeGE7FppiVxBFJ6qkz5hHw. The user's answers are recorded here when given.

**The slice running** (S4-SLICEVERIFY-04): the API answered `GET /api/v1/health` with 200, the portal
answered on http://localhost:5180, and both workers ran two jobs at a time with fresh heartbeats.
Not done here: a run from a fresh database volume (S4-SLICEVERIFY-01), which would erase the
development data; continuous integration starts from a fresh database on every run (deploy phase).

**Found and fixed at the gate**: recording took the phone's audio focus and would have paused a
radio playing on the same phone (S4-D34); a recorder that broke mid-recording was noticed only
after 8 seconds; faults on the phone showed as "No connection"; images could be redirected to http;
Result was silent for screen readers; the ring jumped between Listening and Identifying; the
identify disc shrank its words at large text; the copy sheet and snack bars used Material's default
timings; a shared fixture held invisible characters unescaped; an engine rule test matched its own
source once committed.

**Open at this gate**, each with its reason in the checklist: the run on the user's phone (ngrok, the
phone model, S4-TESTS-09, S4-SLICEVERIFY-05 to -09) and the support WhatsApp number (S4-USABILITY-02);
the device-log privacy step on the emulator (S4-PRIVACY-04); the offer text, which waits for a card
field (S4-RESULT-08); and the review items checked at the gate above.

### After the gate (10 October 2026)

**Emulator runs 4 and 5** (Docker closed, the APKs of 8 October, which are newer than the last app
change):
- **Run 4: 16 of 17 steps passed.** The device-log privacy step passed (16,467 lines read). The clip
  check passed within the emulator's 10.5 s allowance.
- **The run 4 failure.** "No match" showed "No connection": the stand-in had read the whole request,
  and the app's screen changed 0.25 s after the recording ended, too soon for a timeout. The device
  log shows the emulator was overloaded at that moment (frames taking about 800 ms), and the
  stand-in's code and the no-match fixture had not changed since run 3.
- **Run 5: all 17 steps passed**, including "no match" and the privacy step (15,331 lines). The run 4
  failure is therefore recorded as a one-off connection drop inside the emulator. If it comes back,
  the next step is to make the app record the failure's type in the run's evidence.
- S4-PRIVACY-04 is ticked on these runs.

**Walkthrough with the user** (S4-D28):
- **The station website and the emulator app, shown live.** The emulator's window froze twice. The
  first freeze was in its host-GPU drawing. The second came after a link button opened the
  test image's blank stand-in browser (`com.android.fakesystemapp`), which the window did not
  repaint. Software drawing (`-gpu swiftshader_indirect`) and pressing Back over adb recovered it.
  Neither is an app fault: the automated-test image has no browser, WhatsApp or Maps.
- **The user asked whose the sample phone numbers are.** `+260 97 712 3456` and
  `+260 96 612 3456` are invented, first typed into the shared fixtures on 5 October 2026, but they
  follow the real numbering plan. Replacing them with numbers that cannot reach anyone is
  proposed and not yet decided.

**The phone check** (§4.9), done in part, on the user's own phone:
- **Set-up.** Windows names the phone "POWER 80"; its Android version was not given. The
  development flavour, release mode, arm and arm64, was sideloaded over USB as a file, against the
  stand-in through an ngrok tunnel (ngrok 3.39.11, signature checked).
- **What passed:**
  - the install;
  - registration;
  - the real microphone dialog;
  - an 8-second clip of 27,332 bytes sent over https;
  - the Result with all four button types;
  - the user confirmed the dialler, WhatsApp, Maps and the browser opened ("everything checks
    out"). This is step 4 of §4.9, against the stand-in's card.
- **Not done yet:** steps 1, 3 and 5–8 against the real stack, and the strict clip-length check
  (step 9).
- **One thing to ask.** The phone registered twice with two different install ids; whether the
  app was reinstalled in between is to be asked.
