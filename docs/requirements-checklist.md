# Requirements checklist

Every requirement from the blueprint, the approved plan, the wireframes, the security baseline and the
standing rules, as one item each, with where it comes from and what proves it. A phase is not done
until its items are ticked with evidence or set aside with a reason shown to the user.

The items live in five parts, in the order the system is built:

| Part | Phases | File |
|---|---|---|
| 1 | S1 Foundations; S2 Station side (sign-in, clients, ads and uploads, buttons, schedule and publish, the station portal) | [checklist-1-foundations-and-station-side.md](requirements/checklist-1-foundations-and-station-side.md) |
| 2 | S3 Engine hookup and recognition; P4 Station resolution and the scheduler | [checklist-2-engine-and-recognition.md](requirements/checklist-2-engine-and-recognition.md) |
| 3 | S4 Listener app; P6 the full app (offline capture, history, settings) | [checklist-3-listener-app.md](requirements/checklist-3-listener-app.md) |
| 4 | P5A Registration and admin; P5B Station dashboard; P5C Client viewers | [checklist-4-portal-registration-dashboards.md](requirements/checklist-4-portal-registration-dashboards.md) |
| 5 | P7 Analytics; P8 Hardening and pilot; P9 later; ALL rules that apply to every phase | [checklist-5-analytics-hardening-and-every-phase.md](requirements/checklist-5-analytics-hardening-and-every-phase.md) |

How to read a line is explained at the top of part 1. In short:

- `- [ ] **S2-ADS-03** What must be true. *Source:* where it is stated. *Verified by:* what would prove it.`
- `- [x]` only when a named test proves it, given after *Evidence:* as `path :: suite > test name`.
  Built but untested stays `- [ ]` and says so.
- An item that was built differently by a recorded decision names the decision and stays unticked until
  the user accepts the change.

## Checking the evidence

```
npm run check:requirements
```

checks that every ticked item names a test file that exists and a test that is in it under its whole
name (or in the shared fixtures it is named after), and prints how many items each phase has ticked. It fails when a tick has
no evidence or its evidence has gone, so a renamed or deleted test cannot leave a requirement ticked by
mistake.
