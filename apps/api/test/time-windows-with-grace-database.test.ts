import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { StationResolutionTestData } from './support/station-resolution-test-data.js';

/**
 * Grace widens each time window on both sides, never the campaign's period (P4 design §4.3, P4-D3; the user's
 * answer of 11 October 2026). The rule itself is app.is_time_window_open_with_grace, in the station's wall-clock
 * time; recognition reads it through recognition.find_station_candidates, at the moment the clip was heard.
 * Monday 5 October 2026 starts the test week.
 */
describe('time windows with grace', () => {
  let setupClient: pg.Client;
  beforeAll(async () => {
    setupClient = databaseSetupClient();
    await setupClient.connect();
  });
  afterAll(async () => setupClient.end());

  // No service role may run it (it is called inside recognition's own functions), so the setup user asks.
  const isOpen = async (days: number[], start: string, end: string, localMoment: string, graceMinutes: number) =>
    (
      await setupClient.query(
        'SELECT app.is_time_window_open_with_grace($1::smallint[], $2::time, $3::time, $4::timestamp, make_interval(mins => $5)) AS is_open',
        [days, start, end, localMoment, graceMinutes],
      )
    ).rows[0].is_open as boolean;

  const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
  it.each([
    // P4-RESOLUTION-02, P4-TESTS-04: a 10-minute grace on both sides of an 08:00–10:00 slot.
    ['P4-TESTS-04: 9 minutes before the start, inside the grace', EVERY_DAY, '08:00', '10:00', '2026-10-07 07:51:00', 10, true],
    ['P4-TESTS-04: exactly the grace before the start', EVERY_DAY, '08:00', '10:00', '2026-10-07 07:50:00', 10, true],
    ['P4-TESTS-04: 11 minutes before the start, outside the grace', EVERY_DAY, '08:00', '10:00', '2026-10-07 07:49:00', 10, false],
    ['P4-TESTS-04: 9 minutes after the end, inside the grace', EVERY_DAY, '08:00', '10:00', '2026-10-07 10:09:00', 10, true],
    ['P4-TESTS-04: one second before the grace after the end runs out', EVERY_DAY, '08:00', '10:00', '2026-10-07 10:09:59', 10, true],
    ['P4-TESTS-04: exactly the grace after the end is out (the slot is [start, end))', EVERY_DAY, '08:00', '10:00', '2026-10-07 10:10:00', 10, false],
    ['P4-TESTS-04: 11 minutes after the end, outside the grace', EVERY_DAY, '08:00', '10:00', '2026-10-07 10:11:00', 10, false],
    // P4-TESTS-03: the window's own boundary instants, with no grace.
    ['P4-TESTS-03: opens at its start', EVERY_DAY, '08:00', '10:00', '2026-10-07 08:00:00', 0, true],
    ['P4-TESTS-03: is closed one second before its start', EVERY_DAY, '08:00', '10:00', '2026-10-07 07:59:59', 0, false],
    ['P4-TESTS-03: is open one second before its end', EVERY_DAY, '08:00', '10:00', '2026-10-07 09:59:59', 0, true],
    ['P4-TESTS-03: is closed at its end', EVERY_DAY, '08:00', '10:00', '2026-10-07 10:00:00', 0, false],
    ['P4-TESTS-03: is closed one second after its end', EVERY_DAY, '08:00', '10:00', '2026-10-07 10:00:01', 0, false],
    // P4-TESTS-01: midnight. A window ending at 00:00:00 exactly (Monday 22:00 to midnight).
    ['P4-TESTS-01: ending at midnight: open one second before it', [1], '22:00', '00:00', '2026-10-05 23:59:59', 0, true],
    ['P4-TESTS-01: ending at midnight: closed at 00:00:00', [1], '22:00', '00:00', '2026-10-06 00:00:00', 0, false],
    ['P4-TESTS-01: ending at midnight: the grace runs into the next day', [1], '22:00', '00:00', '2026-10-06 00:09:59', 10, true],
    ['P4-TESTS-01: ending at midnight: and ends there', [1], '22:00', '00:00', '2026-10-06 00:10:00', 10, false],
    // A window starting at 00:00:00 (Tuesday 00:00 to 02:00).
    ['P4-TESTS-01: starting at midnight: open at 00:00:00', [2], '00:00', '02:00', '2026-10-06 00:00:00', 0, true],
    ['P4-TESTS-01: starting at midnight: closed one second before, the day before', [2], '00:00', '02:00', '2026-10-05 23:59:59', 0, false],
    ['P4-TESTS-01: starting at midnight: the grace reaches back into the day before', [2], '00:00', '02:00', '2026-10-05 23:50:00', 10, true],
    ['P4-TESTS-01: starting at midnight: but no further', [2], '00:00', '02:00', '2026-10-05 23:49:59', 10, false],
    // An overnight window with grace across midnight (Friday 22:00 to Saturday 02:00).
    ['P4-TESTS-01: overnight: 9 minutes before it starts on Friday', [5], '22:00', '02:00', '2026-10-09 21:51:00', 10, true],
    ['P4-TESTS-01: overnight: 11 minutes before it starts on Friday', [5], '22:00', '02:00', '2026-10-09 21:49:00', 10, false],
    ['P4-TESTS-01: overnight: open at midnight', [5], '22:00', '02:00', '2026-10-10 00:00:00', 10, true],
    ['P4-TESTS-01: overnight: 9 minutes after it ends on Saturday', [5], '22:00', '02:00', '2026-10-10 02:09:00', 10, true],
    ['P4-TESTS-01: overnight: 11 minutes after it ends on Saturday', [5], '22:00', '02:00', '2026-10-10 02:11:00', 10, false],
    ['P4-TESTS-01: overnight: the early hours of Friday belong to Thursday, which is not listed', [5], '22:00', '02:00', '2026-10-09 01:00:00', 10, false],
    // P4-TESTS-02: one case for each ISO day, open on that day and closed on the next.
    ['P4-TESTS-02: Monday (1)', [1], '12:00', '13:00', '2026-10-05 12:30:00', 10, true],
    ['P4-TESTS-02: Monday only, so not Tuesday', [1], '12:00', '13:00', '2026-10-06 12:30:00', 10, false],
    ['P4-TESTS-02: Tuesday (2)', [2], '12:00', '13:00', '2026-10-06 12:30:00', 10, true],
    ['P4-TESTS-02: Tuesday only, so not Wednesday', [2], '12:00', '13:00', '2026-10-07 12:30:00', 10, false],
    ['P4-TESTS-02: Wednesday (3)', [3], '12:00', '13:00', '2026-10-07 12:30:00', 10, true],
    ['P4-TESTS-02: Wednesday only, so not Thursday', [3], '12:00', '13:00', '2026-10-08 12:30:00', 10, false],
    ['P4-TESTS-02: Thursday (4)', [4], '12:00', '13:00', '2026-10-08 12:30:00', 10, true],
    ['P4-TESTS-02: Thursday only, so not Friday', [4], '12:00', '13:00', '2026-10-09 12:30:00', 10, false],
    ['P4-TESTS-02: Friday (5)', [5], '12:00', '13:00', '2026-10-09 12:30:00', 10, true],
    ['P4-TESTS-02: Friday only, so not Saturday', [5], '12:00', '13:00', '2026-10-10 12:30:00', 10, false],
    ['P4-TESTS-02: Saturday (6)', [6], '12:00', '13:00', '2026-10-10 12:30:00', 10, true],
    ['P4-TESTS-02: Saturday only, so not Sunday', [6], '12:00', '13:00', '2026-10-11 12:30:00', 10, false],
    ['P4-TESTS-02: Sunday (7)', [7], '12:00', '13:00', '2026-10-11 12:30:00', 10, true],
    ['P4-TESTS-02: Sunday only, so not the Monday after', [7], '12:00', '13:00', '2026-10-12 12:30:00', 10, false],
    ['P4-TESTS-02: a window on several days (Monday, Wednesday, Friday) is open on Wednesday', [1, 3, 5], '12:00', '13:00', '2026-10-07 12:30:00', 10, true],
    ['P4-TESTS-02: and closed on Tuesday', [1, 3, 5], '12:00', '13:00', '2026-10-06 12:30:00', 10, false],
    ['P4-TESTS-02: and on Sunday', [1, 3, 5], '12:00', '13:00', '2026-10-11 12:30:00', 10, false],
  ])('%s', async (_case, days, start, end, localMoment, graceMinutes, expected) => {
    expect(await isOpen(days, start, end, localMoment, graceMinutes)).toBe(expected);
  });

  describe('as recognition reads it', () => {
    let apiClient: pg.Client;
    let testData: StationResolutionTestData;
    beforeAll(async () => {
      apiClient = lookupApiClient();
      await apiClient.connect();
      testData = new StationResolutionTestData(setupClient);
    });
    afterAll(async () => {
      await testData.removeAll();
      await apiClient.end();
    });

    const inWindow = async (assetNumber: number, capturedAt: string | Date) =>
      ((await apiClient.query('SELECT is_in_window FROM recognition.find_station_candidates($1, $2::timestamptz)', [assetNumber, capturedAt])).rows[0]
        ?.is_in_window ?? null) as boolean | null;

    it('P4-RESOLUTION-03: a new campaign has a grace of 10 minutes, applied on both sides of a slot', async () => {
      const recording = await testData.createRecording();
      const airing = await testData.airAd({ recording, station: { timeZone: 'UTC' }, windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '08:00', to: '10:00' }] });
      // A campaign saved without a grace gets the column's default.
      const campaignId = randomUUID();
      await setupClient.query(
        `INSERT INTO app.campaigns (id, station_id, ad_id, name, status, active_period)
         VALUES ($1, $2, $3, 'Default grace', 'DRAFT', tstzrange(now(), now() + interval '1 day'))`,
        [campaignId, airing.stationId, airing.adId],
      );
      const grace = await setupClient.query(`SELECT time_window_grace_period::text AS grace FROM app.campaigns WHERE id = $1`, [campaignId]);
      expect(grace.rows[0].grace).toBe('00:10:00');
      await setupClient.query('DELETE FROM app.campaigns WHERE id = $1', [campaignId]);

      const today = new Date().toISOString().slice(0, 10);
      expect(await inWindow(recording.assetNumber, `${today}T10:09:00Z`)).toBe(true);
      expect(await inWindow(recording.assetNumber, `${today}T10:11:00Z`)).toBe(false);
      expect(await inWindow(recording.assetNumber, `${today}T07:51:00Z`)).toBe(true);
      expect(await inWindow(recording.assetNumber, `${today}T07:49:00Z`)).toBe(false);
    });

    it('P4-TIMERULE-02: the grace is measured around the capture time: heard 5 minutes after a slot and received 3 hours later is on air; heard 3 hours after it is not', async () => {
      const recording = await testData.createRecording();
      const now = new Date();
      // A slot that ended at the last full hour more than three hours ago, every day, in UTC.
      const slotEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() - 4));
      const slotStart = new Date(slotEnd.getTime() - 60 * 60 * 1000);
      const clock = (moment: Date) => moment.toISOString().slice(11, 16);
      await testData.airAd({ recording, station: { timeZone: 'UTC' }, windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: clock(slotStart), to: clock(slotEnd) }] });
      const installId = await testData.createInstall();

      const heardSoonAfter = await testData.claim(apiClient, installId, { capturedAt: new Date(slotEnd.getTime() + 5 * 60_000), receivedAt: new Date(slotEnd.getTime() + 5 * 60_000 + 3 * 3_600_000) });
      expect(heardSoonAfter.recognition_received_at.getTime() - heardSoonAfter.recognition_captured_at.getTime()).toBe(3 * 3_600_000);
      expect(await inWindow(recording.assetNumber, heardSoonAfter.recognition_captured_at)).toBe(true);

      const heardLate = await testData.claim(apiClient, installId, { capturedAt: new Date(slotEnd.getTime() + 3 * 3_600_000), receivedAt: new Date(slotEnd.getTime() + 3 * 3_600_000 + 60_000) });
      expect(await inWindow(recording.assetNumber, heardLate.recognition_captured_at)).toBe(false);
    });

    it('P4-TESTS-03: the period is [start, end): its start is in and the second before is out, the second before its end is in and its end and the second after are out (all-day windows, so only the period decides)', async () => {
      const recording = await testData.createRecording();
      await testData.airAd({ recording, station: { timeZone: 'UTC' }, period: ['2026-10-05T09:00:00Z', '2026-10-09T09:00:00Z'], gracePeriodMinutes: 0 });
      expect(await inWindow(recording.assetNumber, '2026-10-05T08:59:59Z')).toBe(false);
      expect(await inWindow(recording.assetNumber, '2026-10-05T09:00:00Z')).toBe(true);
      expect(await inWindow(recording.assetNumber, '2026-10-09T08:59:59Z')).toBe(true);
      expect(await inWindow(recording.assetNumber, '2026-10-09T09:00:00Z')).toBe(false);
      expect(await inWindow(recording.assetNumber, '2026-10-09T09:00:01Z')).toBe(false);
    });

    it('grace never widens the period: 5 minutes before the period starts, or after it ends, is out even with an hour of grace', async () => {
      const recording = await testData.createRecording();
      await testData.airAd({ recording, station: { timeZone: 'UTC' }, period: ['2026-10-05T09:00:00Z', '2026-10-09T09:00:00Z'], gracePeriodMinutes: 60 });
      expect(await inWindow(recording.assetNumber, '2026-10-05T08:55:00Z')).toBe(false);
      expect(await inWindow(recording.assetNumber, '2026-10-09T09:05:00Z')).toBe(false);
      expect(await inWindow(recording.assetNumber, '2026-10-07T12:00:00Z')).toBe(true);
    });

    it('judges the window in the station time zone (Lusaka is UTC+2)', async () => {
      const recording = await testData.createRecording();
      await testData.airAd({ recording, windows: [{ days: [3], from: '08:00', to: '10:00' }], gracePeriodMinutes: 0, period: ['2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'] });
      expect(await inWindow(recording.assetNumber, '2026-10-07T06:30:00Z')).toBe(true);
      expect(await inWindow(recording.assetNumber, '2026-10-07T08:30:00Z')).toBe(false);
    });
  });
});
