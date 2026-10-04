import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asLookupApi, databaseSetupClient, lookupApiClient } from './support/database-clients.js';

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
          `INSERT INTO app.action_cards (station_id, client_id, schema_version, content) VALUES ($1, $2, 1, '{}'::jsonb)`,
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
