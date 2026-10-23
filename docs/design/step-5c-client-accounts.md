# Step 5c — Client accounts: advertisers follow their adverts, with air-time reminders

**Decision:** `docs/adr/ADR-006-client-accounts.md` (accepted 23 October 2026). **Requirements:**
`docs/requirements/checklist-4-portal-registration-dashboards.md` §P5C. **Built on:** phase 5a (portal accounts,
sessions, invitations, the notification queue), phase 5b (ads, campaigns, schedules, listener figures) and ADR-005
(listener groups by gender and age).

## 1. Decisions

| Id | Decision |
|---|---|
| CA-D1 | A client account is a portal account with one or more **client accesses** (person, client, station). Only a station grants one, by email invitation. |
| CA-D2 | The access is to the client: every advert of that client at that station, now and later, is visible. Nothing is linked by hand. |
| CA-D3 | One login for every station: a second station's invitation to the same email adds an access; accepting it needs only signing in. |
| CA-D4 | Read-only towards station data. A client changes only their own password, notification settings, muted adverts and devices. |
| CA-D5 | Client reads are SECURITY DEFINER functions checking the person's access (`app.current_user_id()`), returning only client-safe columns. No row-level-security policy for clients on station tables. |
| CA-D6 | One home page; each station is its own section with its own figures; nothing adds stations together. |
| CA-D7 | Figures for a client: identifications ("heard") and taps by button type (call, WhatsApp, directions, website), for today, the last 7 and the last 30 of the station's days; listener gender and age groups under ADR-005's rule (10 or more). |
| CA-D8 | Reminders name the time slot, never a minute; once per slot and person; 5, 15 or 30 minutes before (15 by default); only active campaigns at active stations; per-advert mute. |
| CA-D9 | Delivery by Web Push (VAPID) to each device the person turned on, and by email if chosen. Without push keys, push is off; email still works. |
| CA-D10 | Invitations by email (SMS once ADR-004's provider exists). Owners and managers invite and remove; analysts see who has access. |
| CA-D11 | The client area is its own code chunk at `/client`; the portal is installable (manifest, service worker) with the start page `/client`. |

## 2. Familiar patterns (so the screens explain themselves)

Each screen copies something people already use, first inside Look Up, then from well-known products:

| Screen | Works like |
|---|---|
| Station: **Manage access** to a client | Look Up's own Team page (same words: "Invite someone", "Pending invitations", "Cancel invitation", "Invitation sent. It works once and lasts 7 days."), shown as a dialog like Google Docs' **Share** box ("People with access" above, invite field below). |
| The invitation email and acceptance page | Look Up's team invitation, word for word where it can be, with "follow Brand A's adverts" in place of a role. |
| Access level | Called **Viewer** ("Can view Brand A's ads and results"), the name Google and Meta use for read-only access. |
| Client home | An ads-manager overview (Meta Ads Manager, Google Ads): a card per advert with a coloured status chip ("Live now", "Scheduled", "Ended") and its key numbers. |
| Advert page | The station's own ad page in Look Up (same Overview sections and words), without edit buttons. |
| Notification settings | A phone app's settings: one switch per channel, one choice for timing, one switch per advert, **Send a test notification** (as Slack and WhatsApp Business do). |
| Turning notifications on | The "soft ask": our own card explains first, and the browser's permission prompt appears only after the person taps **Turn on notifications**, never on page load. |
| Installing | The browser's standard **Install app** prompt on Android and computers; on iPhone the usual Share → **Add to Home Screen** steps. |

## 3. Screens and flows

### 3.1 Station (owner or manager; analysts see, without the buttons)

- **Clients page** (`/stations/:stationId/clients`): each client row gains an access line, "**2 people can view these
  ads**" or "**Nobody can view these ads yet**", and a **Manage access** button.
- **Manage access** dialog ("Who can view Brand A's ads"):
  - *People with access*: name, email, "Viewer", **Remove access** (asks first: "They stop seeing Brand A's ads straight
    away. You can invite them again later.").
  - *Pending invitations*: email, "Expires in 5 days" / "Expired", **Send again**, **Cancel invitation**.
  - *Invite someone*: email field, **Send invitation**; "Invitation sent. It works once and lasts 7 days."
- **Add a client** gains an optional field **Client's email** ("We'll invite them to view their ads"): adding the client
  sends the invitation in the same step.
- Errors in the station's words: the email already has access ("This person can already view Brand A's ads"), too many
  invitations today (the team limit), the station not approved yet.

### 3.2 Client (the invitee)

1. **Email**: "Station A (98.1 FM) has invited you to view Brand A's adverts on Look Up" → **Accept invitation**.
2. **Invitation page** (`/invitations/accept#…`): "Station A invited you to view **Brand A**'s adverts and how listeners
   respond to them." New email: **Create your account** (full name, password, the email shown and fixed). Known email:
   **Sign in to accept**. Wrong account signed in: "This invitation is for c***@example.com" with **Sign out**.
3. Lands on the **client home** (`/client`) with a first-time card: "**Get a notification before your ads air**" →
   **Turn on notifications** and **Install the app** (or iPhone steps).

### 3.3 Client area (phone first; one column up to 767 px, two from 1024 px)

- **Header**: "Look Up · Brand A" (or "Look Up" with the person's name when they follow several clients), **Menu**:
  Home, Notifications, Account, Sign out.
- **Home** (`/client`): one section per station, ordered by name:
  - "Station A · 98.1 FM" and **Next on air: Today 07:00–09:00** (or "Not scheduled").
  - *Last 7 days*: Heard, Calls, WhatsApp, Directions, Website (tiles; no combined totals across stations).
  - *Your ads on Station A*: a card per advert with title, status chip, schedule summary ("Mon–Fri · 07:00–09:00"),
    "until 31 Oct" / "ended 30 Sep", heard in 7 days; the card opens the advert.
  - **Download as spreadsheet (CSV)** for that station.
  - With no access left (all removed): "You can't view any adverts right now. Ask the station to invite you again."
- **Advert page** (`/client/stations/:stationId/ads/:adId`): title, status chip, client and station.
  - *When it airs*: dates and the week's slots (the station's `ScheduleFacts` wording) and **Next 5 times on air**.
  - *What listeners did*: Today / 7 days / 30 days; Heard; taps by button type as bars with a Chart/Table switch.
  - *Who is listening*: the station's section, reused (groups of 10 or more).
  - *What listeners see*: the card preview.
  - Note (`role="note"`): "View only. To change this ad or its buttons, contact Station A on +260 97 …".
- **Notifications** (`/client/notifications`):
  - *This device*: **Notifications on this device** switch (asks the browser when turned on; says plainly when the
    browser blocks them, and how to allow them).
  - *By email*: **Email me too** switch.
  - *When*: 5, 15 or 30 minutes before a time slot (radio buttons, 15 chosen at first).
  - *Adverts*: one switch per advert, grouped by station.
  - **Send a test notification**.
- **Account** (`/client/account`): change password (the existing page).

### 3.4 The reminder

- Push: title "Brand A on Station A", body "Summer service offer airs between 07:00 and 09:00 today. Listen to 98.1 FM to
  check it." Tapping opens the advert page.
- Email: the same words, with a button to the advert page and a line on how to change reminders.

## 4. Data

New migration `1792000000000-ClientAccounts` (released migrations never change):

- `app.client_viewers (client_id, station_id, portal_user_id, invitation_id, created_at)`; key (client_id, station_id,
  portal_user_id); composite reference to `app.clients (id, station_id)` and to `app.portal_users`, both cascading;
  index on `portal_user_id`. Row-level security on, no policy, no grant.
- `app.client_viewer_notification_settings (portal_user_id, is_push_on, is_email_on, lead_minutes, updated_at)`;
  `lead_minutes IN (5, 15, 30)`; a missing row means push on, email off, 15.
- `app.client_viewer_muted_ads (portal_user_id, station_id, ad_id, created_at)`; key on all three; reference to the ad.
- `app.web_push_subscriptions (id, portal_user_id, endpoint, endpoint_hash, receiver_public_key, authentication_secret,
  device_label, created_at, last_sent_at)`; `endpoint` https only, `endpoint_hash` unique (SHA-256); at most 10 per
  person (the oldest goes). No grant; never logged or returned.
- `app.air_time_reminders (portal_user_id, campaign_time_window_id, slot_starts_at, queued_at)`; key on the first three,
  so a slot is reminded once per person; rows older than 30 days are deleted by the reminder job.
- `app.invitations` (5a) already has the `CLIENT_VIEWER` kind and `client_id`.

Functions (SECURITY DEFINER, `search_path = pg_catalog, app, pg_temp`, EXECUTE for `lookup_api` only):

- Invitations: `create_client_viewer_invitation`, `revoke_client_viewer_invitation`, `remove_client_viewer`,
  `list_client_viewers` (for the station: people and pending invitations of one client), and new versions of
  `describe_invitation`, `accept_invitation_with_new_account`, `accept_invitation_for_signed_in_user` handling both kinds.
  Each change writes an `audit_events` row.
- Client reads (all check the person's access at an ACTIVE station; another client, station or advert looks like
  nothing): `list_client_viewer_accesses`, `list_client_viewer_ads`, `read_client_viewer_ad`, `read_client_viewer_figures`
  (heard and taps by button type, per ad and per day), `read_listener_mix_for_client_ad`, `list_client_viewer_export_rows`.
- The listener-mix body becomes one internal function with an explicit station (no EXECUTE for any role), called by the
  station's two functions and the client's one.
- Reminders: `list_due_air_time_reminders(now, horizon)` and `claim_air_time_reminder(...)` (inserts the sent row; false
  when it already exists).

## 5. Server

- Contracts in `packages/contracts/src/clients/client-viewer-schemas.ts`: inputs strict; answers typed; the button types
  as `CALL | WHATSAPP | MAP | LINK`; groups as in `listener-mix-schemas.ts`.
- Station routes (`StationAccessGuard`; OWNER/MANAGER change, any member reads):
  `GET /stations/:stationId/clients/:clientId/viewers`, `POST …/viewers/invitations` `{ email }`,
  `POST …/viewers/invitations/:invitationId/resending`, `POST …/viewers/invitations/:invitationId/revocation`,
  `DELETE …/viewers/:portalUserId`; `POST /stations/:stationId/clients` takes an optional `email`.
- Invitee routes: `/invitations/description`, `/invitations/acceptance-with-new-account`, `/invitations/acceptance`
  answer both kinds; the description says which.
- Client routes under `/client` (`ClientViewerGuard`: signed in, and for a station route an access there; else 404),
  in a `ClientViewerTransaction` (user id set, station id empty):
  `GET /client/home`, `GET /client/stations/:stationId/ads/:adId`, `GET …/ads/:adId/figures?range=`,
  `GET …/ads/:adId/listener-mix?range=`, `GET /client/stations/:stationId/export.csv?range=`,
  `GET|PUT /client/notification-settings`, `POST /client/push-subscriptions`, `DELETE /client/push-subscriptions/current`
  (by endpoint), `POST /client/test-notification`, `GET /client/push-public-key`.
- `GET /auth/me` adds `clientAccesses: [{ stationId, stationName, frequencyLabel, clientId, clientName }]`; the portal
  sends a person with client accesses and no station to `/client`.
- Error codes (catalogue + fixtures): `CLIENT_VIEWER_ALREADY_HAS_ACCESS` (409), `PUSH_NOT_AVAILABLE` (503),
  `PUSH_SUBSCRIPTION_NOT_VALID` (400); the existing `INVITATION_*` and `NOT_FOUND` codes otherwise.
- Rate limits: invitations as for the team (20 a day per station); push subscriptions 20 an hour per person; test
  notifications 5 an hour per person.

## 6. Reminders and push

- `AirTimeReminders` runs every minute through `repeatJob` (one API instance on Render; the unique reminder row keeps a
  second instance or a slow run from sending twice).
- Each run asks `list_due_air_time_reminders` for slot starts between now and now + 31 minutes: ACTIVE campaigns at ACTIVE
  stations, the slot's day inside the campaign's dates, worked out in the station's time zone (a slot past midnight
  belongs to its start day), joined to the client's viewers whose reminders are on and whose advert is not muted, where
  `slot start − lead ≤ now < slot start`. For each, `claim_air_time_reminder` then the queue: one push job per device
  (when push is on and configured), one email job (when email is on).
- The `push` channel in the notification worker sends with the `web-push` library (VAPID, `aes128gcm`), with a 12-hour
  time to live and urgency `high`; 404 or 410 deletes the device; other failures retry as the queue does.
- Portal: `public/manifest.webmanifest` (name "Look Up", short name, theme colour from the tokens, icons 192 and 512, start
  `/client`, display `standalone`) and `public/service-worker.js` (registered only from the client area, scope `/`;
  handles `push` and `notificationclick`; caches nothing).

## 7. Privacy and security

- A client sees their own client's adverts at stations that invited them, and nothing else: no other client, no listener,
  no engagement limits, no audio asset id, no internal notes, no station member.
- Listener groups only under ADR-005's rule (no breakdown below 10; small groups folded).
- Push endpoints and keys are secrets: no grant, no log line, never in an answer; the VAPID private key is a deploy secret.
- Emails, names and tokens never logged; invitation tokens stored as hashes, single use, 7 days.
- Every new failure path answers in the error envelope with the request id; leak tests on each.

## 8. Tests

- API: invitations (create, resend, cancel, accept new and signed in, expired, other email, reused, already has access),
  removal, audit rows; the access matrix over every route for a client session; isolation (another client, station,
  advert → 404; two stations separate); figures and CSV against seeded events; the mix rule; leak tests; logs free of
  emails and endpoints.
- Database: definer, pinned, EXECUTE for `lookup_api` only; no grants on the new tables; privileges registry updated.
- Reminders: fake clock across time zones, weekdays, slots past midnight, lead times, muting, paused campaigns,
  suspended stations, ended dates, two runs at once.
- Push: against a local fake push service (decryptable payload, 410 deletes); the service worker's handlers.
- Portal: every state of every new screen, axe on each, Playwright on phone and desktop: invite → Mailpit → accept →
  home → advert → notifications; tap sizes, focus, no sideways scroll at five widths; the station chunk never loads the
  client chunk.

## 9. Rollout

Push keys are optional: without them the client area, invitations and email reminders work. On Render: add
`WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY` (one pair from `npm run deploy:new-secrets -- WEB_PUSH_KEYS`) and
`WEB_PUSH_CONTACT_EMAIL`, deploy, then walk through on a phone with the live address.
