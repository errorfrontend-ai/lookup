import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveStation, type StationCandidateRow } from '../src/features/recognition/resolve-station.js';
import { databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { type Recording, StationResolutionTestData } from './support/station-resolution-test-data.js';

/**
 * P4-TIMERULE-08: which time decides each fact of station resolution (P4 design §5.1, P4-D5). The time window,
 * the campaign's period and the set of candidates follow the moment the clip was heard; the tap limit, the
 * station's suspension and the card version follow the moment the clip is processed. Each case is one where the
 * two times give different answers: the clip is heard 3 hours before it is processed, something changes in
 * between, and the database answers as the named time says. The second table runs the same six facts on through
 * resolveStation, the API's half, to what the listener is shown.
 */
describe('which time decides: capture or processing (database)', () => {
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

  const THREE_HOURS = 3 * 3_600_000;
  /** Claims a clip heard 3 hours ago and processed now; resolves to what the database finds for it. */
  const heardThreeHoursAgo = async (recording: Recording) => {
    const installId = await testData.createInstall();
    const claimed = await testData.claim(apiClient, installId, { receivedAt: new Date(), capturedAt: new Date(Date.now() - THREE_HOURS) });
    return async () =>
      (await apiClient.query('SELECT * FROM recognition.find_station_candidates($1, $2)', [recording.assetNumber, claimed.recognition_captured_at])).rows as Array<
        Record<string, unknown>
      >;
  };
  const utcClock = (moment: Date) => moment.toISOString().slice(11, 16);
  const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000);

  it.each([
    [
      'the time window follows the capture time: heard in its slot, processed after the slot ended, the clip is on air',
      async () => {
        const recording = await testData.createRecording();
        // A slot from 4 hours ago to 2 hours ago, every day, with no grace: on air when heard, over when processed.
        await testData.airAd({ recording, station: { timeZone: 'UTC' }, gracePeriodMinutes: 0, windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: utcClock(hoursFromNow(-4)), to: utcClock(hoursFromNow(-2)) }] });
        const found = await (await heardThreeHoursAgo(recording))();
        return { atCapture: found[0]?.is_in_window, expected: true };
      },
    ],
    [
      'the campaign period follows the capture time: heard before the period ended, processed after, the clip is on air',
      async () => {
        const recording = await testData.createRecording();
        await testData.airAd({ recording, period: [hoursFromNow(-48).toISOString(), hoursFromNow(-1).toISOString()] });
        const found = await (await heardThreeHoursAgo(recording))();
        return { atCapture: found[0]?.is_in_window, expected: true };
      },
    ],
    [
      'the candidates follow the capture time: a campaign paused after the clip was heard still makes its station a candidate',
      async () => {
        const recording = await testData.createRecording();
        const airing = await testData.airAd({ recording, hasDefaultCard: true });
        const findLater = await heardThreeHoursAgo(recording);
        await setupClient.query(`UPDATE app.campaigns SET status = 'PAUSED' WHERE id = $1`, [airing.campaignId]);
        const found = await findLater();
        return { atCapture: found.map((row) => [row.station_id, row.is_campaign_active]), expected: [[airing.stationId, false]] };
      },
    ],
    [
      'the tap limit follows the processing time: reached after the clip was heard, it is reached for this clip',
      async () => {
        const recording = await testData.createRecording();
        const airing = await testData.airAd({ recording, engagementLimit: 3 });
        const findLater = await heardThreeHoursAgo(recording);
        await setupClient.query(`INSERT INTO app.campaign_counters (campaign_id, station_id, counted_engagement_count) VALUES ($1, $2, 3)`, [airing.campaignId, airing.stationId]);
        const found = await findLater();
        return { atCapture: found[0]?.is_at_engagement_limit, expected: true };
      },
    ],
    [
      'the station status follows the processing time: suspended after the clip was heard, the station is no candidate',
      async () => {
        const recording = await testData.createRecording();
        const airing = await testData.airAd({ recording });
        const findLater = await heardThreeHoursAgo(recording);
        await setupClient.query(`UPDATE app.stations SET status = 'SUSPENDED' WHERE id = $1`, [airing.stationId]);
        return { atCapture: await findLater(), expected: [] };
      },
    ],
    [
      'the card version follows the processing time: a card edited after the clip was heard is the one returned',
      async () => {
        const recording = await testData.createRecording();
        const airing = await testData.airAd({ recording });
        const findLater = await heardThreeHoursAgo(recording);
        const editedCard = await testData.createCard(airing.stationId, airing.clientId);
        await setupClient.query('UPDATE app.campaigns SET action_card_id = $2 WHERE id = $1', [airing.campaignId, editedCard.cardId]);
        const found = await findLater();
        return { atCapture: [found[0]?.campaign_action_card_id, found[0]?.campaign_card], expected: [editedCard.cardId, editedCard.content] };
      },
    ],
  ])('P4-TIMERULE-08: %s', async (_fact, decide) => {
    const { atCapture, expected } = await decide();
    expect(atCapture).toEqual(expected);
  });

  /** Claims a clip heard 3 hours ago; resolves, when asked, to what resolveStation shows the listener now. */
  const resolvedLater = async (recording: Recording) => {
    const installId = await testData.createInstall();
    const claimed = await testData.claim(apiClient, installId, { receivedAt: new Date(), capturedAt: new Date(Date.now() - THREE_HOURS) });
    return async () => {
      const rows = (await apiClient.query('SELECT * FROM recognition.find_station_candidates($1, $2)', [recording.assetNumber, claimed.recognition_captured_at])).rows as StationCandidateRow[];
      const resolution = resolveStation(rows, { capturedAt: claimed.recognition_captured_at, stationHint: null });
      return {
        outcome: resolution.outcome,
        shownCardId: resolution.outcome === 'MATCH' || resolution.outcome === 'MATCH_DEFAULT' ? resolution.matched.actionCardId : null,
      };
    };
  };

  it.each([
    [
      'the time window follows the capture time: heard in its slot and processed after it ended, the campaign’s own buttons',
      async () => {
        const recording = await testData.createRecording();
        const airing = await testData.airAd({ recording, station: { timeZone: 'UTC' }, gracePeriodMinutes: 0, windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: utcClock(hoursFromNow(-4)), to: utcClock(hoursFromNow(-2)) }] });
        return { shown: await (await resolvedLater(recording))(), expected: { outcome: 'MATCH', shownCardId: airing.campaignCardId } };
      },
    ],
    [
      'the campaign period follows the capture time: heard before the period ended and processed after, the campaign’s own buttons',
      async () => {
        const recording = await testData.createRecording();
        const airing = await testData.airAd({ recording, period: [hoursFromNow(-48).toISOString(), hoursFromNow(-1).toISOString()] });
        return { shown: await (await resolvedLater(recording))(), expected: { outcome: 'MATCH', shownCardId: airing.campaignCardId } };
      },
    ],
    [
      'the candidates follow the capture time: the campaign paused after the clip was heard still answers, with the client’s usual buttons',
      async () => {
        const recording = await testData.createRecording();
        const airing = await testData.airAd({ recording, hasDefaultCard: true });
        const resolveLater = await resolvedLater(recording);
        await setupClient.query(`UPDATE app.campaigns SET status = 'PAUSED' WHERE id = $1`, [airing.campaignId]);
        return { shown: await resolveLater(), expected: { outcome: 'MATCH_DEFAULT', shownCardId: airing.defaultCardId } };
      },
    ],
    [
      'the tap limit follows the processing time: reached after the clip was heard, the client’s usual buttons',
      async () => {
        const recording = await testData.createRecording();
        const airing = await testData.airAd({ recording, engagementLimit: 3, hasDefaultCard: true });
        const resolveLater = await resolvedLater(recording);
        await setupClient.query(`INSERT INTO app.campaign_counters (campaign_id, station_id, counted_engagement_count) VALUES ($1, $2, 3)`, [airing.campaignId, airing.stationId]);
        return { shown: await resolveLater(), expected: { outcome: 'MATCH_DEFAULT', shownCardId: airing.defaultCardId } };
      },
    ],
    [
      'the station status follows the processing time: suspended after the clip was heard, no buttons at all',
      async () => {
        const recording = await testData.createRecording();
        const airing = await testData.airAd({ recording, hasDefaultCard: true });
        const resolveLater = await resolvedLater(recording);
        await setupClient.query(`UPDATE app.stations SET status = 'SUSPENDED' WHERE id = $1`, [airing.stationId]);
        return { shown: await resolveLater(), expected: { outcome: 'NO_MATCH', shownCardId: null } };
      },
    ],
    [
      'the card version follows the processing time: edited after the clip was heard, the new buttons',
      async () => {
        const recording = await testData.createRecording();
        const airing = await testData.airAd({ recording });
        const resolveLater = await resolvedLater(recording);
        const editedCard = await testData.createCard(airing.stationId, airing.clientId);
        await setupClient.query('UPDATE app.campaigns SET action_card_id = $2 WHERE id = $1', [airing.campaignId, editedCard.cardId]);
        return { shown: await resolveLater(), expected: { outcome: 'MATCH', shownCardId: editedCard.cardId } };
      },
    ],
  ])('P4-TIMERULE-08 (resolveStation): %s', async (_fact, decide) => {
    const { shown, expected } = await decide();
    expect(shown).toEqual(expected);
  });
});
