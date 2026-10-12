import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asLookupApi, databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { recognitionIdAt, StationResolutionTestData, type StationAiring } from './support/station-resolution-test-data.js';

const { candidate } = StationResolutionTestData;

/** The columns recognition.find_station_candidates returns, in order (P4 design §4.4; ALL-DATABASE-07). */
const CANDIDATE_COLUMNS = [
  'station_id', 'station_name', 'station_frequency_label', 'station_city', 'ad_title', 'client_name', 'campaign_id',
  'campaign_period_started_at', 'is_campaign_active', 'campaign_action_card_id', 'campaign_card', 'client_default_action_card_id',
  'client_default_card', 'is_in_window', 'matched_slot_started_at', 'last_slot_ended_at', 'is_at_engagement_limit',
];
/** The columns recognition.describe_recognition_for_replay returns, in order. */
const REPLAY_COLUMNS = [
  'outcome', 'is_deferred', 'captured_at', 'display_position', 'card_kind', 'station_id', 'station_name', 'station_frequency_label',
  'station_city', 'is_station_active', 'client_name', 'ad_title', 'action_card',
];
/** The columns the recreated recognition.claim_recognition returns, in order. */
const CLAIM_COLUMNS = ['recognition_id', 'recognition_received_at', 'recognition_captured_at', 'attempt_number', 'claim_outcome', 'previous_outcome', 'is_deferred'];

/**
 * Phase 4's database functions for resolving a recognition's station (P4 design §4.4), called as the API role
 * exactly as the API calls them: the candidates of a matched recording, finishing a recognition with its
 * resolution, hint and candidates, describing it for a replay, the recreated claim, finding a recognition by its
 * id, and the rules the tables themselves keep.
 */
describe('station resolution: database functions', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  let testData: StationResolutionTestData;

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await Promise.all([setupClient.connect(), apiClient.connect()]);
    testData = new StationResolutionTestData(setupClient);
  });
  afterAll(async () => {
    await testData.removeAll();
    await Promise.all([setupClient.end(), apiClient.end()]);
  });

  const findCandidates = async (assetNumber: number, capturedAt: string | Date) =>
    (await apiClient.query('SELECT * FROM recognition.find_station_candidates($1, $2::timestamptz)', [assetNumber, capturedAt])).rows as Array<
      Record<string, unknown>
    >;
  const eventRow = async (recognitionId: string) =>
    (await setupClient.query('SELECT * FROM app.recognition_events WHERE id = $1', [recognitionId])).rows[0] as Record<string, unknown>;
  const candidateRows = async (recognitionId: string) =>
    (
      await setupClient.query(
        `SELECT station_id, campaign_id, action_card_id, card_kind, is_in_window, display_position, is_chosen, chosen_at
           FROM app.recognition_candidates WHERE recognition_id = $1 ORDER BY display_position NULLS LAST, station_id`,
        [recognitionId],
      )
    ).rows as Array<Record<string, unknown>>;
  const shownCampaignCard = (airing: StationAiring) => ({ stationId: airing.stationId, campaignId: airing.campaignId, cardId: airing.campaignCardId as string });
  const inOneMinute = () => new Date(Date.now() + 60_000);

  /** Two stations airing one recording, both on air now with a client's default card too, and a claimed recognition of it. */
  async function twoStationsOnAir() {
    const recording = await testData.createRecording();
    const stationA = await testData.airAd({ recording, hasDefaultCard: true });
    const stationB = await testData.airAd({ recording, hasDefaultCard: true });
    const installId = await testData.createInstall();
    return { recording, stationA, stationB, installId, claimed: await testData.claim(apiClient, installId) };
  }

  // ---- recognition.find_station_candidates ---------------------------------------------------------------
  describe('recognition.find_station_candidates', () => {
    it('returns the station, its card and only what a listener may see, in window inside the period and a window', async () => {
      const recording = await testData.createRecording();
      const airing = await testData.airAd({
        recording,
        station: { city: 'Kitwe' },
        period: ['2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'],
        windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '08:00', to: '10:00' }],
      });
      // Lusaka is UTC+2: the 08:00–10:00 window is 06:00–08:00 UTC.
      const rows = await findCandidates(recording.assetNumber, '2026-10-07T06:30:00Z');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        station_id: airing.stationId,
        station_city: 'Kitwe',
        ad_title: 'Summer service offer',
        client_name: 'Brand A',
        campaign_id: airing.campaignId,
        is_campaign_active: true,
        campaign_action_card_id: airing.campaignCardId,
        campaign_card: airing.campaignCard,
        is_in_window: true,
        is_at_engagement_limit: false,
      });
      expect(Object.keys(rows[0] as object)).toEqual(CANDIDATE_COLUMNS);
      expect((await findCandidates(recording.assetNumber, '2026-10-07T08:30:00Z'))[0]?.is_in_window).toBe(false);
    });

    it('returns exactly the documented columns, in order, whether or not a station owns the recording (ALL-DATABASE-07)', async () => {
      const result = await apiClient.query('SELECT * FROM recognition.find_station_candidates($1, now())', [-1]);
      expect(result.rows).toEqual([]);
      expect(result.fields.map((field) => field.name)).toEqual(CANDIDATE_COLUMNS);
    });

    it('judges the period as [start, end): one instant before the start and exactly at the end are out', async () => {
      const recording = await testData.createRecording();
      // Both ends fall inside the 08:00–10:00 window, so only the period can put a moment out.
      await testData.airAd({
        recording,
        station: { timeZone: 'UTC' },
        period: ['2026-10-05T09:00:00Z', '2026-10-09T09:00:00Z'],
        windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '08:00', to: '10:00' }],
      });
      expect((await findCandidates(recording.assetNumber, '2026-10-05T08:59:59.999Z'))[0]?.is_in_window).toBe(false);
      expect((await findCandidates(recording.assetNumber, '2026-10-05T09:00:00Z'))[0]?.is_in_window).toBe(true);
      expect((await findCandidates(recording.assetNumber, '2026-10-09T08:59:59Z'))[0]?.is_in_window).toBe(true);
      expect((await findCandidates(recording.assetNumber, '2026-10-09T09:00:00Z'))[0]?.is_in_window).toBe(false);
    });

    it('runs an overnight window past midnight, belonging to the day it starts', async () => {
      const recording = await testData.createRecording();
      // Fridays only (ISO day 5), 22:00 to 02:00, with the default 10 minutes of grace. 9 Oct 2026 is a Friday.
      await testData.airAd({ recording, station: { timeZone: 'UTC' }, period: ['2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'], windows: [{ days: [5], from: '22:00', to: '02:00' }] });
      const inWindow = async (moment: string) => (await findCandidates(recording.assetNumber, moment))[0]?.is_in_window;
      expect(await inWindow('2026-10-09T23:30:00Z')).toBe(true);
      expect(await inWindow('2026-10-10T01:30:00Z')).toBe(true);
      expect(await inWindow('2026-10-10T02:30:00Z')).toBe(false);
      expect(await inWindow('2026-10-09T21:00:00Z')).toBe(false);
      expect(await inWindow('2026-10-10T23:30:00Z')).toBe(false);
    });

    it('ignores stations that are not active, campaigns that are not active, archived ads, and ads on other recordings', async () => {
      // "Not active" when the clip was heard: a campaign paused or ended after that still counts (the next test).
      const recording = await testData.createRecording();
      for (const status of ['PENDING_VERIFICATION', 'PENDING_REVIEW', 'SUSPENDED', 'REJECTED']) {
        await testData.airAd({ recording, station: { status } });
      }
      for (const campaignStatus of ['DRAFT', 'PAUSED', 'ENDED'] as const) {
        await testData.airAd({ recording, campaignStatus });
      }
      await testData.airAd({ recording, isAdArchived: true });
      // An active station airing another recording is found for that recording only.
      const otherRecording = await testData.createRecording();
      const otherAiring = await testData.airAd({ recording: otherRecording });

      // Heard after every status above was set.
      const heardAt = inOneMinute();
      expect(await findCandidates(recording.assetNumber, heardAt)).toEqual([]);
      expect((await findCandidates(otherRecording.assetNumber, heardAt)).map((row) => row.station_id)).toEqual([otherAiring.stationId]);
    });

    it('P4-TIMERULE-06, P4-TIMERULE-09: a campaign paused or ended after the clip was heard is still a candidate, no longer active; one paused before is none', async () => {
      const recording = await testData.createRecording();
      const paused = await testData.airAd({ recording, hasDefaultCard: true });
      const ended = await testData.airAd({ recording, hasDefaultCard: true });
      const heardBefore = new Date(Date.now() - 10 * 60_000);
      await setupClient.query(`UPDATE app.campaigns SET status = 'PAUSED' WHERE id = $1`, [paused.campaignId]);
      await setupClient.query(`UPDATE app.campaigns SET status = 'ENDED' WHERE id = $1`, [ended.campaignId]);

      const before = await findCandidates(recording.assetNumber, heardBefore);
      expect(before.map((row) => [row.campaign_id, row.is_campaign_active, row.is_in_window]).sort()).toEqual(
        [[paused.campaignId, false, true], [ended.campaignId, false, true]].sort(),
      );
      // The client's default card is there for the API to show instead (O13).
      expect(before.find((row) => row.campaign_id === paused.campaignId)).toMatchObject({
        client_default_action_card_id: paused.defaultCardId,
        client_default_card: paused.defaultCard,
      });
      expect(await findCandidates(recording.assetNumber, inOneMinute())).toEqual([]);

      await setupClient.query(`UPDATE app.campaigns SET status = 'ACTIVE' WHERE id = $1`, [paused.campaignId]);
      expect((await findCandidates(recording.assetNumber, inOneMinute())).map((row) => [row.campaign_id, row.is_campaign_active])).toEqual([[paused.campaignId, true]]);
    });

    it('P4-TIMERULE-09: when a campaign status changed is recorded by the database alone: it moves only when the status changes, and no caller can set it', async () => {
      const recording = await testData.createRecording();
      const airing = await testData.airAd({ recording });
      const statusChangedAt = async () =>
        ((await setupClient.query('SELECT status_changed_at FROM app.campaigns WHERE id = $1', [airing.campaignId])).rows[0].status_changed_at as Date).getTime();
      const asStation = (sql: string) => asLookupApi(apiClient, { stationId: airing.stationId }, (client) => client.query(sql, [airing.campaignId]));
      const madeAt = await statusChangedAt();
      expect(Math.abs(madeAt - Date.now())).toBeLessThan(60_000);

      await asStation(`UPDATE app.campaigns SET name = 'Renamed' WHERE id = $1`);
      expect(await statusChangedAt()).toBe(madeAt);
      await asStation(`UPDATE app.campaigns SET status_changed_at = '2099-01-01T00:00:00Z' WHERE id = $1`);
      await setupClient.query(`UPDATE app.campaigns SET status_changed_at = '2000-01-01T00:00:00Z' WHERE id = $1`, [airing.campaignId]);
      expect(await statusChangedAt()).toBe(madeAt);

      await setupClient.query(`UPDATE app.campaigns SET status = 'PAUSED' WHERE id = $1`, [airing.campaignId]);
      expect(await statusChangedAt()).toBeGreaterThan(madeAt);
      // A campaign made with a time of its own gets the database's instead.
      const madeWithItsOwnTime = randomUUID();
      await setupClient.query(
        `INSERT INTO app.campaigns (id, station_id, ad_id, name, status, active_period, status_changed_at)
         VALUES ($1, $2, $3, 'Draft', 'DRAFT', tstzrange(now(), now() + interval '1 day'), '2000-01-01T00:00:00Z')`,
        [madeWithItsOwnTime, airing.stationId, airing.adId],
      );
      const ownTime = await setupClient.query('SELECT status_changed_at FROM app.campaigns WHERE id = $1', [madeWithItsOwnTime]);
      expect(Math.abs((ownTime.rows[0].status_changed_at as Date).getTime() - Date.now())).toBeLessThan(60_000);
    });

    it('P4-FALLBACK-03: gives the start of the latest slot the clip falls in, and the end of the slot that ended last within 7 days, started in the period', async () => {
      const recording = await testData.createRecording();
      const longPeriod: [string, string] = ['2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z'];
      const overlapping = [
        { days: [1, 2, 3, 4, 5, 6, 7], from: '08:00', to: '12:00' },
        { days: [1, 2, 3, 4, 5, 6, 7], from: '10:00', to: '11:00' },
      ];
      await testData.airAd({ recording, station: { timeZone: 'UTC' }, period: longPeriod, windows: overlapping, gracePeriodMinutes: 0 });
      const slots = async (moment: string, found = recording) => {
        const row = (await findCandidates(found.assetNumber, moment))[0] as Record<string, Date | null>;
        return { started: row.matched_slot_started_at?.toISOString() ?? null, ended: row.last_slot_ended_at?.toISOString() ?? null };
      };
      expect(await slots('2026-10-07T10:30:00Z')).toEqual({ started: '2026-10-07T10:00:00.000Z', ended: '2026-10-06T12:00:00.000Z' });
      expect(await slots('2026-10-07T09:00:00Z')).toEqual({ started: '2026-10-07T08:00:00.000Z', ended: '2026-10-06T12:00:00.000Z' });
      expect(await slots('2026-10-07T13:00:00Z')).toEqual({ started: null, ended: '2026-10-07T12:00:00.000Z' });

      // A period that ended 2 days before the clip gives its last slot; one that ended 9 days before, none.
      const endedRecently = await testData.createRecording();
      await testData.airAd({ recording: endedRecently, station: { timeZone: 'UTC' }, period: ['2026-09-01T00:00:00Z', '2026-10-05T00:00:00Z'], windows: overlapping });
      expect(await slots('2026-10-07T13:00:00Z', endedRecently)).toEqual({ started: null, ended: '2026-10-04T12:00:00.000Z' });
      const endedLongAgo = await testData.createRecording();
      await testData.airAd({ recording: endedLongAgo, station: { timeZone: 'UTC' }, period: ['2026-09-01T00:00:00Z', '2026-09-28T00:00:00Z'], windows: overlapping });
      expect(await slots('2026-10-07T13:00:00Z', endedLongAgo)).toEqual({ started: null, ended: null });
      // A slot that started before the period began did not air in it.
      const startedLate = await testData.createRecording();
      await testData.airAd({ recording: startedLate, station: { timeZone: 'UTC' }, period: ['2026-10-07T09:00:00Z', '2026-11-01T00:00:00Z'], windows: [overlapping[0] as (typeof overlapping)[0]] });
      expect(await slots('2026-10-07T13:00:00Z', startedLate)).toEqual({ started: null, ended: null });
    });

    it('says only whether the campaign has reached its tap limit, read when it is asked', async () => {
      const recording = await testData.createRecording();
      const limited = await testData.airAd({ recording, engagementLimit: 2 });
      const unlimited = await testData.airAd({ recording, engagementLimit: null });
      const isAtLimit = async (airing: StationAiring) =>
        (await findCandidates(recording.assetNumber, new Date())).find((row) => row.campaign_id === airing.campaignId)?.is_at_engagement_limit;
      const setCount = (airing: StationAiring, count: number) =>
        setupClient.query(
          `INSERT INTO app.campaign_counters (campaign_id, station_id, counted_engagement_count) VALUES ($1, $2, $3)
           ON CONFLICT (campaign_id) DO UPDATE SET counted_engagement_count = excluded.counted_engagement_count`,
          [airing.campaignId, airing.stationId, count],
        );
      expect(await isAtLimit(limited)).toBe(false);
      await setCount(limited, 1);
      expect(await isAtLimit(limited)).toBe(false);
      await setCount(limited, 2);
      expect(await isAtLimit(limited)).toBe(true);
      await setCount(unlimited, 500);
      expect(await isAtLimit(unlimited)).toBe(false);
    });

    it('lists every station that owns the audio, each with its own card and its client’s default card', async () => {
      const recording = await testData.createRecording();
      const stationA = await testData.airAd({ recording, period: ['2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'], windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '08:00', to: '10:00' }] });
      const stationB = await testData.airAd({
        recording,
        hasCampaignCard: false,
        hasDefaultCard: true,
        period: ['2026-10-02T00:00:00Z', '2026-11-01T00:00:00Z'],
        windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '12:00', to: '13:00' }],
      });
      const rows = await findCandidates(recording.assetNumber, '2026-10-07T06:30:00Z');
      const byStation = (stationId: string) => rows.find((row) => row.station_id === stationId);
      expect(rows.map((row) => row.station_id).sort()).toEqual([stationA.stationId, stationB.stationId].sort());
      expect(byStation(stationA.stationId)).toMatchObject({ is_in_window: true, campaign_action_card_id: stationA.campaignCardId, campaign_card: stationA.campaignCard });
      expect(byStation(stationB.stationId)).toMatchObject({
        is_in_window: false,
        campaign_action_card_id: null,
        client_default_action_card_id: stationB.defaultCardId,
        client_default_card: stationB.defaultCard,
      });
    });

    it('Correction 3: a station that is not listed in the app is a candidate like any other', async () => {
      const recording = await testData.createRecording();
      const unlisted = await testData.airAd({ recording, station: { isListedInApp: false } });
      expect((await findCandidates(recording.assetNumber, new Date())).map((row) => row.station_id)).toEqual([unlisted.stationId]);
    });

    it('P4-CHOOSER-07: carries the city of the station, or none', async () => {
      const recording = await testData.createRecording();
      const withCity = await testData.airAd({ recording, station: { city: 'Kitwe' } });
      const withoutCity = await testData.airAd({ recording, station: { city: null } });
      const rows = await findCandidates(recording.assetNumber, new Date());
      expect(rows.find((row) => row.station_id === withCity.stationId)?.station_city).toBe('Kitwe');
      expect(rows.find((row) => row.station_id === withoutCity.stationId)?.station_city).toBeNull();
    });

    it('as the API role with no station context, the tables behind it show nothing directly', async () => {
      await testData.airAd({ recording: await testData.createRecording() });
      for (const table of ['app.ads', 'app.campaigns', 'app.action_cards', 'app.recognition_candidates', 'app.engagement_events', 'app.campaign_counters']) {
        expect((await apiClient.query(`SELECT count(*)::integer AS visible FROM ${table}`)).rows[0].visible, table).toBe(0);
      }
      await expect(apiClient.query('SELECT 1 FROM fingerprints.audio_assets LIMIT 1')).rejects.toThrow(/permission denied/);
    });
  });

  // ---- recognition.finish_recognition --------------------------------------------------------------------
  describe('recognition.finish_recognition', () => {
    it('P4-RESOLUTION-12: a two-station chooser writes two candidate rows with the right campaign, card and in-window values, neither chosen', async () => {
      const { recording, stationA, stationB, claimed } = await twoStationsOnAir();
      expect(
        await testData.finish(apiClient, claimed, {
          outcome: 'CHOOSE_STATION',
          resolution: 'UNRESOLVED',
          recording,
          candidates: [candidate(stationB, { displayPosition: 1 }), candidate(stationA, { displayPosition: 2 })],
        }),
      ).toBe(true);
      expect(await candidateRows(claimed.recognition_id)).toEqual([
        { station_id: stationB.stationId, campaign_id: stationB.campaignId, action_card_id: stationB.campaignCardId, card_kind: 'CAMPAIGN', is_in_window: true, display_position: 1, is_chosen: false, chosen_at: null },
        { station_id: stationA.stationId, campaign_id: stationA.campaignId, action_card_id: stationA.campaignCardId, card_kind: 'CAMPAIGN', is_in_window: true, display_position: 2, is_chosen: false, chosen_at: null },
      ]);
      // The recognition itself names no station until the listener chooses.
      expect(await eventRow(claimed.recognition_id)).toMatchObject({ outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED', station_id: null, campaign_id: null, action_card_id: null });
    });

    it('P4-D8: a single-owner match writes one row, and a schedule-unique match writes a row for each owner with a card, only the winner in window', async () => {
      const recording = await testData.createRecording();
      const onlyOwner = await testData.airAd({ recording });
      const installId = await testData.createInstall();
      const single = await testData.claim(apiClient, installId);
      await testData.finish(apiClient, single, { outcome: 'MATCH', resolution: 'SINGLE_OWNER', recording, shown: shownCampaignCard(onlyOwner), candidates: [candidate(onlyOwner)] });
      expect(await candidateRows(single.recognition_id)).toEqual([
        expect.objectContaining({ station_id: onlyOwner.stationId, card_kind: 'CAMPAIGN', is_in_window: true, display_position: null, is_chosen: false }),
      ]);
      expect(await eventRow(single.recognition_id)).toMatchObject({ outcome: 'MATCH', resolution: 'SINGLE_OWNER', station_id: onlyOwner.stationId });

      const sharedRecording = await testData.createRecording();
      const onAir = await testData.airAd({ recording: sharedRecording });
      const offAir = await testData.airAd({ recording: sharedRecording, hasDefaultCard: true, windows: [{ days: [1], from: '03:00', to: '03:15' }] });
      const scheduleUnique = await testData.claim(apiClient, installId);
      await testData.finish(apiClient, scheduleUnique, {
        outcome: 'MATCH',
        resolution: 'SCHEDULE_UNIQUE',
        recording: sharedRecording,
        shown: shownCampaignCard(onAir),
        candidates: [candidate(onAir), candidate(offAir, { kind: 'CLIENT_DEFAULT', isInWindow: false })],
      });
      expect((await candidateRows(scheduleUnique.recognition_id)).map((row) => [row.station_id, row.card_kind, row.is_in_window, row.display_position]).sort()).toEqual(
        [[onAir.stationId, 'CAMPAIGN', true, null], [offAir.stationId, 'CLIENT_DEFAULT', false, null]].sort(),
      );
    });

    it.each([
      ['MATCH', 'SINGLE_OWNER', true],
      ['MATCH', 'SCHEDULE_UNIQUE', true],
      ['MATCH', 'HINT', true],
      ['MATCH_DEFAULT', 'SINGLE_OWNER', true],
      ['MATCH_DEFAULT', 'HINT', true],
      ['CHOOSE_STATION', 'UNRESOLVED', true],
      ['NO_MATCH', null, true],
      ['MATCH', null, false],
      ['MATCH', 'UNRESOLVED', false],
      ['MATCH', 'LISTENER_CHOICE', false],
      ['MATCH_DEFAULT', 'UNRESOLVED', false],
      ['CHOOSE_STATION', 'SINGLE_OWNER', false],
      ['CHOOSE_STATION', 'LISTENER_CHOICE', false],
      ['CHOOSE_STATION', null, false],
      ['NO_MATCH', 'SINGLE_OWNER', false],
      ['MATCH', 'FIRST_COME', false],
    ])('P4-RESOLUTION-11: a %s finished with the resolution %s is stored: %s', async (outcome, resolution, isStored) => {
      const { recording, stationA, stationB, claimed } = await twoStationsOnAir();
      const isMatch = outcome === 'MATCH' || outcome === 'MATCH_DEFAULT';
      const kind = outcome === 'MATCH_DEFAULT' ? 'CLIENT_DEFAULT' : 'CAMPAIGN';
      const finishing = testData.finish(apiClient, claimed, {
        outcome,
        resolution,
        recording,
        shown: isMatch ? { ...shownCampaignCard(stationA), cardId: (kind === 'CAMPAIGN' ? stationA.campaignCardId : stationA.defaultCardId) as string } : null,
        candidates: isMatch
          ? [candidate(stationA, { kind })]
          : outcome === 'CHOOSE_STATION'
            ? [candidate(stationA, { displayPosition: 1 }), candidate(stationB, { displayPosition: 2 })]
            : [],
      });
      if (isStored) {
        expect(await finishing).toBe(true);
        expect(await eventRow(claimed.recognition_id)).toMatchObject({ outcome, resolution });
      } else {
        await expect(finishing).rejects.toThrow(/resolution/);
        expect(await eventRow(claimed.recognition_id)).toMatchObject({ outcome: 'PENDING', resolution: null });
        expect(await candidateRows(claimed.recognition_id)).toEqual([]);
      }
    });

    it('P4-RESOLUTION-11: the table itself refuses a resolution that does not fit the outcome, and an unknown one', async () => {
      const { claimed } = await twoStationsOnAir();
      const update = (sql: string) => setupClient.query(sql, [claimed.recognition_id]);
      await expect(update(`UPDATE app.recognition_events SET outcome = 'NO_MATCH', resolution = 'GUESSED' WHERE id = $1`)).rejects.toThrow(/recognition_events_resolution_check/);
      await expect(update(`UPDATE app.recognition_events SET outcome = 'MATCH' WHERE id = $1`)).rejects.toThrow(/recognition_events_resolution_outcome_check/);
      await expect(update(`UPDATE app.recognition_events SET outcome = 'CHOOSE_STATION', resolution = 'HINT' WHERE id = $1`)).rejects.toThrow(/recognition_events_resolution_outcome_check/);
      await expect(update(`UPDATE app.recognition_events SET outcome = 'BUSY', resolution = 'UNRESOLVED' WHERE id = $1`)).rejects.toThrow(/recognition_events_resolution_outcome_check/);
      // A chooser keeps its outcome after the listener's choice.
      await update(`UPDATE app.recognition_events SET outcome = 'CHOOSE_STATION', resolution = 'LISTENER_CHOICE' WHERE id = $1`);
    });

    it('P4-RESOLUTION-10: the hint is stored only for a station that exists, and nothing without one', async () => {
      const { recording, stationA, installId } = await twoStationsOnAir();
      const suspendedStation = await testData.createStation({ status: 'SUSPENDED' });
      const storedHint = async (hintedStationId: string | null) => {
        const claimed = await testData.claim(apiClient, installId);
        await testData.finish(apiClient, claimed, { outcome: 'MATCH', resolution: 'HINT', recording, hintedStationId, shown: shownCampaignCard(stationA), candidates: [candidate(stationA)] });
        return (await eventRow(claimed.recognition_id)).hinted_station_id;
      };
      expect(await storedHint(stationA.stationId)).toBe(stationA.stationId);
      expect(await storedHint(suspendedStation)).toBe(suspendedStation);
      expect(await storedHint(randomUUID())).toBeNull();
      expect(await storedHint(null)).toBeNull();
    });

    it.each([
      ['a chooser showing one station', 'one shown', /2 to 4 stations/],
      ['a chooser whose positions skip a number', 'positions 1 and 3', /positions 1 to n/],
      ['a chooser showing one position twice', 'position 1 twice', /positions 1 to n/],
      ['a chooser that names a station before the choice', 'station named', /a match names its station/],
      ['a station weighed twice', 'station twice', /weighed once/],
      ['a weighed station with a card of another client', 'foreign card', /do not belong together/],
      ['a match whose station was not weighed', 'match not weighed', /one of the weighed stations/],
      ['a campaign match shown with the client default card', 'wrong kind', /do not belong together/],
      ['a match with an order of stations', 'positions on a match', /only a chooser shows stations in an order/],
      ['a no-match that weighs stations', 'weighs stations', /only a match or a chooser weighs stations/],
      ['a weighed station with no card kind', 'no kind', /each weighed station names/],
    ])('refuses %s, and stores nothing', async (_case, shape, reason) => {
      const { recording, stationA, stationB, claimed } = await twoStationsOnAir();
      const otherClientCard = await testData.createCard(stationA.stationId, await testData.createClient(stationA.stationId, 'Brand B'));
      const shapes: Record<string, Parameters<StationResolutionTestData['finish']>[2]> = {
        'one shown': { outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED', candidates: [candidate(stationA, { displayPosition: 1 }), candidate(stationB)] },
        'positions 1 and 3': { outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED', candidates: [candidate(stationA, { displayPosition: 1 }), candidate(stationB, { displayPosition: 3 })] },
        'position 1 twice': { outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED', candidates: [candidate(stationA, { displayPosition: 1 }), candidate(stationB, { displayPosition: 1 })] },
        'station named': { outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED', shown: shownCampaignCard(stationA), candidates: [candidate(stationA, { displayPosition: 1 }), candidate(stationB, { displayPosition: 2 })] },
        'station twice': { outcome: 'MATCH', resolution: 'SINGLE_OWNER', shown: shownCampaignCard(stationA), candidates: [candidate(stationA), candidate(stationA, { kind: 'CLIENT_DEFAULT' })] },
        'foreign card': { outcome: 'MATCH', resolution: 'SINGLE_OWNER', shown: shownCampaignCard(stationA), candidates: [{ ...candidate(stationA), action_card_id: otherClientCard.cardId }] },
        'match not weighed': { outcome: 'MATCH', resolution: 'SCHEDULE_UNIQUE', shown: shownCampaignCard(stationA), candidates: [candidate(stationB)] },
        'wrong kind': { outcome: 'MATCH', resolution: 'SINGLE_OWNER', shown: { ...shownCampaignCard(stationA), cardId: stationA.defaultCardId as string }, candidates: [candidate(stationA, { kind: 'CLIENT_DEFAULT' })] },
        'positions on a match': { outcome: 'MATCH', resolution: 'SINGLE_OWNER', shown: shownCampaignCard(stationA), candidates: [candidate(stationA, { displayPosition: 1 })] },
        'weighs stations': { outcome: 'NO_MATCH', candidates: [candidate(stationA)] },
        'no kind': { outcome: 'MATCH', resolution: 'SINGLE_OWNER', shown: shownCampaignCard(stationA), candidates: [{ ...candidate(stationA), card_kind: undefined as unknown as 'CAMPAIGN' }] },
      };
      await expect(testData.finish(apiClient, claimed, { recording, ...(shapes[shape] as Parameters<StationResolutionTestData['finish']>[2]) })).rejects.toThrow(reason);
      expect(await eventRow(claimed.recognition_id)).toMatchObject({ outcome: 'PENDING', station_id: null });
      expect(await candidateRows(claimed.recognition_id)).toEqual([]);
    });

    it('refuses a chooser showing five stations', async () => {
      const { recording, stationA, stationB, claimed } = await twoStationsOnAir();
      const more = [await testData.airAd({ recording }), await testData.airAd({ recording }), await testData.airAd({ recording })];
      const shown = [stationA, stationB, ...more].map((airing, index) => candidate(airing, { displayPosition: index + 1 }));
      await expect(testData.finish(apiClient, claimed, { outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED', recording, candidates: shown })).rejects.toThrow(/2 to 4 stations/);
      await testData.finish(apiClient, claimed, { outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED', recording, candidates: shown.slice(0, 4) });
      expect((await candidateRows(claimed.recognition_id)).map((row) => row.display_position)).toEqual([1, 2, 3, 4]);
    });
  });

  // ---- recognition.describe_recognition_for_replay -------------------------------------------------------
  describe('recognition.describe_recognition_for_replay', () => {
    const describeForReplay = async (claimed: { recognition_id: string; recognition_received_at: Date }, installId: string) =>
      apiClient.query('SELECT * FROM recognition.describe_recognition_for_replay($1, $2, $3)', [claimed.recognition_id, claimed.recognition_received_at, installId]);

    it('describes a finished recognition to the install that made it, and to no other', async () => {
      const recording = await testData.createRecording();
      const airing = await testData.airAd({ recording, station: { city: 'Lusaka' } });
      const installId = await testData.createInstall();
      const claimed = await testData.claim(apiClient, installId);
      await testData.finish(apiClient, claimed, { outcome: 'MATCH', resolution: 'SINGLE_OWNER', recording, shown: shownCampaignCard(airing), candidates: [candidate(airing)] });

      // What it is given must belong together: another station's campaign, or a card that is neither the
      // campaign's nor its client's default, is refused.
      const otherStation = await testData.airAd({ recording: await testData.createRecording() });
      const another = await testData.claim(apiClient, installId);
      for (const shown of [
        { stationId: otherStation.stationId, campaignId: airing.campaignId, cardId: airing.campaignCardId as string },
        { stationId: airing.stationId, campaignId: airing.campaignId, cardId: otherStation.campaignCardId as string },
      ]) {
        await expect(testData.finish(apiClient, another, { outcome: 'MATCH', resolution: 'SINGLE_OWNER', recording, shown, candidates: [candidate(airing)] })).rejects.toThrow(/belong together/);
      }
      await expect(testData.finish(apiClient, another, { outcome: 'MATCH', resolution: 'SINGLE_OWNER', recording, shown: { ...shownCampaignCard(airing), cardId: null as unknown as string }, candidates: [candidate(airing)] })).rejects.toThrow(/come together/);

      const described = await describeForReplay(claimed, installId);
      expect(described.rows).toEqual([
        {
          outcome: 'MATCH',
          is_deferred: false,
          captured_at: claimed.recognition_captured_at,
          display_position: null,
          card_kind: 'CAMPAIGN',
          station_id: airing.stationId,
          station_name: expect.any(String),
          station_frequency_label: '98.1 FM',
          station_city: 'Lusaka',
          is_station_active: true,
          client_name: 'Brand A',
          ad_title: 'Summer service offer',
          action_card: airing.campaignCard,
        },
      ]);
      expect(described.fields.map((field) => field.name)).toEqual(REPLAY_COLUMNS);
      expect((await describeForReplay(claimed, await testData.createInstall())).rows).toEqual([]);

      const stored = (await setupClient.query('SELECT audio_asset_id, aligned_hash_count, match_margin, latency_milliseconds, fingerprint_version FROM app.recognition_events WHERE id = $1', [claimed.recognition_id])).rows[0];
      expect(stored).toEqual({ audio_asset_id: recording.assetId, aligned_hash_count: 40, match_margin: 3.5, latency_milliseconds: 300, fingerprint_version: 1 });
    });

    it('a chooser is one row per shown station in display order, before and after the choice; a station weighed but not shown is left out', async () => {
      const { recording, stationA, stationB, installId, claimed } = await twoStationsOnAir();
      const offAir = await testData.airAd({ recording, hasDefaultCard: true, windows: [{ days: [1], from: '03:00', to: '03:15' }] });
      await testData.finish(apiClient, claimed, {
        outcome: 'CHOOSE_STATION',
        resolution: 'UNRESOLVED',
        recording,
        candidates: [candidate(stationB, { displayPosition: 1 }), candidate(stationA, { displayPosition: 2 }), candidate(offAir, { kind: 'CLIENT_DEFAULT', isInWindow: false })],
      });
      const shownStations = async () => (await describeForReplay(claimed, installId)).rows.map((row) => [row.outcome, row.display_position, row.station_id, row.card_kind, row.action_card]);
      const expected = [
        ['CHOOSE_STATION', 1, stationB.stationId, 'CAMPAIGN', stationB.campaignCard],
        ['CHOOSE_STATION', 2, stationA.stationId, 'CAMPAIGN', stationA.campaignCard],
      ];
      expect(await shownStations()).toEqual(expected);
      expect((await apiClient.query('SELECT recognition.record_station_choice($1, $2, $3) AS answer', [claimed.recognition_id, installId, stationA.stationId])).rows[0].answer).toBe('CHOSEN');
      expect(await shownStations()).toEqual(expected);
    });

    it('P4-D13: marks a station suspended since the first answer, so the API can leave it out', async () => {
      const recording = await testData.createRecording();
      const airing = await testData.airAd({ recording });
      const installId = await testData.createInstall();
      const claimed = await testData.claim(apiClient, installId);
      await testData.finish(apiClient, claimed, { outcome: 'MATCH', resolution: 'SINGLE_OWNER', recording, shown: shownCampaignCard(airing), candidates: [candidate(airing)] });
      await setupClient.query(`UPDATE app.stations SET status = 'SUSPENDED' WHERE id = $1`, [airing.stationId]);
      expect((await describeForReplay(claimed, installId)).rows.map((row) => [row.station_id, row.is_station_active])).toEqual([[airing.stationId, false]]);
    });

    it('a recognition with no station shown is one row without a station', async () => {
      const installId = await testData.createInstall();
      const claimed = await testData.claim(apiClient, installId);
      await testData.finish(apiClient, claimed, { outcome: 'NO_MATCH', fallbackReason: 'no_station_airs_it' });
      expect((await describeForReplay(claimed, installId)).rows).toEqual([
        expect.objectContaining({ outcome: 'NO_MATCH', display_position: null, card_kind: null, station_id: null, is_station_active: null, action_card: null }),
      ]);
    });
  });

  // ---- recognition.claim_recognition (created again in P4) -----------------------------------------------
  describe('recognition.claim_recognition, created again in P4', () => {
    const rowCount = async (installId: string, key: string) =>
      (
        await setupClient.query(
          `SELECT (SELECT count(*)::integer FROM app.recognition_events WHERE listener_install_id = $1 AND idempotency_key = $2) AS events,
                  (SELECT count(*)::integer FROM app.recognition_idempotency_keys WHERE listener_install_id = $1 AND idempotency_key = $2) AS held_keys`,
          [installId, key],
        )
      ).rows[0];

    it('P4-IDEMPOTENCY-01: a second claim of the same key inserts no row, and returns the documented columns', async () => {
      const installId = await testData.createInstall();
      const key = randomUUID();
      const first = await testData.claim(apiClient, installId, { key });
      expect(first.claim_outcome).toBe('CLAIMED');
      expect(await rowCount(installId, key)).toEqual({ events: 1, held_keys: 1 });
      const second = await testData.claim(apiClient, installId, { key });
      expect(second).toMatchObject({ recognition_id: first.recognition_id, claim_outcome: 'IN_PROGRESS' });
      expect(await rowCount(installId, key)).toEqual({ events: 1, held_keys: 1 });
      expect(Object.keys(second)).toEqual(CLAIM_COLUMNS);
    });

    it('P4-IDEMPOTENCY-04: two claims of one key at the same moment leave one recognition, claimed once', async () => {
      const otherApiClient = lookupApiClient();
      await otherApiClient.connect();
      try {
        const installId = await testData.createInstall();
        const key = randomUUID();
        const receivedAt = new Date();
        const claims = await Promise.all([apiClient, otherApiClient].map((client) => testData.claim(client, installId, { key, receivedAt })));
        expect(claims.map((claimed) => claimed.claim_outcome).sort()).toEqual(['CLAIMED', 'IN_PROGRESS']);
        expect(new Set(claims.map((claimed) => claimed.recognition_id)).size).toBe(1);
        expect(await rowCount(installId, key)).toEqual({ events: 1, held_keys: 1 });
      } finally {
        await otherApiClient.end();
      }
    });

    it('P4-IDEMPOTENCY-16, P4-IDEMPOTENCY-22, P4-DEFERRED-01: a retry keeps and returns the first receipt and capture times, and is deferred if either attempt was, never turned back', async () => {
      const installId = await testData.createInstall();
      const key = randomUUID();
      const firstReceivedAt = new Date(Date.now() - 10 * 60_000);
      const first = await testData.claim(apiClient, installId, { key, receivedAt: firstReceivedAt, capturedAt: new Date(firstReceivedAt.getTime() - 5_000), isDeferred: false });
      expect(first).toMatchObject({ claim_outcome: 'CLAIMED', is_deferred: false, recognition_captured_at: new Date(firstReceivedAt.getTime() - 5_000) });
      await testData.finish(apiClient, first, { outcome: 'BUSY', fallbackReason: 'queue_too_deep' });

      // Sent again from the outbox minutes later, with its own (different) times: the first ones stay.
      const retried = await testData.claim(apiClient, installId, { key, receivedAt: new Date(), capturedAt: new Date(Date.now() - 1_000), isDeferred: true });
      expect(retried).toMatchObject({
        recognition_id: first.recognition_id,
        recognition_received_at: first.recognition_received_at,
        recognition_captured_at: first.recognition_captured_at,
        attempt_number: 2,
        claim_outcome: 'RECLAIMED',
        previous_outcome: 'BUSY',
        is_deferred: true,
      });
      expect(await eventRow(first.recognition_id)).toMatchObject({ received_at: first.recognition_received_at, captured_at: first.recognition_captured_at, is_deferred: true });

      await testData.finish(apiClient, retried, { outcome: 'TIMEOUT' });
      const liveAgain = await testData.claim(apiClient, installId, { key, isDeferred: false });
      expect(liveAgain).toMatchObject({ claim_outcome: 'RECLAIMED', attempt_number: 3, is_deferred: true });
      expect((await eventRow(first.recognition_id)).is_deferred).toBe(true);
      await testData.finish(apiClient, liveAgain, { outcome: 'NO_MATCH' });
      expect(await testData.claim(apiClient, installId, { key, isDeferred: false })).toMatchObject({ claim_outcome: 'FINISHED', is_deferred: true, recognition_captured_at: first.recognition_captured_at });
    });

    it('P4-CLOCK-04: stores the exact clock skew of a phone 30 days off, beyond what an integer holds', async () => {
      const installId = await testData.createInstall();
      const thirtyDays = 30 * 86_400_000;
      expect(thirtyDays).toBeGreaterThan(2 ** 31);
      const claimed = await testData.claim(apiClient, installId, { clockSkewMilliseconds: -thirtyDays });
      const stored = await setupClient.query('SELECT clock_skew_milliseconds::text AS skew, pg_typeof(clock_skew_milliseconds)::text AS type FROM app.recognition_events WHERE id = $1', [claimed.recognition_id]);
      expect(stored.rows[0]).toEqual({ skew: String(-thirtyDays), type: 'bigint' });
    });
  });

  // ---- recognition.count_recognition_attempts ------------------------------------------------------------
  it('ALL-DATABASE-08: count_recognition_attempts gives no count for an unknown key or for the key of another install, and the attempts of a key the install holds', async () => {
    const installId = await testData.createInstall();
    const otherInstallId = await testData.createInstall();
    const key = randomUUID();
    const attempts = async (askingInstallId: string, askedKey: string) =>
      (await apiClient.query('SELECT recognition.count_recognition_attempts($1, $2) AS attempt_count', [askingInstallId, askedKey])).rows[0].attempt_count as number | null;
    expect(await attempts(installId, key)).toBeNull();
    const claimed = await testData.claim(apiClient, installId, { key });
    expect(await attempts(installId, key)).toBe(1);
    expect(await attempts(otherInstallId, key)).toBeNull();
    await testData.finish(apiClient, claimed, { outcome: 'TIMEOUT' });
    await testData.claim(apiClient, installId, { key });
    expect(await attempts(installId, key)).toBe(2);
  });

  // ---- finding a recognition by its id ------------------------------------------------------------------
  describe('finding a recognition by its id', () => {
    it('bounds the receipt time from five minutes before to one minute after the time in the id, with immutable helpers', async () => {
      const madeAt = Date.UTC(2026, 9, 11, 12, 0, 0, 123);
      const recognitionId = recognitionIdAt(madeAt);
      const bounds = await setupClient.query('SELECT recognition.compute_earliest_receipt_time($1) AS earliest, recognition.compute_latest_receipt_time($1) AS latest', [recognitionId]);
      expect(bounds.rows[0]).toEqual({ earliest: new Date(madeAt - 5 * 60_000), latest: new Date(madeAt + 60_000) });
      const volatility = await setupClient.query(
        `SELECT proname, provolatile FROM pg_proc WHERE pronamespace = 'recognition'::regnamespace AND proname IN ('compute_earliest_receipt_time', 'compute_latest_receipt_time') ORDER BY proname`,
      );
      expect(volatility.rows).toEqual([
        { proname: 'compute_earliest_receipt_time', provolatile: 'i' },
        { proname: 'compute_latest_receipt_time', provolatile: 'i' },
      ]);
    });

    /** The partitions of recognition_events a plan reads. */
    const partitionsRead = (plan: unknown): string[] => {
      const found: string[] = [];
      const visit = (node: Record<string, unknown>) => {
        const relation = node['Relation Name'];
        if (typeof relation === 'string' && relation.startsWith('recognition_events')) found.push(relation);
        for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) visit(child);
      };
      visit((plan as Array<{ Plan: Record<string, unknown> }>)[0]?.Plan as Record<string, unknown>);
      return found;
    };

    it('P4-DATABASE-06: a lookup between those bounds reads at most two monthly partitions, as written and as a prepared statement, where a range test reads them all', async () => {
      const recognitionId = recognitionIdAt(Date.now());
      const lookup = `SELECT event.id FROM app.recognition_events AS event
                       WHERE event.id = $1 AND event.received_at >= recognition.compute_earliest_receipt_time($1)
                         AND event.received_at <= recognition.compute_latest_receipt_time($1)`;
      const asWritten = await setupClient.query(`EXPLAIN (FORMAT JSON) ${lookup.replaceAll('$1', `'${recognitionId}'::uuid`)}`);
      const writtenPartitions = partitionsRead(asWritten.rows[0]['QUERY PLAN']);
      expect(writtenPartitions.length).toBeGreaterThanOrEqual(1);
      expect(writtenPartitions.length).toBeLessThanOrEqual(2);
      expect(writtenPartitions).not.toContain('recognition_events_default');

      // A function's statement may be planned once for every id: the bounds then prune when it runs.
      await setupClient.query('BEGIN');
      try {
        await setupClient.query(`SET LOCAL plan_cache_mode = force_generic_plan`);
        await setupClient.query(`PREPARE recognition_lookup(uuid) AS ${lookup}`);
        const prepared = await setupClient.query(`EXPLAIN (FORMAT JSON) EXECUTE recognition_lookup('${recognitionId}')`);
        expect(partitionsRead(prepared.rows[0]['QUERY PLAN']).length).toBeLessThanOrEqual(2);
      } finally {
        await setupClient.query('ROLLBACK');
        await setupClient.query('DEALLOCATE ALL');
      }

      const partitionCount = (await setupClient.query(`SELECT count(*)::integer AS partitions FROM pg_inherits WHERE inhparent = 'app.recognition_events'::regclass`)).rows[0].partitions as number;
      expect(partitionCount).toBeGreaterThan(2);
      const asRange = await setupClient.query(
        `EXPLAIN (FORMAT JSON) SELECT event.id FROM app.recognition_events AS event WHERE event.id = '${recognitionId}'::uuid
           AND event.received_at <@ tstzrange(recognition.compute_earliest_receipt_time('${recognitionId}'), recognition.compute_latest_receipt_time('${recognitionId}'), '[]')`,
      );
      expect(partitionsRead(asRange.rows[0]['QUERY PLAN'])).toHaveLength(partitionCount);
    });

    it('P4-DATABASE-06: every function that finds a recognition by its id alone uses those bounds, never a range test', async () => {
      const bodies = await setupClient.query(
        `SELECT proname, prosrc FROM pg_proc WHERE pronamespace = 'recognition'::regnamespace
            AND proname IN ('record_station_choice', 'record_engagement', 'record_recognition_report') ORDER BY proname`,
      );
      expect(bodies.rows.map((row) => row.proname)).toEqual(['record_engagement', 'record_recognition_report', 'record_station_choice']);
      for (const { proname, prosrc } of bodies.rows as Array<{ proname: string; prosrc: string }>) {
        expect(prosrc, proname).toMatch(/event\.received_at >= recognition\.compute_earliest_receipt_time\(\w+\)/);
        expect(prosrc, proname).toMatch(/event\.received_at <= recognition\.compute_latest_receipt_time\(\w+\)/);
        expect(prosrc, proname).not.toContain('<@');
      }
    });
  });

  // ---- the rules the tables keep ---------------------------------------------------------------------------
  describe('the rules the tables keep', () => {
    /** Runs a statement as the setup user that must be refused by the named constraint, inside a transaction that is rolled back. */
    const expectRefusedBy = async (constraintName: string, sql: string, parameters: unknown[]) => {
      await setupClient.query('BEGIN');
      try {
        await expect(setupClient.query(sql, parameters)).rejects.toThrow(constraintName);
      } finally {
        await setupClient.query('ROLLBACK');
      }
    };
    const insertRecognition = (capturedAt: Date, receivedAt: Date, installId: string) =>
      setupClient.query(
        `INSERT INTO app.recognition_events (id, listener_install_id, idempotency_key, request_id, captured_at, received_at, outcome)
         VALUES ($1, $2, $3, 'test', $4, $5, 'PENDING')`,
        [randomUUID(), installId, randomUUID(), capturedAt, receivedAt],
      );

    it('P4-CLOCK-08: a recognition heard more than 24 hours before it arrived, or more than 2 minutes after, is refused by recognition_events_captured_at_check; the exact bounds are kept', async () => {
      const installId = await testData.createInstall();
      const receivedAt = new Date();
      for (const capturedAt of [new Date(receivedAt.getTime() - 24 * 3_600_000 - 1_000), new Date(receivedAt.getTime() + 2 * 60_000 + 1_000)]) {
        await setupClient.query('BEGIN');
        try {
          await expect(insertRecognition(capturedAt, receivedAt, installId)).rejects.toThrow(/recognition_events_captured_at_check/);
        } finally {
          await setupClient.query('ROLLBACK');
        }
      }
      await setupClient.query('BEGIN');
      try {
        await insertRecognition(new Date(receivedAt.getTime() - 24 * 3_600_000), receivedAt, installId);
        await insertRecognition(new Date(receivedAt.getTime() + 2 * 60_000), receivedAt, installId);
      } finally {
        await setupClient.query('ROLLBACK');
      }
    });

    it('P4-LIMITS-01: a tap limit must be above zero, and none means no limit', async () => {
      const airing = await testData.airAd({ recording: await testData.createRecording() });
      for (const limit of [0, -1]) {
        await expectRefusedBy('campaigns_engagement_limit_check', 'UPDATE app.campaigns SET engagement_limit = $2 WHERE id = $1', [airing.campaignId, limit]);
      }
      for (const limit of [1, null]) {
        await setupClient.query('UPDATE app.campaigns SET engagement_limit = $2 WHERE id = $1', [airing.campaignId, limit]);
      }
    });

    it('a grace period is from 0 to 60 minutes', async () => {
      const airing = await testData.airAd({ recording: await testData.createRecording() });
      for (const grace of ['61 minutes', '-1 minutes', '1 day']) {
        await expectRefusedBy('campaigns_time_window_grace_period_check', 'UPDATE app.campaigns SET time_window_grace_period = $2::interval WHERE id = $1', [airing.campaignId, grace]);
      }
      for (const grace of ['0 minutes', '60 minutes', '20 minutes']) {
        await setupClient.query('UPDATE app.campaigns SET time_window_grace_period = $2::interval WHERE id = $1', [airing.campaignId, grace]);
      }
    });

    it('P4-CHOOSER-07: the city of a station is none, or 1 to 80 characters and not blank', async () => {
      const stationId = await testData.createStation();
      for (const city of ['x'.repeat(81), '', '   ']) {
        await expectRefusedBy('stations_city_check', 'UPDATE app.stations SET city = $2 WHERE id = $1', [stationId, city]);
      }
      for (const city of ['x'.repeat(80), 'Kitwe', null]) {
        await setupClient.query('UPDATE app.stations SET city = $2 WHERE id = $1', [stationId, city]);
      }
    });
  });
});
