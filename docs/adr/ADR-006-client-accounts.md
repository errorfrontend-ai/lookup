# ADR-006: Client accounts — advertisers follow their adverts in an installable web app, with air-time reminders

- **Status:** Accepted by the project owner on 23 October 2026 (the request, four answers, and the plan).
- **Date:** 23 October 2026.
- **Deciders:** the project owner.
- **Design:** `docs/design/step-5c-client-accounts.md`. **Requirements:** `docs/requirements/checklist-4-portal-registration-dashboards.md`
  §P5C (prefix `P5C-`).

## Context

A station's **client** is the business that pays for an advert (for example "Brand A"). Until now only stations use
the portal, so a client cannot see whether their advert is scheduled, whether it airs, or whether listeners respond.
Phase 5c of the plan always meant to give clients a read-only view; the project owner asked on 23 October 2026 for it
to be built now, with three additions: onboarding that the **station alone** starts by sharing the client's email, the
client **linked automatically** to the adverts they pay for, and a **notification just before the advert's time slot**
so the client can listen and check. The same notifications are to carry stations' offers of new or cheaper slots later.

The owner chose, from options put to them:

- an **installable web app with push notifications** (over a separate Android app, a "for businesses" mode in the
  listener app, and web pages with email only);
- a reminder **before each time slot**, the client choosing 5, 15 or 30 minutes and turning reminders off per advert;
- **every station on one home page, each kept separate**, no combined totals;
- **slot offers next**, after this, on the same notifications.

## Decision

1. **A client account is a portal account** (email and password, the same sign-in as stations) holding one or more
   **client accesses**: "this person follows client C at station S". A station grants it by email invitation only;
   nobody can sign up as a client by themselves. The access is to the client, so every advert of that client at that
   station, now and later, is visible without linking anything by hand. A second station inviting the same email adds
   an access to the same account.
2. **Read-only towards station data.** A client can never create, change, schedule, pause or upload anything. The only
   things a client changes are their own: password, notification settings, muted adverts, and the devices that receive
   notifications.
3. **Client reads go through narrow database functions**, SECURITY DEFINER with a pinned search path and EXECUTE for the
   API role only, each checking the person's access (`app.current_user_id()`) and returning only what a client may see.
   No row-level-security policy on station tables is added for clients.
4. **Per station, never merged.** The home page lists every station the client follows, each in its own section with
   its own figures; no figure adds stations together.
5. **What a client sees:** their adverts with status, dates and time slots, the next times on air, the card listeners
   see, how many times each advert was identified, taps by button type (call, WhatsApp, directions, website), and the
   gender and age groups of listeners under ADR-005's small-group rule (groups of at least 10). Never a listener, never
   another client, never a station's engagement limits or internal notes, never an audio asset id.
6. **Reminders by time slot.** Look Up knows when an advert's time slot is, not the minute the station plays it, so a
   reminder names the slot ("between 07:00 and 09:00"). It goes out once per slot and person, 5, 15 or 30 minutes before
   the slot starts, only for an active campaign at an active station, only for adverts the person has not muted.
7. **Delivery: Web Push and email.** The portal becomes installable (a web app manifest and a service worker); a client
   who turns notifications on gets Web Push (VAPID) on that device, and email when they choose it. Without the push keys
   configured, push is off and email still works. The notification payload holds the advert's title, the station and the
   slot, nothing about listeners. Invitations go by email; by SMS too once an SMS provider is chosen (ADR-004).
8. **The delivery is separate from the notification**, so a native app (Firebase) can be added later as another channel,
   and stations' slot offers (the next phase) reuse the same rules for consent and delivery.

## What this supersedes

| Requirement | Was | Becomes |
|---|---|---|
| P5C-DATABASE-03, -04 | Client viewers read station tables through `FOR SELECT` row-level-security policies keyed by an `app.client_ids()` session setting | Client reads go through definer functions checking the person's access; no policy is added (decision 3). They return only safe columns, which policies cannot do (P5C-PRIVACY-01). |
| P5C-ACCESS-01 | The request context carries the client ids instead of a station id | It carries the signed-in person; the station id stays empty, so station row-level security shows a client nothing. |
| P5C-ACCESS-02, -03, P5C-DASHBOARD-04 | Client viewers reach only `GET` routes under `/client/*` | They reach only routes under `/client/*`; the only writes are their own notification settings, muted adverts and devices (decision 2). |
| P5C-DASHBOARD-02 | A "Your ads on" switcher chooses one station | One home page with each station as its own section (decision 4); "never merged" (P5C-ACCESS-05) is kept. |
| P5C-INVITATIONS-01 | Invitation by email and by SMS | By email; SMS once a provider is chosen (ADR-004). |

## Alternatives considered

- **A separate Android app** (Play Store, Firebase Cloud Messaging): the most reliable notifications, but a second app to
  build, publish and maintain, a Google Firebase project, and a paid Apple account for an iPhone version. Kept possible
  by decision 8.
- **A "for businesses" mode in the listener app:** one install, but the public's app and the businesses' app mixed, and
  businesses made to install the consumer app.
- **Web pages with email only:** simplest, but no instant notification on the phone.
- **Row-level-security policies for clients** (the plan's first idea): policies cannot hide columns inside a row, and each
  table without a `client_id` would need a join policy (gap 43). Functions are narrower and are tested one by one.

## Consequences

- **More personal data about businesses' people:** a client's name, email and password hash, like station members.
  The Phase 8 privacy work (privacy notice, data-protection registration) covers them too.
- **Push depends on the browser's push service** (Google's for Chrome on Android). The payload is encrypted end to end by
  the Web Push protocol; the endpoint address is a secret, stored only to send and never logged or shown. Only the
  browsers' own push services are accepted as addresses, so the server cannot be made to post elsewhere.
- **iPhones** receive Web Push only when Look Up is added to the home screen (iOS 16.4 or newer); the portal says so.
- **Reminder volume:** a slot every weekday is a reminder every weekday. The client controls it per advert, and each
  slot is reminded once.
- **New settings:** `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_CONTACT_EMAIL` (optional; push off without
  them). Added to `.env.example`, `render.yaml`, the deploy-secrets tool and the Render runbook.
