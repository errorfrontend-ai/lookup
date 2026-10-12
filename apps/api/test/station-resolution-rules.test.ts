import type { ActionCard } from '@lookup/contracts';
import { describe, expect, it } from 'vitest';
import { resolveStation, type StationCandidateRow, type StationResolution } from '../src/features/recognition/resolve-station.js';

/**
 * resolveStation, the TypeScript half of station resolution (P4 design §5.1; ADR-003), table by table and with no
 * database (P4-RESOLUTION-01). Each row stands for one campaign that makes its station an owner of the matched
 * recording, as recognition.find_station_candidates returns it. Every case checks the stored outcome, the
 * resolution, the fallback reason, what the listener is shown, and the candidate rows: one for every station that
 * can show a card, whatever the outcome (P4-D8), with places only for the stations a chooser shows.
 */

const CAPTURED_AT = new Date('2026-10-11T12:00:00Z');
const at = (isoTime: string) => new Date(isoTime);
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
type Letter = (typeof LETTERS)[number];
const stationIdOf = (letter: Letter) => `0192a6c4-0000-4000-8000-00000000000${letter.toLowerCase()}`;
const letterOf = (stationId: string) => LETTERS.find((letter) => stationIdOf(letter) === stationId) ?? stationId;

function card(label: string, number: number): ActionCard {
  return {
    schema_version: 1,
    layout: 'VERTICAL_STACK',
    actions: [{ type: 'CALL', id: '0192a6c4-0000-4000-8000-0000000000c1', label, style: 'PRIMARY', phone_number_e164: `+447700900${String(number).padStart(3, '0')}` }],
  };
}

/** A campaign of Station <letter> on the recording: by default ACTIVE, with its own card, not on air, no default card. */
function campaign(letter: Letter, changes: Partial<StationCandidateRow> = {}): StationCandidateRow {
  const number = LETTERS.indexOf(letter) + 1;
  return {
    station_id: stationIdOf(letter),
    station_name: `Station ${letter}`,
    station_frequency_label: `${97 + number}.1 FM`,
    station_city: 'Lusaka',
    ad_title: 'Summer service offer',
    client_name: 'Brand A',
    campaign_id: `campaign-${letter}`,
    campaign_period_started_at: at('2026-10-01T00:00:00Z'),
    is_campaign_active: true,
    campaign_action_card_id: `campaign-card-${letter}`,
    campaign_card: card(`Call ${letter}`, number),
    client_default_action_card_id: null,
    client_default_card: null,
    is_in_window: false,
    matched_slot_started_at: null,
    last_slot_ended_at: null,
    is_at_engagement_limit: false,
    ...changes,
  };
}
/** On air, in a slot that started at the given time. */
const onAir = (slotStartedAt = '2026-10-11T10:00:00Z'): Partial<StationCandidateRow> => ({ is_in_window: true, matched_slot_started_at: at(slotStartedAt) });
/** The client has a usual card. */
const withDefaultCard = (letter: Letter): Partial<StationCandidateRow> => ({
  client_default_action_card_id: `default-card-${letter}`,
  client_default_card: card(`Usual ${letter}`, 10 + LETTERS.indexOf(letter)),
});

/** The decision in a few words: outcome, resolution, reason, who is shown with which card, and the candidate rows. */
function summarise(resolution: StationResolution) {
  const shown =
    resolution.outcome === 'MATCH' || resolution.outcome === 'MATCH_DEFAULT'
      ? [resolution.matched]
      : resolution.outcome === 'CHOOSE_STATION'
        ? resolution.shownCandidates
        : [];
  return {
    outcome: resolution.outcome,
    resolution: resolution.resolution,
    fallbackReason: resolution.fallbackReason,
    shown: shown.map((candidate) => `${letterOf(candidate.stationId)} ${candidate.cardKind} ${candidate.actionCardId}`),
    weighed: resolution.weighedCandidates.map(
      (weighed) => `${letterOf(weighed.station_id)} ${weighed.card_kind} ${weighed.is_in_window ? 'on air' : 'off air'} ${weighed.display_position ?? '-'}`,
    ),
  };
}

const resolve = (rows: StationCandidateRow[], stationHint: string | null = null) => summarise(resolveStation(rows, { capturedAt: CAPTURED_AT, stationHint }));

describe('resolveStation: candidates, then the schedule, then the hint, then limits', () => {
  it.each<[string, StationCandidateRow[], string | null, ReturnType<typeof summarise>]>([
    [
      'P4-RESOLUTION-04: one owner on air: its campaign card, SINGLE_OWNER, one candidate row',
      [campaign('A', onAir())],
      null,
      { outcome: 'MATCH', resolution: 'SINGLE_OWNER', fallbackReason: null, shown: ['A CAMPAIGN campaign-card-A'], weighed: ['A CAMPAIGN on air -'] },
    ],
    [
      'P4-RESOLUTION-04: one owner off air with a usual card: that card, MATCH_DEFAULT, SINGLE_OWNER',
      [campaign('A', withDefaultCard('A'))],
      null,
      { outcome: 'MATCH_DEFAULT', resolution: 'SINGLE_OWNER', fallbackReason: 'not_on_air', shown: ['A CLIENT_DEFAULT default-card-A'], weighed: ['A CLIENT_DEFAULT off air -'] },
    ],
    [
      'one owner off air with no usual card: no card to show, NO_MATCH',
      [campaign('A')],
      null,
      { outcome: 'NO_MATCH', resolution: null, fallbackReason: 'no_card_to_show', shown: [], weighed: [] },
    ],
    [
      'no owner at all: NO_MATCH, no station airs it',
      [],
      null,
      { outcome: 'NO_MATCH', resolution: null, fallbackReason: 'no_station_airs_it', shown: [], weighed: [] },
    ],
    [
      'P4-RESOLUTION-05: two owners, one on air: the one on air, SCHEDULE_UNIQUE, both weighed and only it on air',
      [campaign('A', withDefaultCard('A')), campaign('B', onAir())],
      null,
      { outcome: 'MATCH', resolution: 'SCHEDULE_UNIQUE', fallbackReason: null, shown: ['B CAMPAIGN campaign-card-B'], weighed: ['A CLIENT_DEFAULT off air -', 'B CAMPAIGN on air -'] },
    ],
    [
      'P4-RESOLUTION-05: one on air outranks a hint for an owner off air: the listener most likely heard the one on air',
      [campaign('A', withDefaultCard('A')), campaign('B', onAir())],
      stationIdOf('A'),
      { outcome: 'MATCH', resolution: 'SCHEDULE_UNIQUE', fallbackReason: null, shown: ['B CAMPAIGN campaign-card-B'], weighed: ['A CLIENT_DEFAULT off air -', 'B CAMPAIGN on air -'] },
    ],
    [
      'gap 27: two owners, only one can show a card: SINGLE_OWNER, saying the other owners have none',
      [campaign('A'), campaign('B', onAir())],
      null,
      { outcome: 'MATCH', resolution: 'SINGLE_OWNER', fallbackReason: 'other_owners_have_no_card', shown: ['B CAMPAIGN campaign-card-B'], weighed: ['B CAMPAIGN on air -'] },
    ],
    [
      'P4-RESOLUTION-06: two on air and the hint names one: that one, HINT',
      [campaign('A', onAir()), campaign('B', onAir())],
      stationIdOf('B'),
      { outcome: 'MATCH', resolution: 'HINT', fallbackReason: null, shown: ['B CAMPAIGN campaign-card-B'], weighed: ['A CAMPAIGN on air -', 'B CAMPAIGN on air -'] },
    ],
    [
      'P4-RESOLUTION-06: the hint is matched whatever its letter case',
      [campaign('A', onAir()), campaign('B', onAir())],
      stationIdOf('B').toUpperCase(),
      { outcome: 'MATCH', resolution: 'HINT', fallbackReason: null, shown: ['B CAMPAIGN campaign-card-B'], weighed: ['A CAMPAIGN on air -', 'B CAMPAIGN on air -'] },
    ],
    [
      'P4-RESOLUTION-07, -09: two on air and no hint: the server never guesses, it asks, with both cards, by name when the slots started together',
      [campaign('B', onAir()), campaign('A', onAir())],
      null,
      { outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED', fallbackReason: null, shown: ['A CAMPAIGN campaign-card-A', 'B CAMPAIGN campaign-card-B'], weighed: ['A CAMPAIGN on air 1', 'B CAMPAIGN on air 2'] },
    ],
    [
      'P4-RESOLUTION-07: on air, the station whose slot started last comes first',
      [campaign('A', onAir('2026-10-11T09:00:00Z')), campaign('B', onAir('2026-10-11T11:30:00Z'))],
      null,
      { outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED', fallbackReason: null, shown: ['B CAMPAIGN campaign-card-B', 'A CAMPAIGN campaign-card-A'], weighed: ['A CAMPAIGN on air 2', 'B CAMPAIGN on air 1'] },
    ],
    [
      'P4-RESOLUTION-08: a hint for an owner off air while two are on air is ignored: the chooser of the two, the third weighed but not shown',
      [campaign('A', onAir()), campaign('B', onAir()), campaign('C', withDefaultCard('C'))],
      stationIdOf('C'),
      {
        outcome: 'CHOOSE_STATION',
        resolution: 'UNRESOLVED',
        fallbackReason: null,
        shown: ['A CAMPAIGN campaign-card-A', 'B CAMPAIGN campaign-card-B'],
        weighed: ['A CAMPAIGN on air 1', 'B CAMPAIGN on air 2', 'C CLIENT_DEFAULT off air -'],
      },
    ],
    [
      'P4-RESOLUTION-08: a hint for a station that owns nothing is ignored silently',
      [campaign('A', onAir()), campaign('B', onAir())],
      '0192a6c4-0000-4000-8000-0000000000ff',
      { outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED', fallbackReason: null, shown: ['A CAMPAIGN campaign-card-A', 'B CAMPAIGN campaign-card-B'], weighed: ['A CAMPAIGN on air 1', 'B CAMPAIGN on air 2'] },
    ],
    [
      'P4-FALLBACK-01: none on air and the hint owns it: its usual card, MATCH_DEFAULT, HINT',
      [campaign('A', withDefaultCard('A')), campaign('B', withDefaultCard('B'))],
      stationIdOf('A'),
      { outcome: 'MATCH_DEFAULT', resolution: 'HINT', fallbackReason: 'not_on_air', shown: ['A CLIENT_DEFAULT default-card-A'], weighed: ['A CLIENT_DEFAULT off air -', 'B CLIENT_DEFAULT off air -'] },
    ],
    [
      'P4-FALLBACK-02, -03: none on air, several owners, no hint: a chooser of usual cards, the slot that ended last first, none in 7 days last',
      [
        campaign('A', { ...withDefaultCard('A'), last_slot_ended_at: at('2026-10-11T08:00:00Z') }),
        campaign('B', { ...withDefaultCard('B'), last_slot_ended_at: at('2026-10-11T11:00:00Z') }),
        campaign('C', withDefaultCard('C')),
      ],
      null,
      {
        outcome: 'CHOOSE_STATION',
        resolution: 'UNRESOLVED',
        fallbackReason: null,
        shown: ['B CLIENT_DEFAULT default-card-B', 'A CLIENT_DEFAULT default-card-A', 'C CLIENT_DEFAULT default-card-C'],
        weighed: ['A CLIENT_DEFAULT off air 2', 'B CLIENT_DEFAULT off air 1', 'C CLIENT_DEFAULT off air 3'],
      },
    ],
    [
      'none on air, one owner with a usual card and others without: SINGLE_OWNER with that card',
      [campaign('A', withDefaultCard('A')), campaign('B'), campaign('C')],
      null,
      { outcome: 'MATCH_DEFAULT', resolution: 'SINGLE_OWNER', fallbackReason: 'other_owners_have_no_card', shown: ['A CLIENT_DEFAULT default-card-A'], weighed: ['A CLIENT_DEFAULT off air -'] },
    ],
    [
      'P4-CHOOSER-02: five on air give the four whose slots started last; the fifth is weighed, not shown',
      [
        campaign('A', onAir('2026-10-11T06:00:00Z')),
        campaign('B', onAir('2026-10-11T07:00:00Z')),
        campaign('C', onAir('2026-10-11T08:00:00Z')),
        campaign('D', onAir('2026-10-11T09:00:00Z')),
        campaign('E', onAir('2026-10-11T10:00:00Z')),
      ],
      null,
      {
        outcome: 'CHOOSE_STATION',
        resolution: 'UNRESOLVED',
        fallbackReason: null,
        shown: ['E CAMPAIGN campaign-card-E', 'D CAMPAIGN campaign-card-D', 'C CAMPAIGN campaign-card-C', 'B CAMPAIGN campaign-card-B'],
        weighed: ['A CAMPAIGN on air -', 'B CAMPAIGN on air 4', 'C CAMPAIGN on air 3', 'D CAMPAIGN on air 2', 'E CAMPAIGN on air 1'],
      },
    ],
    [
      'gap 25: an owner with no card to show is left out, and a chooser left with one station is a MATCH',
      [campaign('A', { ...onAir(), is_at_engagement_limit: true }), campaign('B', onAir())],
      null,
      { outcome: 'MATCH', resolution: 'SINGLE_OWNER', fallbackReason: 'other_owners_have_no_card', shown: ['B CAMPAIGN campaign-card-B'], weighed: ['B CAMPAIGN on air -'] },
    ],
    [
      'P4-LIMITS-05: a campaign at its tap limit shows the usual card, and stays on air for the chooser',
      [campaign('A', { ...onAir(), ...withDefaultCard('A'), is_at_engagement_limit: true }), campaign('B', onAir())],
      null,
      {
        outcome: 'CHOOSE_STATION',
        resolution: 'UNRESOLVED',
        fallbackReason: null,
        shown: ['A CLIENT_DEFAULT default-card-A', 'B CAMPAIGN campaign-card-B'],
        weighed: ['A CLIENT_DEFAULT on air 1', 'B CAMPAIGN on air 2'],
      },
    ],
    [
      'P4-LIMITS-05: one owner on air at its tap limit: its usual card',
      [campaign('A', { ...onAir(), ...withDefaultCard('A'), is_at_engagement_limit: true })],
      null,
      { outcome: 'MATCH_DEFAULT', resolution: 'SINGLE_OWNER', fallbackReason: 'campaign_at_tap_limit', shown: ['A CLIENT_DEFAULT default-card-A'], weighed: ['A CLIENT_DEFAULT on air -'] },
    ],
    [
      'P4-TIMERULE-06: a campaign paused or ended after the clip was heard shows the usual card',
      [campaign('A', { ...onAir(), ...withDefaultCard('A'), is_campaign_active: false })],
      null,
      { outcome: 'MATCH_DEFAULT', resolution: 'SINGLE_OWNER', fallbackReason: 'campaign_not_active', shown: ['A CLIENT_DEFAULT default-card-A'], weighed: ['A CLIENT_DEFAULT on air -'] },
    ],
    [
      'a campaign on air without a card of its own shows the usual card',
      [campaign('A', { ...onAir(), ...withDefaultCard('A'), campaign_action_card_id: null, campaign_card: null })],
      null,
      { outcome: 'MATCH_DEFAULT', resolution: 'SINGLE_OWNER', fallbackReason: 'campaign_has_no_card', shown: ['A CLIENT_DEFAULT default-card-A'], weighed: ['A CLIENT_DEFAULT on air -'] },
    ],
  ])('%s', (_case, rows, stationHint, expected) => {
    expect(resolve(rows, stationHint)).toEqual(expected);
  });

  it('a chooser carries every shown station’s full card inline, with the station’s public facts and city (P4-CHOOSER-03, -04)', () => {
    const resolution = resolveStation([campaign('A', onAir()), campaign('B', { ...onAir(), station_city: null })], { capturedAt: CAPTURED_AT, stationHint: null });
    if (resolution.outcome !== 'CHOOSE_STATION') throw new Error(`expected a chooser, got ${resolution.outcome}`);
    expect(resolution.shownCandidates.map(({ stationName, frequencyLabel, city, clientName, adTitle, card: shownCard }) => ({ stationName, frequencyLabel, city, clientName, adTitle, shownCard }))).toEqual([
      { stationName: 'Station A', frequencyLabel: '98.1 FM', city: 'Lusaka', clientName: 'Brand A', adTitle: 'Summer service offer', shownCard: card('Call A', 1) },
      { stationName: 'Station B', frequencyLabel: '99.1 FM', city: null, clientName: 'Brand A', adTitle: 'Summer service offer', shownCard: card('Call B', 2) },
    ]);
  });
});

describe('resolveStation: one candidate per station (P4-TIMERULE-09)', () => {
  const pick = (rows: StationCandidateRow[]) => {
    const resolution = resolveStation(rows, { capturedAt: CAPTURED_AT, stationHint: null });
    if (resolution.outcome !== 'MATCH' && resolution.outcome !== 'MATCH_DEFAULT') throw new Error(`expected a match, got ${resolution.outcome}`);
    return { campaignId: resolution.matched.campaignId, clientName: resolution.matched.clientName, cardKind: resolution.matched.cardKind, weighedCount: resolution.weighedCandidates.length };
  };

  it('a station’s two campaigns on the recording fold into one candidate: on air, the one whose slot started last', () => {
    expect(
      pick([
        campaign('A', { ...onAir('2026-10-11T09:00:00Z'), campaign_id: 'morning' }),
        campaign('A', { ...onAir('2026-10-11T11:00:00Z'), campaign_id: 'late-morning', campaign_action_card_id: 'late-card' }),
      ]),
    ).toEqual({ campaignId: 'late-morning', clientName: 'Brand A', cardKind: 'CAMPAIGN', weighedCount: 1 });
  });

  it('a campaign on air outranks one that is not, whatever the order the rows came in', () => {
    expect(pick([campaign('A', { campaign_id: 'off-air', last_slot_ended_at: at('2026-10-11T11:59:00Z') }), campaign('A', { ...onAir(), campaign_id: 'on-air' })])).toMatchObject({
      campaignId: 'on-air',
    });
  });

  it('none on air: the campaign whose slot ended last within 7 days, so a campaign of another client that starts in 3 days never stands in for the one just on air', () => {
    const brandA = campaign('A', { ...withDefaultCard('A'), campaign_id: 'summer-service-offer', client_name: 'Brand A', last_slot_ended_at: at('2026-10-11T10:00:00Z'), campaign_period_started_at: at('2026-09-26T00:00:00Z') });
    const brandB = campaign('A', {
      campaign_id: 'weekend-sale',
      client_name: 'Brand B',
      ad_title: 'Weekend sale',
      campaign_period_started_at: at('2026-10-14T00:00:00Z'),
      client_default_action_card_id: 'default-card-brand-b',
      client_default_card: card('Usual Brand B', 20),
    });
    expect(pick([brandB, brandA])).toEqual({ campaignId: 'summer-service-offer', clientName: 'Brand A', cardKind: 'CLIENT_DEFAULT', weighedCount: 1 });
  });

  it('no slot in the last 7 days: the latest period that had started when the clip was heard, before one that starts later', () => {
    const started = (campaignId: string, startedAt: string) => campaign('A', { ...withDefaultCard('A'), campaign_id: campaignId, campaign_period_started_at: at(startedAt) });
    expect(pick([started('older', '2026-09-01T00:00:00Z'), started('newer', '2026-10-05T00:00:00Z'), started('not-yet', '2026-10-12T00:00:00Z')]).campaignId).toBe('newer');
  });

  it('every period starts after the clip was heard: the first to start', () => {
    const later = (campaignId: string, startedAt: string) => campaign('A', { ...withDefaultCard('A'), campaign_id: campaignId, campaign_period_started_at: at(startedAt) });
    expect(pick([later('in-a-week', '2026-10-18T00:00:00Z'), later('tomorrow', '2026-10-12T00:00:00Z')]).campaignId).toBe('tomorrow');
  });

  it('two campaigns on air in slots that started together: the latest period that had started, then the campaign id', () => {
    expect(pick([campaign('A', { ...onAir(), campaign_id: 'older', campaign_period_started_at: at('2026-09-16T00:00:00Z') }), campaign('A', { ...onAir(), campaign_id: 'newer', campaign_period_started_at: at('2026-09-26T00:00:00Z') })]).campaignId).toBe('newer');
    expect(pick([campaign('A', { ...onAir(), campaign_id: 'second' }), campaign('A', { ...onAir(), campaign_id: 'first' })]).campaignId).toBe('first');
  });

  it('the folded campaign alone decides the card: the station is not offered when that campaign has no card to show', () => {
    // On air at its limit with no usual card, beside a campaign of the same station that is off air.
    const resolution = resolveStation(
      [campaign('A', { ...onAir(), is_at_engagement_limit: true, campaign_id: 'at-limit' }), campaign('A', { campaign_id: 'off-air', last_slot_ended_at: at('2026-10-11T11:00:00Z') })],
      { capturedAt: CAPTURED_AT, stationHint: null },
    );
    expect(summarise(resolution)).toEqual({ outcome: 'NO_MATCH', resolution: null, fallbackReason: 'no_card_to_show', shown: [], weighed: [] });
  });
});
