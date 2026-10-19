# ADR-005: Listener accounts (email, gender and age) gate the result of an ad scan

- **Status:** Accepted by the project owner on 19 October 2026 (the request) and 20 October 2026 (the plan,
  with three answers: an emailed code, an encrypted readable email, an age typed as a number).
- **Date:** 20 October 2026.
- **Deciders:** the project owner.
- **Design:** `docs/design/listener-accounts.md`. **Requirements:** `docs/requirements/checklist-6-listener-accounts.md`
  (prefix `LA-`).

## Context

Until now a listener has been anonymous by design: the app registers a random install id, the server stores only a
keyed hash of it, and nothing says who listens. That kept the first versions simple and private, but it means a
station cannot see **which genders and ages follow an advert**, which is the figure a station and its advertisers
most want from the audience.

The project owner decided that the listener app should ask for an account at the moment it would show the result of
an ad scan. The first scan is allowed to run; the result waits for the account. The account holds an email,
a gender and an age, and the gender and age are tied to the adverts the listener identifies, so the station
dashboard can show groups.

## Decision

1. **A listener account** holds an email address, a gender and a birth year (worked out from the age typed at
   sign-up). One account can be signed in on several installs (a new phone); an install has at most one account.
2. **The gate is on the server.** A scan is recognised and recorded as before. When the install has no account and
   the answer would be an ad (a match, or a "Which station?" chooser), the server answers `ACCOUNT_REQUIRED` with
   no station, client, title or card in it. "We couldn't recognise that" is never gated. A gated result is released
   by a reveal route once the install has an account. The app cannot show what it never received.
3. **The email is proved with a 6-digit code** emailed to the address (10 minutes, 5 tries, one a minute). The same
   code is the way back in on a new phone, so there is no password.
4. **The email is stored encrypted and readable by the platform** (AES-256-GCM, with a keyed hash beside it for
   lookup and uniqueness). It is used for the sign-in code only. It never leaves the server in any response a
   station, advertiser or admin screen receives.
5. **Stations see groups, never people.** Gender and age-band counts of distinct listeners per station and per ad;
   a group smaller than 10 is merged so a small ad cannot point at one person; the breakdown is hidden below
   10 listeners.
6. **A listener can sign out and delete the account.** Deleting erases the email, gender and birth year and unlinks
   every install.
7. **Rollout is behind a switch** (`LISTENER_ACCOUNT_REQUIRED`, off by default) and a raised minimum app version, so
   the live showcase and the phones already running the old app are never broken.

## What this supersedes

| Requirement | Was | Becomes |
|---|---|---|
| S3-INSTALLS-02 | A listener is anonymous: no listener account, no listener sign-in route besides `POST /installs` | Installing and scanning need no account; the result of an ad scan does. The listener-account routes are the only other listener sign-in routes (LA-ROUTES-01). |
| S4-PERMISSION-10 and the Privacy screen | "Radio stations see how many people used their buttons — never who you are." | Stations see how many people used their buttons and the mix of ages and genders, never a name or an email (LA-PRIVACY-02). |
| ALL-PRIVACY-01 | Stations and client viewers see counts, never who a listener is | Counts and groups of genders and age bands, never a person (LA-PRIVACY-05). |

S3-PRIVACY-01 ("the only binary columns are keyed hashes, checksums and the encrypted two-factor secret") stays true
for clips; its test's list of allowed binary columns gains the account's keyed email hash and sealed email
(LA-DATABASE-04).

## Consequences

- **More personal data.** An email, a gender and an age are personal data under the Zambia Data Protection Act 2021.
  Phase 8's work (registration as a data controller, a privacy notice, consent points, the Google Play data-safety
  form, and the open question of keeping personal data in Zambia against the Frankfurt hosting, s.70) now covers
  listeners too (LA-PRIVACY-06). The sign-up carries its own consent line and stores which wording was agreed.
- **Accuracy limits, stated plainly.** One phone is taken to be one person: a shared phone counts as its account
  holder's group. A listener who signs out leaves their earlier scans as "not known yet" until they sign in again.
  Typed gender and age are not checked.
- **A new secret** (`LISTENER_EMAIL_ENCRYPTION_SECRET`) must be set wherever the API runs, or it refuses to start with
  the switch on.
- **Email cost.** Each sign-up or sign-in sends one email; Brevo's free plan allows 300 a day, which caps the showcase
  at about 300 sign-ups or sign-ins a day. Per-recipient and per-install limits keep abuse inside that.
- **Not solved here:** a device-integrity check (Play Integrity) to stop scripted sign-ups from many installs stays
  with phase 8, as for button taps.
