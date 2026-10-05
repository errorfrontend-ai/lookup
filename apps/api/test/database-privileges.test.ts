import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asLookupApi, databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { PLACEHOLDER_PASSWORD_HASH } from './support/test-data.js';

/**
 * What the API's own database role (lookup_api) can and cannot do, independent of API code.
 * Each case is an attack a bug or an injection in the API could otherwise reach: reading
 * password hashes, promoting a user to super admin, lifting a station's suspension, rewriting
 * the audit trail, or attaching a station's buttons to another station's audio.
 */
describe('database privileges of the API role', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  const runTag = randomUUID().slice(0, 8);
  const ids = {
    stationA: randomUUID(),
    stationB: randomUUID(),
    ownerOfA: randomUUID(),
    analystOfA: randomUUID(),
    ownerOfB: randomUUID(),
    clientOfA: randomUUID(),
    actionCardOfA: randomUUID(),
    adOfA: randomUUID(),
  };
  const signedInAsOwnerOfA = { stationId: ids.stationA, userId: ids.ownerOfA };
  const asOwnerOfA = <Result>(work: (client: pg.Client) => Promise<Result>) =>
    asLookupApi(apiClient, signedInAsOwnerOfA, work);

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await setupClient.connect();
    await apiClient.connect();
    await setupClient.query(
      `INSERT INTO app.stations (id, name, frequency_label, status) VALUES
         ($1, $3, '98.1 FM', 'SUSPENDED'), ($2, $4, '104.3 FM', 'ACTIVE')`,
      [ids.stationA, ids.stationB, `Privileges A ${runTag}`, `Privileges B ${runTag}`],
    );
    await setupClient.query(
      `INSERT INTO app.portal_users (id, email, password_hash, full_name) VALUES
         ($1, $4, $7, 'Owner A'), ($2, $5, $7, 'Analyst A'), ($3, $6, $7, 'Owner B')`,
      [
        ids.ownerOfA, ids.analystOfA, ids.ownerOfB,
        `owner-a-${runTag}@example.test`, `analyst-a-${runTag}@example.test`, `owner-b-${runTag}@example.test`,
        PLACEHOLDER_PASSWORD_HASH,
      ],
    );
    await setupClient.query(
      `INSERT INTO app.station_memberships (station_id, portal_user_id, role) VALUES
         ($1, $3, 'OWNER'), ($1, $4, 'ANALYST'), ($2, $5, 'OWNER')`,
      [ids.stationA, ids.stationB, ids.ownerOfA, ids.analystOfA, ids.ownerOfB],
    );
    await setupClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, 'Client A')`, [
      ids.clientOfA,
      ids.stationA,
    ]);
    await setupClient.query(
      `INSERT INTO app.action_cards (id, station_id, client_id, schema_version, content) VALUES ($1, $2, $3, 1, '{"schema_version":1}')`,
      [ids.actionCardOfA, ids.stationA, ids.clientOfA],
    );
    await setupClient.query(`INSERT INTO app.ads (id, station_id, client_id, title) VALUES ($1, $2, $3, 'Ad A')`, [
      ids.adOfA,
      ids.stationA,
      ids.clientOfA,
    ]);
  });

  afterAll(async () => {
    await setupClient.query('DELETE FROM app.ads WHERE id = $1', [ids.adOfA]);
    await setupClient.query('DELETE FROM app.action_cards WHERE id = $1', [ids.actionCardOfA]);
    await setupClient.query('DELETE FROM app.clients WHERE id = $1', [ids.clientOfA]);
    await setupClient.query('DELETE FROM app.station_memberships WHERE station_id = ANY($1)', [[ids.stationA, ids.stationB]]);
    await setupClient.query('DELETE FROM app.portal_users WHERE id = ANY($1)', [[ids.ownerOfA, ids.analystOfA, ids.ownerOfB]]);
    await setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [[ids.stationA, ids.stationB]]);
    await apiClient.end();
    await setupClient.end();
  });

  describe('portal users', () => {
    it('cannot read password hashes, even its own', async () => {
      await expect(
        asOwnerOfA((client) => client.query('SELECT password_hash FROM app.portal_users WHERE id = $1', [ids.ownerOfA])),
      ).rejects.toThrow(/permission denied/);
    });

    it("sees itself and its station's team, never other stations' users", async () => {
      const everyone = [ids.ownerOfA, ids.analystOfA, ids.ownerOfB];
      const withStation = await asOwnerOfA((client) =>
        client.query('SELECT id FROM app.portal_users WHERE id = ANY($1)', [everyone]),
      );
      expect(withStation.rows.map((row) => row.id).sort()).toEqual([ids.ownerOfA, ids.analystOfA].sort());
      const withoutStation = await asLookupApi(apiClient, { userId: ids.ownerOfA }, (client) =>
        client.query('SELECT id FROM app.portal_users WHERE id = ANY($1)', [everyone]),
      );
      expect(withoutStation.rows.map((row) => row.id)).toEqual([ids.ownerOfA]);
    });

    it('cannot promote anyone to super admin or re-enable an account', async () => {
      await expect(
        asOwnerOfA((client) =>
          client.query(`UPDATE app.portal_users SET platform_role = 'SUPER_ADMIN' WHERE id = $1`, [ids.ownerOfA]),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asOwnerOfA((client) => client.query(`UPDATE app.portal_users SET status = 'ACTIVE' WHERE id = $1`, [ids.ownerOfA])),
      ).rejects.toThrow(/permission denied/);
    });

    it('cannot write any password hash, even its own (only the sign-in functions can)', async () => {
      await expect(
        asOwnerOfA((client) => client.query(`UPDATE app.portal_users SET password_hash = $2 WHERE id = $1`, [ids.ownerOfA, PLACEHOLDER_PASSWORD_HASH])),
      ).rejects.toThrow(/permission denied/);
    });

    it("can edit its own name, never a teammate's", async () => {
      const ownName = await asOwnerOfA((client) =>
        client.query(`UPDATE app.portal_users SET full_name = 'Owner A Renamed' WHERE id = $1`, [ids.ownerOfA]),
      );
      expect(ownName.rowCount).toBe(1);
      const teammateName = await asOwnerOfA((client) =>
        client.query(`UPDATE app.portal_users SET full_name = 'Changed' WHERE id = $1`, [ids.analystOfA]),
      );
      expect(teammateName.rowCount).toBe(0);
    });

    it('cannot create or delete users directly', async () => {
      await expect(
        asOwnerOfA((client) =>
          client.query(`INSERT INTO app.portal_users (email, password_hash, full_name) VALUES ('x@example.test', 'h', 'X')`),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asOwnerOfA((client) => client.query('DELETE FROM app.portal_users WHERE id = $1', [ids.analystOfA])),
      ).rejects.toThrow(/permission denied/);
    });

    it('has no direct access to refresh tokens', async () => {
      await expect(asOwnerOfA((client) => client.query('SELECT 1 FROM app.refresh_tokens LIMIT 1'))).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe('stations', () => {
    it('a station cannot change its own approval status (for example, lift a suspension)', async () => {
      await expect(
        asOwnerOfA((client) => client.query(`UPDATE app.stations SET status = 'ACTIVE' WHERE id = $1`, [ids.stationA])),
      ).rejects.toThrow(/permission denied/);
    });

    it("can edit its own profile, never another station's", async () => {
      const ownProfile = await asOwnerOfA((client) =>
        client.query(`UPDATE app.stations SET city = 'Ndola' WHERE id = $1`, [ids.stationA]),
      );
      expect(ownProfile.rowCount).toBe(1);
      const otherProfile = await asOwnerOfA((client) =>
        client.query(`UPDATE app.stations SET city = 'Ndola' WHERE id = $1`, [ids.stationB]),
      );
      expect(otherProfile.rowCount).toBe(0);
    });

    it('cannot create or delete stations directly', async () => {
      await expect(
        asOwnerOfA((client) => client.query(`INSERT INTO app.stations (name, frequency_label) VALUES ('Fake FM', '1.0 FM')`)),
      ).rejects.toThrow(/permission denied/);
      await expect(asOwnerOfA((client) => client.query('DELETE FROM app.stations WHERE id = $1', [ids.stationA]))).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  describe('ads and action cards', () => {
    it("cannot point an ad at an audio asset (that would hijack another station's audio)", async () => {
      await expect(
        asOwnerOfA((client) => client.query(`UPDATE app.ads SET audio_asset_id = gen_random_uuid() WHERE id = $1`, [ids.adOfA])),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asOwnerOfA((client) =>
          client.query(
            `INSERT INTO app.ads (station_id, client_id, title, audio_asset_id) VALUES ($1, $2, 'Title', gen_random_uuid())`,
            [ids.stationA, ids.clientOfA],
          ),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('can create ads for its own station', async () => {
      const inserted = await asOwnerOfA((client) =>
        client.query(`INSERT INTO app.ads (station_id, client_id, title) VALUES ($1, $2, 'New ad')`, [ids.stationA, ids.clientOfA]),
      );
      expect(inserted.rowCount).toBe(1);
    });

    it('action cards are immutable versions: no update, no delete', async () => {
      await expect(
        asOwnerOfA((client) => client.query(`UPDATE app.action_cards SET content = '{"x":1}' WHERE id = $1`, [ids.actionCardOfA])),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asOwnerOfA((client) => client.query('DELETE FROM app.action_cards WHERE id = $1', [ids.actionCardOfA])),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe('audit trail', () => {
    it('is append-only: insert yes, update and delete no', async () => {
      const inserted = await asOwnerOfA((client) =>
        client.query(`INSERT INTO app.audit_events (station_id, action, entity_type) VALUES ($1, 'test', 'probe')`, [
          ids.stationA,
        ]),
      );
      expect(inserted.rowCount).toBe(1);
      await expect(asOwnerOfA((client) => client.query(`UPDATE app.audit_events SET action = 'changed'`))).rejects.toThrow(
        /permission denied/,
      );
      await expect(asOwnerOfA((client) => client.query('DELETE FROM app.audit_events'))).rejects.toThrow(/permission denied/);
    });
  });

  describe('database-wide', () => {
    it('cannot create temporary tables', async () => {
      await expect(asOwnerOfA((client) => client.query('CREATE TEMP TABLE probe (x int)'))).rejects.toThrow(/permission denied/);
    });

    it('PUBLIC can neither connect nor use the public schema', async () => {
      const result = await setupClient.query(
        `SELECT has_database_privilege('public', current_database(), 'CONNECT') AS can_connect,
                has_database_privilege('public', current_database(), 'TEMPORARY') AS can_create_temporary_tables,
                has_schema_privilege('public', 'public', 'USAGE') AS can_use_public_schema`,
      );
      expect(result.rows[0]).toEqual({ can_connect: false, can_create_temporary_tables: false, can_use_public_schema: false });
    });

    it('no function of ours is executable by PUBLIC (protects future SECURITY DEFINER functions)', async () => {
      const result = await setupClient.query(
        `SELECT function_schema.nspname || '.' || stored_function.proname AS function_name
           FROM pg_proc AS stored_function
           JOIN pg_namespace AS function_schema ON function_schema.oid = stored_function.pronamespace
          WHERE function_schema.nspname IN ('app', 'fingerprints', 'recognition')
            AND NOT EXISTS (SELECT 1 FROM pg_depend AS dependency
                             WHERE dependency.objid = stored_function.oid AND dependency.deptype = 'e')
            AND has_function_privilege('public', stored_function.oid, 'EXECUTE')`,
      );
      expect(result.rows).toEqual([]);
    });

    it('server-side timeouts apply to the API role even if the application forgets its own', async () => {
      const setting = async (name: string) => (await apiClient.query(`SHOW ${name}`)).rows[0][name];
      expect(await setting('statement_timeout')).toBe('5s');
      expect(await setting('lock_timeout')).toBe('3s');
      expect(await setting('idle_in_transaction_session_timeout')).toBe('15s');
    });
  });
});
