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

  describe('phase 4: candidates, taps, counters, keys and reports', () => {
    /** A column of each table to name in a write, so the refusal is about the privilege and nothing else. */
    const P4_TABLES: Record<string, string> = {
      recognition_candidates: 'recognition_id',
      engagement_events: 'recognition_id',
      campaign_counters: 'campaign_id',
      engagement_deduplication_keys: 'recognition_id',
      recognition_reports: 'recognition_id',
    };

    it.each(Object.keys(P4_TABLES).flatMap((table) => ['INSERT', 'UPDATE', 'DELETE'].map((statement) => [statement, table])))(
      'P4-DATABASE-02: %s on %s is refused to the API role; only the database functions write there',
      async (statement, table) => {
        const column = P4_TABLES[table] as string;
        const sql = {
          INSERT: `INSERT INTO app.${table} (${column}) VALUES (gen_random_uuid())`,
          UPDATE: `UPDATE app.${table} SET ${column} = ${column}`,
          DELETE: `DELETE FROM app.${table}`,
        }[statement as 'INSERT' | 'UPDATE' | 'DELETE'];
        await expect(asOwnerOfA((client) => client.query(sql))).rejects.toThrow(/permission denied/);
      },
    );

    it('P4-DATABASE-02: the API role cannot read the tap keys or the reports at all; only super admins read reports', async () => {
      for (const table of ['engagement_deduplication_keys', 'recognition_reports']) {
        await expect(asOwnerOfA((client) => client.query(`SELECT 1 FROM app.${table} LIMIT 1`))).rejects.toThrow(/permission denied/);
      }
      const readers = await setupClient.query(
        `SELECT role_name, has_table_privilege(role_name, 'app.recognition_reports', 'SELECT') AS can_read
           FROM unnest(ARRAY['lookup_api', 'lookup_admin_api', 'lookup_fingerprint_worker']) AS role_name ORDER BY role_name`,
      );
      expect(readers.rows).toEqual([
        { role_name: 'lookup_admin_api', can_read: true },
        { role_name: 'lookup_api', can_read: false },
        { role_name: 'lookup_fingerprint_worker', can_read: false },
      ]);
      expect((await setupClient.query(`SELECT has_table_privilege('lookup_admin_api', 'app.engagement_deduplication_keys', 'SELECT') AS can_read`)).rows[0].can_read).toBe(false);
    });

    it.each(['listener_install_id', 'hinted_station_id', 'idempotency_key', 'client_captured_at', 'clock_skew_milliseconds'])(
      'P4-DATABASE-04: the API role cannot read %s of a recognition, even in its own station',
      async (column) => {
        await expect(asOwnerOfA((client) => client.query(`SELECT ${column} FROM app.recognition_events LIMIT 1`))).rejects.toThrow(/permission denied/);
      },
    );

    it('P4-DATABASE-04: so SELECT * is refused to the API role; the columns a station may see stay readable, and super admins read every column', async () => {
      await expect(asOwnerOfA((client) => client.query('SELECT * FROM app.recognition_events LIMIT 1'))).rejects.toThrow(/permission denied/);
      await asOwnerOfA((client) => client.query('SELECT id, station_id, outcome, resolution, captured_at FROM app.recognition_events LIMIT 1'));
      const readable = await setupClient.query(
        `SELECT attname AS column_name FROM pg_attribute
          WHERE attrelid = 'app.recognition_events'::regclass AND attnum > 0 AND NOT attisdropped
            AND has_column_privilege('lookup_api', attrelid, attname, 'SELECT') ORDER BY attname`,
      );
      expect(readable.rows.map((row) => row.column_name)).toEqual(
        [
          'action_card_id', 'aligned_hash_count', 'attempt_count', 'audio_asset_id', 'campaign_id', 'captured_at', 'clip_duration_milliseconds', 'completed_at',
          'fallback_reason', 'fingerprint_version', 'id', 'is_deferred', 'last_claimed_at', 'latency_milliseconds', 'match_margin', 'match_offset_milliseconds',
          'outcome', 'received_at', 'request_id', 'resolution', 'station_id',
        ].sort(),
      );
      await setupClient.query('BEGIN');
      try {
        await setupClient.query('SET LOCAL ROLE lookup_admin_api');
        await setupClient.query('SELECT * FROM app.recognition_events LIMIT 1');
        await setupClient.query('SELECT * FROM app.recognition_reports LIMIT 1');
      } finally {
        await setupClient.query('ROLLBACK');
      }
    });

    /** Each function the API calls in phase 4 and what it returns (P4 design §4.4; ALL-DATABASE-07). */
    const P4_API_FUNCTIONS: Array<[string, string]> = [
      ['recognition.claim_recognition(uuid, uuid, uuid, text, timestamptz, timestamptz, bigint, timestamptz, boolean, integer)',
        'TABLE(recognition_id uuid, recognition_received_at timestamp with time zone, recognition_captured_at timestamp with time zone, attempt_number integer, claim_outcome text, previous_outcome text, is_deferred boolean)'],
      ['recognition.find_station_candidates(integer, timestamptz)',
        'TABLE(station_id uuid, station_name text, station_frequency_label text, station_city text, ad_title text, client_name text, campaign_id uuid, campaign_period_started_at timestamp with time zone, is_campaign_active boolean, campaign_action_card_id uuid, campaign_card jsonb, client_default_action_card_id uuid, client_default_card jsonb, is_in_window boolean, matched_slot_started_at timestamp with time zone, last_slot_ended_at timestamp with time zone, is_at_engagement_limit boolean)'],
      ['recognition.finish_recognition(uuid, timestamptz, integer, text, text, integer, uuid, uuid, uuid, text, uuid, jsonb, integer, real, integer, integer, smallint)', 'boolean'],
      ['recognition.describe_recognition_for_replay(uuid, timestamptz, uuid)',
        'TABLE(outcome text, is_deferred boolean, captured_at timestamp with time zone, display_position smallint, card_kind text, station_id uuid, station_name text, station_frequency_label text, station_city text, is_station_active boolean, client_name text, ad_title text, action_card jsonb)'],
      ['recognition.count_recognition_attempts(uuid, uuid)', 'integer'],
      ['recognition.record_station_choice(uuid, uuid, uuid)', 'text'],
      ['recognition.list_stations_for_listeners(integer)', 'TABLE(station_id uuid, station_name text, station_frequency_label text, station_city text)'],
      ['recognition.record_engagement(uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, bigint, timestamptz, text, integer)', 'text'],
      ['recognition.record_recognition_report(uuid, uuid, text, uuid, text, timestamptz, text)', 'text'],
      ['recognition.delete_expired_recognition_idempotency_keys(interval, integer)', 'integer'],
      ['app.create_listener_traffic_partitions(integer)', 'integer'],
    ];
    const describeFunction = async (signature: string) =>
      (
        await setupClient.query(
          `SELECT prosecdef AS is_security_definer, proconfig AS settings, pg_get_function_result(oid) AS result,
                  array_remove(ARRAY[CASE WHEN has_function_privilege('lookup_api', oid, 'EXECUTE') THEN 'lookup_api' END,
                                     CASE WHEN has_function_privilege('lookup_admin_api', oid, 'EXECUTE') THEN 'lookup_admin_api' END,
                                     CASE WHEN has_function_privilege('lookup_fingerprint_worker', oid, 'EXECUTE') THEN 'lookup_fingerprint_worker' END], NULL) AS callers
             FROM pg_proc WHERE oid = $1::regprocedure`,
          [signature],
        )
      ).rows[0] as { is_security_definer: boolean; settings: string[]; result: string; callers: string[] };

    it.each(P4_API_FUNCTIONS)('P4-DATABASE-02, ALL-DATABASE-06, -07: %s is a definer function with its search path pinned, run only by the API role, returning what it documents', async (signature, result) => {
      expect(await describeFunction(signature)).toEqual({
        is_security_definer: true,
        settings: [expect.stringMatching(/^search_path=pg_catalog, .*pg_temp$/)],
        result,
        callers: ['lookup_api'],
      });
    });

    it.each([
      'recognition.record_choice_on_locked_recognition(uuid, timestamptz, uuid)',
      'recognition.compute_earliest_receipt_time(uuid)',
      'recognition.compute_latest_receipt_time(uuid)',
      'app.is_time_window_open_with_grace(smallint[], time, time, timestamp, interval)',
      'app.list_time_window_slots_on_air(smallint[], time, time, timestamp, interval)',
      'app.list_time_window_slots(smallint[], time, time, timestamp, timestamp)',
      'app.name_listener_traffic_partition_objects(text, text)',
      'app.set_campaign_status_changed_at()',
    ])('ALL-DATABASE-08: the helper %s is run by no service role, keeps the rights of whoever calls it, and pins its search path', async (signature) => {
      expect(await describeFunction(signature)).toMatchObject({ is_security_definer: false, settings: [expect.stringMatching(/^search_path=pg_catalog, .*pg_temp$/)], callers: [] });
    });

    it('the Step 3 functions phase 4 replaced are gone', async () => {
      const gone = await setupClient.query(
        `SELECT to_regprocedure('recognition.find_stations_for_audio(integer, timestamptz)') AS find_stations,
                to_regprocedure('recognition.describe_recognition(uuid, timestamptz, uuid)') AS describe_recognition,
                to_regprocedure('app.create_recognition_event_partitions(integer)') AS create_partitions,
                to_regprocedure('app.name_recognition_event_partition_indexes(text)') AS name_partition_indexes`,
      );
      expect(gone.rows[0]).toEqual({ find_stations: null, describe_recognition: null, create_partitions: null, name_partition_indexes: null });
    });
  });
});
