import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StationScopedTransaction } from '../src/infrastructure/database/station-scoped-transaction.js';
import { asLookupApi, databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { PLACEHOLDER_PASSWORD_HASH } from './support/test-data.js';

/** Every station-owned table, and how to insert a row into it for a given station's data. */
const STATION_TABLES = ['station_memberships', 'clients', 'action_cards', 'ads', 'campaigns', 'campaign_time_windows', 'audit_events', 'recognition_events'];

/**
 * Isolation and privileges across every station-owned table, proven against Postgres with each
 * service role: station A's context sees none of station B's rows and cannot write them; composite
 * keys stop cross-station references even where row-level security does not apply; each role can
 * do exactly what its job needs.
 */
describe('station isolation and role privileges, table by table', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  const runTag = randomUUID().slice(0, 8);
  const stationIds = { A: randomUUID(), B: randomUUID() };
  const data = {
    A: { owner: randomUUID(), client: randomUUID(), card: randomUUID(), ad: randomUUID(), campaign: randomUUID(), recognition: randomUUID() },
    B: { owner: randomUUID(), client: randomUUID(), card: randomUUID(), ad: randomUUID(), campaign: randomUUID(), recognition: randomUUID() },
  };
  const unresolvedRecognition = randomUUID();
  const installId = randomUUID();
  const asStationA = <Result>(work: (client: pg.Client) => Promise<Result>) =>
    asLookupApi(apiClient, { stationId: stationIds.A, userId: data.A.owner }, work);

  /** Runs a statement that must be refused, inside a savepoint so the surrounding transaction survives. */
  async function expectRefused(client: pg.Client, sql: string, parameters: unknown[] = [], reason = /permission denied|row-level security/) {
    await client.query('SAVEPOINT expected_refusal');
    try {
      await expect(client.query(sql, parameters)).rejects.toThrow(reason);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT expected_refusal');
    }
  }

  /** Runs work as another service role (from the setup connection), always rolled back. */
  async function asRole<Result>(roleName: 'lookup_admin_api' | 'lookup_fingerprint_worker', work: (client: pg.Client) => Promise<Result>) {
    await setupClient.query('BEGIN');
    try {
      await setupClient.query(`SET LOCAL ROLE ${roleName}`);
      return await work(setupClient);
    } finally {
      await setupClient.query('ROLLBACK');
    }
  }

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await setupClient.connect();
    await apiClient.connect();
    await setupClient.query(`INSERT INTO app.listener_installs (id, install_id_hash, platform, app_version) VALUES ($1, $2, 'ANDROID', 'test')`, [
      installId,
      Buffer.from(randomUUID()),
    ]);
    for (const station of ['A', 'B'] as const) {
      const stationId = stationIds[station];
      const ids = data[station];
      await setupClient.query(`INSERT INTO app.stations (id, name, frequency_label, status) VALUES ($1, $2, '98.1 FM', 'ACTIVE')`, [
        stationId,
        `Matrix ${station} ${runTag}`,
      ]);
      await setupClient.query(`INSERT INTO app.portal_users (id, email, password_hash, full_name) VALUES ($1, $2, $3, 'Owner')`, [
        ids.owner,
        `matrix-${station.toLowerCase()}-${runTag}@example.test`,
        PLACEHOLDER_PASSWORD_HASH,
      ]);
      await setupClient.query(`INSERT INTO app.station_memberships (station_id, portal_user_id, role) VALUES ($1, $2, 'OWNER')`, [stationId, ids.owner]);
      await setupClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, 'Client')`, [ids.client, stationId]);
      await setupClient.query(
        `INSERT INTO app.action_cards (id, station_id, client_id, schema_version, content) VALUES ($1, $2, $3, 1, '{"schema_version":1}')`,
        [ids.card, stationId, ids.client],
      );
      await setupClient.query(`INSERT INTO app.ads (id, station_id, client_id, title) VALUES ($1, $2, $3, 'Ad')`, [ids.ad, stationId, ids.client]);
      await setupClient.query(
        `INSERT INTO app.campaigns (id, station_id, ad_id, name, active_period) VALUES ($1, $2, $3, 'Campaign', tstzrange(now(), now() + interval '7 days'))`,
        [ids.campaign, stationId, ids.ad],
      );
      await setupClient.query(
        `INSERT INTO app.campaign_time_windows (campaign_id, station_id, days_of_week, local_start_time, local_end_time) VALUES ($1, $2, '{1}', '07:00', '09:00')`,
        [ids.campaign, stationId],
      );
      await setupClient.query(`INSERT INTO app.audit_events (station_id, action, entity_type, request_id) VALUES ($1, 'matrix_test', 'station', 'test')`, [
        stationId,
      ]);
      await setupClient.query(
        `INSERT INTO app.recognition_events (id, listener_install_id, idempotency_key, request_id, captured_at, received_at, outcome, station_id)
         VALUES ($1, $2, $3, 'test', now(), now(), 'MATCH', $4)`,
        [ids.recognition, installId, randomUUID(), stationId],
      );
    }
    await setupClient.query(
      `INSERT INTO app.recognition_events (id, listener_install_id, idempotency_key, request_id, captured_at, received_at, outcome)
       VALUES ($1, $2, $3, 'test', now(), now(), 'NO_MATCH')`,
      [unresolvedRecognition, installId, randomUUID()],
    );
  });

  afterAll(async () => {
    const both = [stationIds.A, stationIds.B];
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = $1', [installId]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = $1', [installId]);
    await setupClient.query('DELETE FROM app.audit_events WHERE station_id = ANY($1)', [both]);
    await setupClient.query('DELETE FROM app.campaigns WHERE station_id = ANY($1)', [both]);
    await setupClient.query('DELETE FROM app.ads WHERE station_id = ANY($1)', [both]);
    await setupClient.query('DELETE FROM app.action_cards WHERE station_id = ANY($1)', [both]);
    await setupClient.query('DELETE FROM app.clients WHERE station_id = ANY($1)', [both]);
    await setupClient.query('DELETE FROM app.station_memberships WHERE station_id = ANY($1)', [both]);
    await setupClient.query('DELETE FROM app.portal_users WHERE id = ANY($1)', [[data.A.owner, data.B.owner]]);
    await setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [both]);
    await apiClient.end();
    await setupClient.end();
  });

  describe('row-level security (lookup_api)', () => {
    it.each(STATION_TABLES)("S1-TESTS-13, S1-ISOLATION-16: station A's context sees its own %s rows and none of station B's", async (tableName) => {
      const visible = await asStationA((client) =>
        client.query(`SELECT station_id FROM app.${tableName} WHERE station_id = ANY($1)`, [[stationIds.A, stationIds.B]]),
      );
      expect(visible.rows.length).toBeGreaterThan(0);
      expect(visible.rows.every((row) => row.station_id === stationIds.A)).toBe(true);
    });

    it('S1-ISOLATION-16: unresolved recognition events (no station) are visible to no station', async () => {
      const visible = await asStationA((client) => client.query(`SELECT id FROM app.recognition_events WHERE id = $1`, [unresolvedRecognition]));
      expect(visible.rows).toEqual([]);
    });

    it("S1-TESTS-13: station A's context cannot insert rows carrying station B's id", async () => {
      await asStationA(async (client) => {
        const ofB = data.B;
        await expectRefused(client, `INSERT INTO app.clients (station_id, name) VALUES ($1, 'Intruder')`, [stationIds.B]);
        await expectRefused(client, `INSERT INTO app.action_cards (station_id, client_id, schema_version, content) VALUES ($1, $2, 1, '{"schema_version":1}')`, [stationIds.B, ofB.client]);
        await expectRefused(client, `INSERT INTO app.ads (station_id, client_id, title) VALUES ($1, $2, 'Intruder')`, [stationIds.B, ofB.client]);
        await expectRefused(client, `INSERT INTO app.campaigns (station_id, ad_id, name, active_period) VALUES ($1, $2, 'x', tstzrange(now(), now() + interval '1 day'))`, [stationIds.B, ofB.ad]);
        await expectRefused(client, `INSERT INTO app.campaign_time_windows (campaign_id, station_id, days_of_week, local_start_time, local_end_time) VALUES ($1, $2, '{1}', '07:00', '08:00')`, [ofB.campaign, stationIds.B]);
        await expectRefused(client, `INSERT INTO app.station_memberships (station_id, portal_user_id, role) VALUES ($1, $2, 'MANAGER')`, [stationIds.B, data.A.owner]);
        await expectRefused(client, `INSERT INTO app.audit_events (station_id, action, entity_type, request_id) VALUES ($1, 'intruder', 'station', 'test')`, [stationIds.B]);
      });
    });

    it("S1-ISOLATION-05: an update cannot move station A's row to station B (WITH CHECK)", async () => {
      await asStationA(async (client) => {
        await expectRefused(client, `UPDATE app.campaigns SET station_id = $2 WHERE id = $1`, [data.A.campaign, stationIds.B], /row-level security/);
      });
    });

    it('S1-ISOLATION-08: with no station context, inserts into station-owned tables are refused', async () => {
      await asLookupApi(apiClient, { userId: data.A.owner }, async (client) => {
        await expectRefused(client, `INSERT INTO app.clients (station_id, name) VALUES ($1, 'No context')`, [stationIds.A], /row-level security/);
      });
    });

    it('S1-ISOLATION-06: app.current_station_id() is STABLE, returns the setting in its transaction and NULL without one', async () => {
      const inside = await asStationA((client) => client.query('SELECT app.current_station_id() AS station_id'));
      expect(inside.rows[0].station_id).toBe(stationIds.A);
      const outside = await apiClient.query('SELECT app.current_station_id() AS station_id');
      expect(outside.rows[0].station_id).toBeNull();
      const emptySetting = await asLookupApi(apiClient, {}, (client) => client.query('SELECT app.current_station_id() AS station_id'));
      expect(emptySetting.rows[0].station_id).toBeNull();
      const volatility = await setupClient.query(`SELECT provolatile FROM pg_proc WHERE oid = 'app.current_station_id()'::regprocedure`);
      expect(volatility.rows[0].provolatile).toBe('s');
    });

    it('S1-ISOLATION-14: a signed-in user with no station chosen sees only their own stations and memberships', async () => {
      await asLookupApi(apiClient, { userId: data.A.owner }, async (client) => {
        const stations = await client.query(`SELECT id FROM app.stations WHERE id = ANY($1)`, [[stationIds.A, stationIds.B]]);
        expect(stations.rows.map((row) => row.id)).toEqual([stationIds.A]);
        const memberships = await client.query(`SELECT station_id FROM app.station_memberships WHERE station_id = ANY($1)`, [[stationIds.A, stationIds.B]]);
        expect(memberships.rows.map((row) => row.station_id)).toEqual([stationIds.A]);
      });
    });
  });

  describe('StationScopedTransaction on pooled connections', () => {
    let pooledDataSource: DataSource;
    const noRequestContext = { get: () => undefined } as never;

    beforeAll(async () => {
      // One connection, so every unit of work below reuses the same server session.
      pooledDataSource = new DataSource({ type: 'postgres', url: process.env.DATABASE_URL, extra: { max: 1 } });
      await pooledDataSource.initialize();
    });
    afterAll(async () => pooledDataSource.destroy());

    it('S1-ISOLATION-09, S1-ISOLATION-10: the station context lasts only for its transaction; the next request on the same connection sees nothing', async () => {
      const transaction = new StationScopedTransaction(pooledDataSource, noRequestContext);
      const inside = await transaction.run(
        (database) => database.query(`SELECT current_setting('app.current_station_id', true) AS station_id, (SELECT count(*)::int FROM app.clients WHERE station_id = $1) AS client_count`, [stationIds.A]),
        { stationId: stationIds.A, userId: data.A.owner },
      );
      expect(inside[0]).toEqual({ station_id: stationIds.A, client_count: 1 });

      const afterCommit = await pooledDataSource.query(`SELECT coalesce(current_setting('app.current_station_id', true), '') AS station_id`);
      expect(afterCommit[0].station_id).toBe('');
      const nextRequestWithoutContext = await transaction.run((database) =>
        database.query(`SELECT count(*)::int AS client_count FROM app.clients WHERE station_id = ANY($1)`, [[stationIds.A, stationIds.B]]),
      );
      expect(nextRequestWithoutContext[0].client_count).toBe(0);
    });
  });

  describe('composite keys (enforced even where row-level security is bypassed)', () => {
    it.each([
      ['ad → client', `INSERT INTO app.ads (station_id, client_id, title) VALUES ($1, $2, 'x')`, (ofB: typeof data.B) => [stationIds.A, ofB.client], 'ads_client_foreign_key'],
      ['campaign → ad', `INSERT INTO app.campaigns (station_id, ad_id, name, active_period) VALUES ($1, $2, 'x', tstzrange(now(), now() + interval '1 day'))`, (ofB: typeof data.B) => [stationIds.A, ofB.ad], 'campaigns_ad_foreign_key'],
      ['campaign → card', `UPDATE app.campaigns SET action_card_id = $2 WHERE id = $1`, (ofB: typeof data.B) => [data.A.campaign, ofB.card], 'campaigns_action_card_foreign_key'],
      ['time window → campaign', `INSERT INTO app.campaign_time_windows (campaign_id, station_id, days_of_week, local_start_time, local_end_time) VALUES ($2, $1, '{1}', '07:00', '08:00')`, (ofB: typeof data.B) => [stationIds.A, ofB.campaign], 'campaign_time_windows_campaign_foreign_key'],
      ['client → default card', `UPDATE app.clients SET default_action_card_id = $2 WHERE id = $1`, (ofB: typeof data.B) => [data.A.client, ofB.card], 'clients_default_action_card_foreign_key'],
      ['ad → current card', `UPDATE app.ads SET current_action_card_id = $2 WHERE id = $1`, (ofB: typeof data.B) => [data.A.ad, ofB.card], 'ads_current_action_card_foreign_key'],
    ])("S1-ISOLATION-11: station A's %s cannot reference station B's row", async (_reference, sql, parameters, constraintName) => {
      await setupClient.query('BEGIN');
      try {
        await expect(setupClient.query(sql, parameters(data.B))).rejects.toThrow(constraintName);
      } finally {
        await setupClient.query('ROLLBACK');
      }
    });
  });

  describe('what each role may do', () => {
    it('S1-PRIVILEGES-20: the API role may edit only province, city, time zone, logo and listing of its station', async () => {
      await asStationA(async (client) => {
        await client.query(
          `UPDATE app.stations SET province = 'Lusaka', city = 'Lusaka', time_zone = 'Africa/Lusaka', logo_object_key = NULL, is_listed_in_app = true WHERE id = $1`,
          [stationIds.A],
        );
        for (const column of ['name', 'frequency_label', 'status']) {
          await expectRefused(client, `UPDATE app.stations SET ${column} = ${column} WHERE id = $1`, [stationIds.A], /permission denied/);
        }
      });
    });

    // Stronger than row-level security with no policy: the API role holds no grant on the table at all.
    it('S1-PRIVILEGES-10: the API role can neither read nor write recognition idempotency keys directly', async () => {
      await asStationA(async (client) => {
        await expectRefused(client, 'SELECT 1 FROM app.recognition_idempotency_keys LIMIT 1', [], /permission denied/);
        await expectRefused(
          client,
          `INSERT INTO app.recognition_idempotency_keys (listener_install_id, idempotency_key, recognition_event_id, recognition_received_at) VALUES ($1, $2, $3, now())`,
          [installId, randomUUID(), randomUUID()],
        );
      });
    });

    it('S1-PRIVILEGES-11: the API role is refused on both fingerprint tables', async () => {
      await asStationA(async (client) => {
        await expectRefused(client, 'SELECT 1 FROM fingerprints.hashes_version_1 LIMIT 1', [], /permission denied/);
        await expectRefused(client, 'SELECT 1 FROM fingerprints.audio_assets LIMIT 1', [], /permission denied/);
      });
    });

    it('S1-PRIVILEGES-08: the audit trail is append-only for every login role', async () => {
      await asStationA(async (client) => {
        await expectRefused(client, `UPDATE app.audit_events SET action = 'rewritten' WHERE station_id = $1`, [stationIds.A], /permission denied/);
        await expectRefused(client, `DELETE FROM app.audit_events WHERE station_id = $1`, [stationIds.A], /permission denied/);
      });
      await asRole('lookup_admin_api', async (client) => {
        const visible = await client.query(`SELECT count(*)::int AS event_count FROM app.audit_events WHERE station_id = ANY($1)`, [[stationIds.A, stationIds.B]]);
        expect(visible.rows[0].event_count).toBe(2);
        await expectRefused(client, `UPDATE app.audit_events SET action = 'rewritten' WHERE station_id = $1`, [stationIds.A], /permission denied/);
        await expectRefused(client, `DELETE FROM app.audit_events WHERE station_id = $1`, [stationIds.A], /permission denied/);
      });
      await asRole('lookup_fingerprint_worker', async (client) => {
        for (const sql of ['SELECT 1 FROM app.audit_events LIMIT 1', `UPDATE app.audit_events SET action = 'x'`, 'DELETE FROM app.audit_events']) {
          await expectRefused(client, sql, [], /permission denied/);
        }
      });
    });

    it('S1-PRIVILEGES-23, S1-ROLES-05: the super-admin role reads every station, changes only statuses, and never sees password hashes', async () => {
      await asRole('lookup_admin_api', async (client) => {
        const stations = await client.query(`SELECT id FROM app.stations WHERE id = ANY($1)`, [[stationIds.A, stationIds.B]]);
        expect(stations.rows).toHaveLength(2);
        await expectRefused(client, 'SELECT password_hash FROM app.portal_users LIMIT 1', [], /permission denied/);

        await client.query(`UPDATE app.portal_users SET status = status WHERE id = $1`, [data.A.owner]);
        await client.query(`UPDATE app.ads SET status = status WHERE id = $1`, [data.A.ad]);
        await client.query(`UPDATE app.campaigns SET status = status WHERE id = $1`, [data.A.campaign]);
        await client.query(`UPDATE app.listener_installs SET status = status WHERE id = $1`, [installId]);
        await expectRefused(client, `UPDATE app.portal_users SET full_name = 'x' WHERE id = $1`, [data.A.owner], /permission denied/);
        await expectRefused(client, `UPDATE app.ads SET title = 'x' WHERE id = $1`, [data.A.ad], /permission denied/);
        await expectRefused(client, `UPDATE app.campaigns SET name = 'x' WHERE id = $1`, [data.A.campaign], /permission denied/);
        await expectRefused(client, `UPDATE app.listener_installs SET app_version = 'x' WHERE id = $1`, [installId], /permission denied/);

        await client.query(`UPDATE app.stations SET name = name WHERE id = $1`, [stationIds.A]);
        await client.query(`INSERT INTO app.stations (name, frequency_label) VALUES ($1, '90.0 FM')`, [`Admin-made ${runTag}`]);
        await client.query(`UPDATE app.station_memberships SET role = 'MANAGER' WHERE station_id = $1 AND portal_user_id = $2`, [stationIds.A, data.A.owner]);
        await client.query(`INSERT INTO app.station_memberships (station_id, portal_user_id, role) VALUES ($1, $2, 'ANALYST')`, [stationIds.B, data.A.owner]);
        await client.query(`DELETE FROM app.station_memberships WHERE station_id = $1 AND portal_user_id = $2`, [stationIds.B, data.A.owner]);

        for (const tableName of ['clients', 'action_cards', 'recognition_events']) {
          const rows = await client.query(`SELECT 1 FROM app.${tableName} WHERE station_id = ANY($1)`, [[stationIds.A, stationIds.B]]);
          expect(rows.rows.length, tableName).toBeGreaterThan(1);
          await expectRefused(client, `UPDATE app.${tableName} SET station_id = station_id WHERE station_id = $1`, [stationIds.A], /permission denied/);
          await expectRefused(client, `DELETE FROM app.${tableName} WHERE station_id = $1`, [stationIds.A], /permission denied/);
        }
      });
    });

    it('S1-PRIVILEGES-24: the fingerprint worker works only in the fingerprints schema', async () => {
      await asRole('lookup_fingerprint_worker', async (client) => {
        await client.query('SELECT 1 FROM fingerprints.hashes_version_1 LIMIT 1');
        await client.query('SELECT 1 FROM fingerprints.audio_assets LIMIT 1');
        await expectRefused(client, 'UPDATE fingerprints.audio_assets SET id = id', [], /permission denied/);
        await expectRefused(client, 'DELETE FROM fingerprints.audio_assets', [], /permission denied/);
        for (const tableName of ['stations', 'portal_users', 'ads', 'clients', 'recognition_events']) {
          await expectRefused(client, `SELECT 1 FROM app.${tableName} LIMIT 1`, [], /permission denied/);
        }
      });
    });
  });
});
