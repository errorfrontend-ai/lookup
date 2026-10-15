# Phase 5b — Station dashboard (full): build record

**Status (15 October 2026).** Phase 5b's first slice is built: the station's listener figures. On the same day the
user set the goal of a presentable MVP deployed on Render, with the Overview numbers first and the deployment next;
the rest of 5b (row and bulk actions, the card builder's picture and offer title, the client and profile editors,
the remaining list and wizard items, the browser journeys and the gate) follows the deployment. This document grows
with each slice; every P5B item in `docs/requirements/checklist-4-portal-registration-dashboards.md` is ticked only
with its test.

## Decisions

| # | Decision | Why |
|---|---|---|
| P5B-D1 | **The station dashboard keeps its `/stations/:stationId/…` addresses** (built in Step 2) rather than the plan's `/station`. P5B-SHELL-01's rule (members only) is met by the station access guard on every route. | One person can belong to several stations (P5A team invitations); the address must say which. |
| P5B-D2 | **The figures are counted from the recognitions and taps themselves**, through row-level security, until the Phase 7 roll-ups exist (gap 28). The screens read one endpoint for the station (`GET /stations/:id/listener-figures?range=`) and one object on each ad (`lastSevenDays`), so P7 can change where the numbers come from without changing a screen. | No made-up numbers (S2-D25), and no second copy of the data before P7 designs its roll-ups. |
| P5B-D3 | **A recognition counts for a station when the listener was shown one of its cards**: a match (`MATCH`), the client's usual buttons (`MATCH_DEFAULT`), or a "Which station?" answered with this station (`CHOOSE_STATION` with the listener's choice). A chooser nobody answered, a clip that matched nothing and another station's recognitions never count. The "possible" recognitions of unanswered choosers are P7's (P7 shows resolved and possible apart). | Only what reached a listener as this station's buttons is this station's result. |
| P5B-D4 | **Days and hours are the station's own** (its time zone). A recognition counts on the day and in the hour it was *heard*, so a clip sent later from a no-signal area lands where it belongs (the plan's time rule); a tap counts on the day it was made. "Last 7 days" is today and the six days before; "Last 30 days" likewise; "Today" since the station's midnight. | Drive-time peaks must show in station time; a late clip must not inflate the day it arrived. |
| P5B-D5 | **The date range** (Today, Last 7 days — the default — and Last 30 days) changes four tiles and the hourly chart; "Recognitions today" always counts today (gap 28). The range is kept in the address (`?range=`). | The wireframe's first tile is about today; the others follow the chosen range. |
| P5B-D6 | **Five tiles** (conflict 13): recognitions today, recognitions, button taps, tap rate (taps per recognition, in whole percent, above 100 % when listeners tap several buttons) and "Sent later" (the share of recognitions sent from no-signal areas). A share of nothing is "—", never 0 %. | The plan's five; a rate with no recognitions behind it would be made up. |
| P5B-D7 | **Every stored tap counts in the figures**, whether or not it counted towards a campaign's tap limit or the per-install cap (P4-ENGAGEMENTS-14): those decide the limits, not what listeners did. Each button counts once per recognition (P4). | The station sees what its listeners did; limits are a separate rule. |
| P5B-D8 | **An ad's 7-day numbers show "—" until it is published** (no schedule, or a draft); a published ad nobody has heard yet shows 0. | P5B-ADS-LIST-14: a value that does not exist yet is a dash; a real zero is a zero. |
| P5B-D9 | **The hourly chart** is 24 bars (hidden from screen readers) with a Chart/Table switch; the table is the accessible form, with the same numbers. No chart library: the bars are plain elements, so nothing is downloaded and nothing is drawn on a canvas. | P5B-OVERVIEW-14 and -16; the portal loads nothing it does not need. |

## Slice 1: the listener figures (15 October 2026)

**Built:**
- Contracts: `stations/listener-figures-schemas.ts` (`ListenerFigures`, the three ranges, `ListenerFiguresQuery`,
  `AdListenerFigures`, `wholePercentOf`); `AdSummary.lastSevenDays`.
- API: `GET /stations/:stationId/listener-figures` (`features/station-overview/listener-figures.*`), readable by
  every member of an active station; each ad's last 7 days joined into `AD_RECORD_SELECT`, grouped once per query for
  the whole station. Both read through the existing `(station_id, captured_at)` and `(station_id, occurred_at)`
  indexes, and bound the receipt time so only the months that can hold the clips are read (a clip arrives at most
  24 hours after it was heard).
- Portal: the Overview's "How listeners responded" section (date range, five tiles, recognitions by hour with
  Chart/Table) replaces the "numbers will appear" card; the ads table gains "Heard · 7d" and "Taps · 7d", the phone
  cards "N heard · N taps · last 7 days"; the ad's page gains "Last 7 days". New shared component `figure-tile`.

**Tests:** `apps/api/test/listener-figures.test.ts` (each range, today, the station's days, the hour in Lusaka time,
per-ad numbers in the list and on the ad's page, nothing of another station or of an unanswered chooser, access, a
generic 500 with the stack in the log); `packages/contracts/test/listener-figures-schemas.test.ts`; the Overview,
ads list, ad page and accessibility tests in the portal. Two deliberate breaks were caught: hours counted in UTC
instead of station time, and the ads' 7 days widened to 9.
