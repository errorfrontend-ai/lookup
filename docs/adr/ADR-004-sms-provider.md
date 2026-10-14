# ADR-004: The SMS provider (open decision O16)

- **Status:** Proposed. Waiting for the project owner's choice. No real provider is built until then
  (P5A-NOTIFICATIONS-05).
- **Date:** 14 October 2026. The outside facts were checked on 9 October 2026.
- **Deciders:** the project owner, with the Phase 5a design (`docs/design/step-5a-registration-and-admin.md`, §9)

## Context

Look Up sends SMS for three things:

- sign-up's 6-digit phone codes;
- the review outcome (approved, needs changes);
- critical alerts (suspended, active again).

Email carries the links and the longer words. In Zambia, SMS is more dependable than email for reaching a
station's staff. A code that never arrives stops a sign-up dead.

What Phase 5a built instead of a real provider:

- **`SMS_SENDER=development`.** It sends every SMS as an email to `<digits>@sms.development.invalid` in the
  development inbox (Mailpit). The browser tests read codes from there.
- **Production refuses `development`.**
- **`SMS_SENDER=none`.** Step 1 of sign-up answers 503 `SIGN_UP_UNAVAILABLE` ("Station sign-up isn't open yet"). So
  production can start before this decision while sign-up stays closed.
- **A real provider plugs in behind the same `SmsSender` interface.** Sends are queued with five tries, and the
  number and text are never logged.

The master plan recommends Africa's Talking, and allows local bulk-SMS aggregators as the alternative. It asks that
three things be checked before committing: **coverage in Zambia**, **sender-ID registration rules** and **price**.

## What was found (9 October 2026)

| | Coverage in Zambia | Sender ID | Price |
|---|---|---|---|
| **Africa's Talking** | Supports Zambia SMS | Its sender-ID registration letters cover **Airtel and MTN only**; Zamtel is not mentioned | **Not confirmed**: the pricing page refused to load |
| **Twilio** | Supports Zambia | An alphanumeric sender ID needs **about 3 weeks of pre-registration**; no numeric or short codes | **$0.3942 per segment** |
| **Local aggregators** (Celcom Africa and others) | Claim **all three networks** (Airtel, MTN, Zamtel) | Varies by aggregator; not checked | Not checked |

What these mean:

- **Zamtel subscribers.** Any provider without Zamtel sender-ID registration may deliver to them under a generic
  or numeric sender, or not at all. Ask each provider before choosing.
- **Cost.** A sign-up sends at least one code, and a resend costs another. At Twilio's price, one sign-up costs
  about $0.40–$1.20 in SMS alone. That is affordable at station scale (tens of stations), but it rules out SMS for
  anything sent to listeners.
- **Lead time.** Sender-ID registration takes weeks. It should start well before the pilot, whichever provider is
  chosen.

## Options

1. **Africa's Talking** (the plan's recommendation): an African provider with a simple API. First confirm its
   Zambian price and whether Zamtel numbers receive the registered sender ID.
2. **A local aggregator.** Likely the best coverage of all three networks and local billing. The API and how
   reliable it is vary, so choose one with delivery reports (callbacks).
3. **Twilio:** the price is known and the documentation good. It is the most expensive, and needs the 3-week
   sender-ID registration.

## Recommendation

Ask Africa's Talking and one local aggregator for:

- a written Zambian price per SMS;
- confirmation of delivery to Airtel, MTN **and** Zamtel numbers under a "Look Up" sender ID;
- the sender-ID registration steps and how long they take.

Choose the one that covers all three networks at the lower price.

Then, before building it:

1. Record the answers in this ADR and set its status to Accepted.
2. Build the adapter behind `SmsSender`, with its delivery-report callback as a webhook. Like every boundary, the
   webhook needs request ids, two-layer errors and no numbers in the logs.
3. Add `SMS_SENDER=<provider>` and its secrets to the production configuration.

## Consequences

- Until this is decided, **production sign-up stays closed** (`SMS_SENDER=none`): no station can join in production,
  so sender-ID registration should start early enough not to hold up the pilot.
- Development and the browser tests need no provider and no internet.
