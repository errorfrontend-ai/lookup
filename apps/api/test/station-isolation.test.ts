import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asLookupApi, databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { StationResolutionTestData } from './support/station-resolution-test-data.js';

/**
 * Station isolation is enforced by Postgres itself, not only by API code. These tests talk to
 * the database as the API's own role (lookup_api) and prove one station can never see or change
 * another's rows — even if a bug in the API forgot a WHERE clause.
 */
describe('row-level security between stations', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  const runTag = randomUUID().slice(0, 8);
  const ids = { stationA: randomUUID(), stationB: randomUUID(), clientOfA: randomUUID(), clientOfB: randomUUID() };
  const bothClients = [ids.clientOfA, ids.clientOfB];

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await setupClient.connect();
    await apiClient.connect();
    await setupClient.query(
      `INSERT INTO app.stations (id, name, frequency_label, status) VALUES
         ($1, $3, '98.1 FM', 'ACTIVE'), ($2, $4, '104.3 FM', 'ACTIVE')`,
      [ids.stationA, ids.stationB, `Station A ${runTag}`, `Station B ${runTag}`],
    );
    await setupClient.query(
      `INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, 'Client of A'), ($3, $4, 'Client of B')`,
      [ids.clientOfA, ids.stationA, ids.clientOfB, ids.stationB],
    );
  });

  afterAll(async () => {
    await setupClient.query('DELETE FROM app.clients WHERE station_id = ANY($1)', [[ids.stationA, ids.stationB]]);
    await setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [[ids.stationA, ids.stationB]]);
    await apiClient.end();
    await setupClient.end();
  });

  const asStationA = <Result>(work: (client: pg.Client) => Promise<Result>) =>
    asLookupApi(apiClient, { stationId: ids.stationA }, work);

  it('with no station context, station data is invisible (fails closed)', async () => {
    const result = await asLookupApi(apiClient, {}, (client) =>
      client.query('SELECT id FROM app.clients WHERE id = ANY($1)', [bothClients]),
    );
    expect(result.rowCount).toBe(0);
  });

  it('a station sees only its own clients and itself', async () => {
    const clients = await asStationA((client) => client.query('SELECT id FROM app.clients WHERE id = ANY($1)', [bothClients]));
    expect(clients.rows.map((row) => row.id)).toEqual([ids.clientOfA]);
    const stations = await asStationA((client) =>
      client.query('SELECT id FROM app.stations WHERE id = ANY($1)', [[ids.stationA, ids.stationB]]),
    );
    expect(stations.rows.map((row) => row.id)).toEqual([ids.stationA]);
  });

  it('a station cannot insert rows into another station', async () => {
    await expect(
      asStationA((client) => client.query(`INSERT INTO app.clients (station_id, name) VALUES ($1, 'sneaky')`, [ids.stationB])),
    ).rejects.toThrow(/row-level security/);
  });

  it("a station cannot update or delete another station's rows", async () => {
    const updated = await asStationA((client) =>
      client.query(`UPDATE app.clients SET name = 'changed' WHERE id = $1`, [ids.clientOfB]),
    );
    expect(updated.rowCount).toBe(0);
    const deleted = await asStationA((client) => client.query('DELETE FROM app.clients WHERE id = $1', [ids.clientOfB]));
    expect(deleted.rowCount).toBe(0);
  });

  it("composite keys stop a station's action card from pointing at another station's client", async () => {
    await expect(
      asStationA((client) =>
        client.query(
          `INSERT INTO app.action_cards (station_id, client_id, schema_version, content) VALUES ($1, $2, 1, '{"schema_version":1}'::jsonb)`,
          [ids.stationA, ids.clientOfB],
        ),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('the API role has no access to the fingerprint store', async () => {
    await expect(asStationA((client) => client.query('SELECT 1 FROM fingerprints.audio_assets LIMIT 1'))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('the API role cannot write recognition events directly', async () => {
    await expect(
      asStationA((client) => client.query('DELETE FROM app.recognition_events WHERE station_id = $1', [ids.stationA])),
    ).rejects.toThrow(/permission denied/);
  });
});

/**
 * Phase 4 (P4-DATABASE-01): what is stored about a recognition several stations were weighed for stays with
 * each station. A station sees only its own candidate row, the recognition only once the listener chose it,
 * and only its own taps and tap counters, whatever the API asks.
 */
describe('row-level security between stations: candidates, choices, taps and counters', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  let testData: StationResolutionTestData;
  const { candidate } = StationResolutionTestData;

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await setupClient.connect();
    await apiClient.connect();
    testData = new StationResolutionTestData(setupClient);
  });
  afterAll(async () => {
    await testData.removeAll();
    await apiClient.end();
    await setupClient.end();
  });

  /** A recognition answered with a chooser of stations A and B, and what each station's own context reads of it. */
  async function chooserOfTwoStations() {
    const recording = await testData.createRecording();
    const stationA = await testData.airAd({ recording });
    const stationB = await testData.airAd({ recording });
    const installId = await testData.createInstall();
    const claimed = await testData.claim(apiClient, installId);
    await testData.finish(apiClient, claimed, {
      outcome: 'CHOOSE_STATION',
      resolution: 'UNRESOLVED',
      recording,
      candidates: [candidate(stationA, { displayPosition: 1 }), candidate(stationB, { displayPosition: 2 })],
    });
    const seenBy = (stationId: string) =>
      asLookupApi(apiClient, { stationId }, async (client) => ({
        candidates: (await client.query('SELECT station_id, is_chosen FROM app.recognition_candidates WHERE recognition_id = $1', [claimed.recognition_id])).rows,
        recognitions: (await client.query('SELECT id, station_id, resolution FROM app.recognition_events WHERE id = $1', [claimed.recognition_id])).rows,
      }));
    return { stationA, stationB, installId, claimed, seenBy };
  }

  it('P4-RESOLUTION-13: each station sees only its own candidate row of a recognition both were weighed for, and not the recognition while nobody chose', async () => {
    const { stationA, stationB, seenBy } = await chooserOfTwoStations();
    expect(await seenBy(stationA.stationId)).toEqual({ candidates: [{ station_id: stationA.stationId, is_chosen: false }], recognitions: [] });
    expect(await seenBy(stationB.stationId)).toEqual({ candidates: [{ station_id: stationB.stationId, is_chosen: false }], recognitions: [] });
  });

  it('P4-CHOICE-06: after the listener chose station A, A sees the recognition as its own, and B sees only its own candidate row, unchosen', async () => {
    const { stationA, stationB, installId, claimed, seenBy } = await chooserOfTwoStations();
    const choice = await apiClient.query('SELECT recognition.record_station_choice($1, $2, $3) AS answer', [claimed.recognition_id, installId, stationA.stationId]);
    expect(choice.rows[0].answer).toBe('CHOSEN');
    expect(await seenBy(stationA.stationId)).toEqual({
      candidates: [{ station_id: stationA.stationId, is_chosen: true }],
      recognitions: [{ id: claimed.recognition_id, station_id: stationA.stationId, resolution: 'LISTENER_CHOICE' }],
    });
    expect(await seenBy(stationB.stationId)).toEqual({ candidates: [{ station_id: stationB.stationId, is_chosen: false }], recognitions: [] });
  });

  it('P4-ENGAGEMENTS-11: a station sees only its own taps and tap counters', async () => {
    const { stationA, stationB, installId, claimed } = await chooserOfTwoStations();
    const callButton = (stationA.campaignCard?.actions[0] as { id: string }).id;
    const tapped = await apiClient.query('SELECT recognition.record_engagement($1, $2, $3, $4, $5, now(), now(), 0, now(), $6, NULL) AS answer', [
      randomUUID(), claimed.recognition_id, installId, stationA.stationId, callButton, 'request-isolation',
    ]);
    expect(tapped.rows[0].answer).toBe('RECORDED');
    const seenBy = (stationId: string) =>
      asLookupApi(apiClient, { stationId }, async (client) => ({
        taps: (await client.query('SELECT station_id FROM app.engagement_events WHERE recognition_id = $1', [claimed.recognition_id])).rows,
        counters: (await client.query('SELECT campaign_id FROM app.campaign_counters WHERE campaign_id = ANY($1)', [[stationA.campaignId, stationB.campaignId]])).rows,
      }));
    expect(await seenBy(stationA.stationId)).toEqual({ taps: [{ station_id: stationA.stationId }], counters: [{ campaign_id: stationA.campaignId }] });
    expect(await seenBy(stationB.stationId)).toEqual({ taps: [], counters: [] });
    expect(await asLookupApi(apiClient, {}, async (client) => (await client.query('SELECT count(*)::integer AS visible FROM app.engagement_events WHERE recognition_id = $1', [claimed.recognition_id])).rows[0].visible)).toBe(0);
  });
});
