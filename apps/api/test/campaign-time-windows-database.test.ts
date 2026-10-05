import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asLookupApi, databaseSetupClient, lookupApiClient } from './support/database-clients.js';

/**
 * When is an ad on air? One definition in the database, used by the portal's "Live now" badge and,
 * from Step 3, by recognition. Monday 5 October 2026 starts the test week.
 */
describe('time windows', () => {
  let apiClient: pg.Client;
  beforeAll(async () => {
    apiClient = lookupApiClient();
    await apiClient.connect();
  });
  afterAll(async () => apiClient.end());

  const isOpen = async (days: number[], start: string, end: string, localMoment: string) =>
    (
      await apiClient.query('SELECT app.is_time_window_open($1::smallint[], $2::time, $3::time, $4::timestamp) AS open', [
        days,
        start,
        end,
        localMoment,
      ])
    ).rows[0].open as boolean;

  const WEEKDAYS = [1, 2, 3, 4, 5];
  it.each([
    ['opens at its start time', WEEKDAYS, '07:00', '09:00', '2026-10-05 07:00:00', true],
    ['is open a second before its end', WEEKDAYS, '07:00', '09:00', '2026-10-05 08:59:59', true],
    ['is closed at its end time', WEEKDAYS, '07:00', '09:00', '2026-10-05 09:00:00', false],
    ['is closed a second before its start', WEEKDAYS, '07:00', '09:00', '2026-10-05 06:59:59', false],
    ['is closed on a day not listed (Saturday)', WEEKDAYS, '07:00', '09:00', '2026-10-10 08:00:00', false],
    ['past midnight: open late on the listed day (Friday 22:00)', [5], '22:00', '02:00', '2026-10-09 22:00:00', true],
    ['past midnight: open just before midnight', [5], '22:00', '02:00', '2026-10-09 23:59:59', true],
    ['past midnight: still open early the next day (Saturday 01:59)', [5], '22:00', '02:00', '2026-10-10 01:59:59', true],
    ['past midnight: closed at its end the next day (Saturday 02:00)', [5], '22:00', '02:00', '2026-10-10 02:00:00', false],
    ['past midnight: early hours belong to the previous day, so Friday 01:00 is closed', [5], '22:00', '02:00', '2026-10-09 01:00:00', false],
    ['past midnight: closed on the day before (Thursday 23:00)', [5], '22:00', '02:00', '2026-10-08 23:00:00', false],
    ['Sunday into Monday: Monday 00:30 belongs to Sunday', [7], '23:00', '01:00', '2026-10-12 00:30:00', true],
    ['Sunday into Monday: Monday 23:30 is not Sunday', [7], '23:00', '01:00', '2026-10-12 23:30:00', false],
  ])('a window %s', async (_description, days, start, end, localMoment, expectedOpen) => {
    expect(await isOpen(days, start, end, localMoment)).toBe(expectedOpen);
  });
});

describe('campaign status as a station sees it', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  const ids = { station: randomUUID(), otherStation: randomUUID(), client: randomUUID(), ad: randomUUID() };

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await setupClient.connect();
    await apiClient.connect();
    await setupClient.query(
      `INSERT INTO app.stations (id, name, frequency_label, status, time_zone) VALUES
         ($1, 'Window FM', '90.1 FM', 'ACTIVE', 'Africa/Lusaka'), ($2, 'Other FM', '91.1 FM', 'ACTIVE', 'Africa/Lusaka')`,
      [ids.station, ids.otherStation],
    );
    await setupClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, 'Window client')`, [ids.client, ids.station]);
    await setupClient.query(`INSERT INTO app.ads (id, station_id, client_id, title) VALUES ($1, $2, $3, 'Window ad')`, [
      ids.ad,
      ids.station,
      ids.client,
    ]);
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.campaign_time_windows WHERE station_id = $1', [ids.station]);
    await setupClient.query('DELETE FROM app.campaigns WHERE station_id = $1', [ids.station]);
    await setupClient.query('DELETE FROM app.ads WHERE station_id = $1', [ids.station]);
    await setupClient.query('DELETE FROM app.clients WHERE station_id = $1', [ids.station]);
    await setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [[ids.station, ids.otherStation]]);
    await apiClient.end();
    await setupClient.end();
  });

  /** A campaign for the test ad with a Mon–Fri 07:00–09:00 (station time) window. */
  async function campaign(status: string, periodStart: string, periodEnd: string): Promise<string> {
    await setupClient.query(`DELETE FROM app.campaign_time_windows WHERE station_id = $1`, [ids.station]);
    await setupClient.query(`DELETE FROM app.campaigns WHERE station_id = $1`, [ids.station]);
    const created = await setupClient.query(
      `INSERT INTO app.campaigns (station_id, ad_id, name, status, active_period)
       VALUES ($1, $2, 'Window campaign', $3, tstzrange($4::timestamptz, $5::timestamptz, '[)')) RETURNING id`,
      [ids.station, ids.ad, status, periodStart, periodEnd],
    );
    const campaignId = created.rows[0].id as string;
    await setupClient.query(
      `INSERT INTO app.campaign_time_windows (campaign_id, station_id, days_of_week, local_start_time, local_end_time)
       VALUES ($1, $2, '{1,2,3,4,5}', '07:00', '09:00')`,
      [campaignId, ids.station],
    );
    return campaignId;
  }

  const displayStatus = (campaignId: string, atMoment: string, stationId = ids.station) =>
    asLookupApi(apiClient, { stationId }, async (client) =>
      (await client.query('SELECT app.campaign_display_status($1, $2::timestamptz) AS status', [campaignId, atMoment])).rows[0].status,
    );

  it('draft and paused campaigns show as such, whatever the time', async () => {
    expect(await displayStatus(await campaign('DRAFT', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'), '2026-10-05T05:30:00Z')).toBe('DRAFT');
    expect(await displayStatus(await campaign('PAUSED', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'), '2026-10-05T05:30:00Z')).toBe('PAUSED');
  });

  it('an active campaign is live only inside a window, in the station time zone (Lusaka is UTC+2)', async () => {
    const campaignId = await campaign('ACTIVE', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
    expect(await displayStatus(campaignId, '2026-10-05T05:30:00Z')).toBe('LIVE_NOW'); // Monday 07:30 in Lusaka
    expect(await displayStatus(campaignId, '2026-10-05T07:30:00Z')).toBe('SCHEDULED'); // Monday 09:30 in Lusaka
    expect(await displayStatus(campaignId, '2026-10-10T05:30:00Z')).toBe('SCHEDULED'); // Saturday 07:30 in Lusaka
  });

  it('is scheduled before its dates and ended after them', async () => {
    const campaignId = await campaign('ACTIVE', '2026-10-06T00:00:00Z', '2026-10-08T00:00:00Z');
    expect(await displayStatus(campaignId, '2026-10-05T05:30:00Z')).toBe('SCHEDULED');
    expect(await displayStatus(campaignId, '2026-10-08T00:00:00Z')).toBe('ENDED');
  });

  it("another station learns nothing about this station's campaign", async () => {
    const campaignId = await campaign('ACTIVE', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
    expect(await displayStatus(campaignId, '2026-10-05T05:30:00Z', ids.otherStation)).toBeNull();
  });
});
