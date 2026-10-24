import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asLookupApi, databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { PLACEHOLDER_PASSWORD_HASH } from './support/test-data.js';

/**
 * Client accounts in the database (migration ClientAccounts; ADR-006): what the API's login can and cannot do with the
 * client tables, independent of API code, when an advert's slots fall, and which reminders are due. A leaked or misused
 * API login must not be able to read who follows which client, or another person's devices, except through the
 * functions; and a client's session must see nothing of a station's own tables.
 *
 * Monday 5 October 2026 starts the test week. Lusaka is UTC+2 all year; London is UTC+1 until Sunday 25 October 2026,
 * then UTC+0.
 */
describe('client accounts in the database', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;

  const stations = { lusaka: randomUUID(), london: randomUUID(), suspended: randomUUID() };
  const clients = { brandA: randomUUID(), brandB: randomUUID(), brandLondon: randomUUID(), brandSuspended: randomUUID() };
  const ads = { brandA: randomUUID(), brandB: randomUUID(), brandLondon: randomUUID(), brandSuspended: randomUUID() };
  const people = { viewerA: randomUUID(), viewerB: randomUUID(), viewerSuspended: randomUUID(), stranger: randomUUID() };

  const NEW_TABLES = [
    'app.client_viewers',
    'app.client_viewer_notification_settings',
    'app.client_viewer_muted_ads',
    'app.web_push_subscriptions',
    'app.air_time_reminders',
  ];

  /** A campaign for [adId] with [windows] (station time), replacing the ad's earlier campaign. */
  async function campaign(
    stationId: string,
    adId: string,
    options: { status?: string; from?: string; until?: string; windows?: Array<[number[], string, string]> } = {},
  ): Promise<{ campaignId: string; windowIds: string[] }> {
    await setupClient.query('DELETE FROM app.campaign_time_windows WHERE campaign_id IN (SELECT id FROM app.campaigns WHERE ad_id = $1)', [adId]);
    await setupClient.query('DELETE FROM app.campaigns WHERE ad_id = $1', [adId]);
    const created = await setupClient.query(
      `INSERT INTO app.campaigns (station_id, ad_id, name, status, active_period)
       VALUES ($1, $2, 'Client campaign', $3, tstzrange($4::timestamptz, $5::timestamptz, '[)')) RETURNING id`,
      [stationId, adId, options.status ?? 'ACTIVE', options.from ?? '2026-10-01T00:00:00Z', options.until ?? '2026-11-15T00:00:00Z'],
    );
    const campaignId = created.rows[0].id as string;
    const windowIds: string[] = [];
    for (const [days, start, end] of options.windows ?? [[[1, 2, 3, 4, 5], '07:00', '09:00']]) {
      const window = await setupClient.query(
        `INSERT INTO app.campaign_time_windows (campaign_id, station_id, days_of_week, local_start_time, local_end_time)
         VALUES ($1, $2, $3::smallint[], $4, $5) RETURNING id`,
        [campaignId, stationId, days, start, end],
      );
      windowIds.push(window.rows[0].id as string);
    }
    return { campaignId, windowIds };
  }

  const slotsOf = async (campaignId: string, from: string, until: string) =>
    (
      await setupClient.query(
        `SELECT slot_starts_at, slot_ends_at, local_date, local_start_time, local_end_time
           FROM app.list_campaign_slot_starts($1, $2::timestamptz, $3::timestamptz)`,
        [campaignId, from, until],
      )
    ).rows.map((row: { slot_starts_at: Date; slot_ends_at: Date; local_date: string; local_start_time: string; local_end_time: string }) => ({
      startsAt: row.slot_starts_at.toISOString(),
      endsAt: row.slot_ends_at.toISOString(),
      localDate: row.local_date,
      localStartTime: row.local_start_time,
      localEndTime: row.local_end_time,
    }));

  /** Runs [work] on the setup connection inside a transaction that always rolls back, after [changes]. */
  async function withChanges<Result>(changes: Array<[string, unknown[]]>, work: () => Promise<Result>): Promise<Result> {
    await setupClient.query('BEGIN');
    try {
      for (const [sql, parameters] of changes) await setupClient.query(sql, parameters);
      return await work();
    } finally {
      await setupClient.query('ROLLBACK');
    }
  }

  /** The reminders due at [atMoment] for Brand A's advert at the Lusaka station, as (person, slot start). */
  const dueForBrandA = async (atMoment: string) =>
    (await setupClient.query('SELECT * FROM app.list_due_air_time_reminders($1::timestamptz) WHERE ad_id = $2', [atMoment, ads.brandA])).rows as Array<{
      portal_user_id: string;
      email: string;
      campaign_time_window_id: string;
      slot_starts_at: Date;
      local_date: string;
      local_start_time: string;
      local_end_time: string;
      is_today: boolean;
      station_name: string;
      ad_title: string;
      client_name: string;
      is_push_on: boolean;
      is_email_on: boolean;
    }>;

  /** Runs [sql] as the API role for [person] and keeps what it wrote. */
  const asPersonCommitted = async (person: string, sql: string, parameters: unknown[]) => {
    await apiClient.query('BEGIN');
    try {
      await apiClient.query(`SELECT set_config('app.current_user_id', $1, true)`, [person]);
      const result = await apiClient.query(sql, parameters);
      await apiClient.query('COMMIT');
      return result;
    } catch (problem) {
      await apiClient.query('ROLLBACK');
      throw problem;
    }
  };

  const expectRefused = async (sql: string, parameters: unknown[] = []) => {
    await apiClient.query('BEGIN');
    try {
      await expect(apiClient.query(sql, parameters)).rejects.toThrow(/permission denied/);
    } finally {
      await apiClient.query('ROLLBACK');
    }
  };

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await setupClient.connect();
    await apiClient.connect();
    await setupClient.query(
      `INSERT INTO app.stations (id, name, frequency_label, status, time_zone) VALUES
         ($1, 'Lusaka Client FM', '98.1 FM', 'ACTIVE', 'Africa/Lusaka'),
         ($2, 'London Client FM', '101.1 FM', 'ACTIVE', 'Europe/London'),
         ($3, 'Suspended Client FM', '91.1 FM', 'SUSPENDED', 'Africa/Lusaka')`,
      [stations.lusaka, stations.london, stations.suspended],
    );
    await setupClient.query(
      `INSERT INTO app.clients (id, station_id, name) VALUES ($1, $5, 'Brand A'), ($2, $5, 'Brand B'), ($3, $6, 'Brand London'), ($4, $7, 'Brand Suspended')`,
      [clients.brandA, clients.brandB, clients.brandLondon, clients.brandSuspended, stations.lusaka, stations.london, stations.suspended],
    );
    await setupClient.query(
      `INSERT INTO app.ads (id, station_id, client_id, title) VALUES
         ($1, $5, $9, 'Brand A offer'), ($2, $6, $10, 'Brand B offer'), ($3, $7, $11, 'Brand London offer'), ($4, $8, $12, 'Brand Suspended offer')`,
      [
        ads.brandA, ads.brandB, ads.brandLondon, ads.brandSuspended,
        stations.lusaka, stations.lusaka, stations.london, stations.suspended,
        clients.brandA, clients.brandB, clients.brandLondon, clients.brandSuspended,
      ],
    );
    for (const [name, id] of Object.entries(people)) {
      await setupClient.query('INSERT INTO app.portal_users (id, email, password_hash, full_name) VALUES ($1, $2, $3, $4)', [
        id,
        `${name.toLowerCase()}-${id.slice(0, 8)}@example.test`,
        PLACEHOLDER_PASSWORD_HASH,
        `Client ${name}`,
      ]);
    }
    await setupClient.query(
      `INSERT INTO app.client_viewers (client_id, station_id, portal_user_id) VALUES
         ($1, $5, $8), ($3, $6, $8), ($2, $5, $9), ($4, $7, $10)`,
      [clients.brandA, clients.brandB, clients.brandLondon, clients.brandSuspended, stations.lusaka, stations.london, stations.suspended, people.viewerA, people.viewerB, people.viewerSuspended],
    );
    await campaign(stations.lusaka, ads.brandA);
    await campaign(stations.lusaka, ads.brandB);
    await campaign(stations.london, ads.brandLondon);
    await campaign(stations.suspended, ads.brandSuspended);
  });

  afterAll(async () => {
    const stationIds = Object.values(stations);
    await setupClient.query('DELETE FROM app.portal_users WHERE id = ANY($1)', [Object.values(people)]);
    await setupClient.query('DELETE FROM app.campaign_time_windows WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.campaigns WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.ads WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.clients WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [stationIds]);
    await apiClient.end();
    await setupClient.end();
  });

  describe('the tables', () => {
    it.each(NEW_TABLES)('P5C-DATABASE-01: %s has row-level security on, no policy, and no privilege of any kind for the service roles', async (table) => {
      const shape = (
        await setupClient.query(`SELECT relrowsecurity, (SELECT count(*)::int FROM pg_policy WHERE polrelid = $1::regclass) AS policies FROM pg_class WHERE oid = $1::regclass`, [table])
      ).rows[0];
      expect(shape).toEqual({ relrowsecurity: true, policies: 0 });
      const grants = await setupClient.query(
        `SELECT role_name || ' ' || privilege AS grant_description
           FROM unnest(ARRAY['lookup_api', 'lookup_admin_api', 'lookup_fingerprint_worker']) AS role_name,
                unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS privilege
          WHERE has_table_privilege(role_name, $1, privilege)`,
        [table],
      );
      expect(grants.rows).toEqual([]);
      const columnGrants = await setupClient.query(
        `SELECT role_name || ' ' || privilege || ' ' || attname AS grant_description
           FROM pg_attribute, unnest(ARRAY['lookup_api', 'lookup_admin_api', 'lookup_fingerprint_worker']) AS role_name,
                unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS privilege
          WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND has_column_privilege(role_name, attrelid, attnum, privilege)`,
        [table],
      );
      expect(columnGrants.rows).toEqual([]);
    });

    it.each([
      ['read who follows which client', 'SELECT * FROM app.client_viewers'],
      ['give someone access', `INSERT INTO app.client_viewers (client_id, station_id, portal_user_id) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`],
      ['remove access', 'DELETE FROM app.client_viewers'],
      ['read the devices', 'SELECT endpoint FROM app.web_push_subscriptions'],
      ['count the devices', 'SELECT count(*) FROM app.web_push_subscriptions'],
      ['read the settings', 'SELECT * FROM app.client_viewer_notification_settings'],
      ['read the muted adverts', 'SELECT * FROM app.client_viewer_muted_ads'],
      ['mark a reminder as sent', 'DELETE FROM app.air_time_reminders'],
    ])('P5C-DATABASE-01: as the API role, to %s directly is refused', async (_what, sql) => {
      await expectRefused(sql);
    });

    it('P5C-DATABASE-01: a row is keyed by client, station and person; the client and the person cascade, the invitation is only remembered', async () => {
      const constraints = await setupClient.query(`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'app.client_viewers'::regclass ORDER BY conname`);
      expect(constraints.rows).toEqual([
        { conname: 'client_viewers_client_foreign_key', definition: 'FOREIGN KEY (client_id, station_id) REFERENCES app.clients(id, station_id) ON DELETE CASCADE' },
        { conname: 'client_viewers_invitation_foreign_key', definition: 'FOREIGN KEY (invitation_id) REFERENCES app.invitations(id) ON DELETE SET NULL' },
        { conname: 'client_viewers_portal_user_foreign_key', definition: 'FOREIGN KEY (portal_user_id) REFERENCES app.portal_users(id) ON DELETE CASCADE' },
        { conname: 'client_viewers_primary_key', definition: 'PRIMARY KEY (client_id, station_id, portal_user_id)' },
      ]);
    });

    it('P5C-DATABASE-02: one login follows clients at three stations, and every one of them is listed', async () => {
      const thirdStation = randomUUID();
      const thirdClient = randomUUID();
      const listed = await withChanges(
        [
          [`INSERT INTO app.stations (id, name, frequency_label, status, time_zone) VALUES ($1, 'Third Client FM', '88.8 FM', 'ACTIVE', 'Africa/Lusaka')`, [thirdStation]],
          [`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, 'Brand Third')`, [thirdClient, thirdStation]],
          ['INSERT INTO app.client_viewers (client_id, station_id, portal_user_id) VALUES ($1, $2, $3)', [thirdClient, thirdStation, people.viewerA]],
          [`SELECT set_config('app.current_user_id', $1, true)`, [people.viewerA]],
        ],
        async () => ({
          rows: (await setupClient.query('SELECT count(*)::int AS rows FROM app.client_viewers WHERE portal_user_id = $1', [people.viewerA])).rows[0].rows as number,
          stations: (await setupClient.query('SELECT station_id FROM app.list_client_viewer_accesses()')).rows.map((row: { station_id: string }) => row.station_id).sort(),
        }),
      );
      expect(listed).toEqual({ rows: 3, stations: [stations.lusaka, stations.london, thirdStation].sort() });
    });

    /** Every table that belongs to a station (it has a station id), and the stations themselves. */
    const stationTables = async () =>
      (
        await setupClient.query(
          `SELECT DISTINCT class.oid::regclass::text AS name
             FROM pg_class AS class
             JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
             JOIN pg_attribute AS attribute ON attribute.attrelid = class.oid AND attribute.attname = 'station_id' AND NOT attribute.attisdropped
            WHERE namespace.nspname IN ('app', 'recognition') AND class.relkind IN ('r', 'p') AND NOT class.relispartition
            ORDER BY 1`,
        )
      ).rows.map((row: { name: string }) => row.name);

    /** What [sql] does as the API role in viewer A's client session: refused, or how many rows it read or changed. */
    const inClientSession = async (sql: string) =>
      asLookupApi(apiClient, { userId: people.viewerA }, async (client) => {
        await client.query('SAVEPOINT attempt');
        try {
          const result = await client.query(sql);
          return result.command === 'SELECT' ? Number(result.rows[0]?.count ?? result.rowCount) : result.rowCount;
        } catch (problem) {
          await client.query('ROLLBACK TO SAVEPOINT attempt');
          if (/permission denied|row-level security/.test(String(problem))) return 'refused';
          throw problem;
        }
      });

    it("P5C-DATABASE-04: a client's session (a person, no station) reads no row of any station table, even of the ads it follows", async () => {
      const tables = await stationTables();
      expect(tables).toEqual(expect.arrayContaining(['app.ads', 'app.campaigns', 'app.clients', 'app.action_cards', 'app.client_viewers']));
      const seen: Record<string, number | string | null> = {};
      for (const table of [...tables, 'app.stations']) seen[table] = await inClientSession(`SELECT count(*) FROM ${table}`);
      expect(Object.entries(seen).filter(([, read]) => read !== 0 && read !== 'refused')).toEqual([]);
      expect(seen['app.ads']).toBe(0);
    });

    it("P5C-DATABASE-05: a client's session changes no row of any station table: every update and delete changes nothing or is refused", async () => {
      const changed: Record<string, number | string | null> = {};
      for (const table of await stationTables()) {
        changed[`update ${table}`] = await inClientSession(`UPDATE ${table} SET station_id = station_id`);
        changed[`delete ${table}`] = await inClientSession(`DELETE FROM ${table}`);
      }
      changed['update app.stations'] = await inClientSession('UPDATE app.stations SET name = name');
      expect(Object.entries(changed).filter(([, rows]) => rows !== 0 && rows !== 'refused')).toEqual([]);
    });

    it("P5C-DATABASE-05: a client's session adds no row to a station table: every policy that lets the API role write asks for the station the request works in, and a client's request names none", async () => {
      const policies = await setupClient.query(
        `SELECT tablename, policyname, cmd, coalesce(with_check, qual) AS check_expression FROM pg_policies
          WHERE schemaname IN ('app', 'recognition') AND 'lookup_api' = ANY (roles) AND cmd IN ('ALL', 'INSERT')`,
      );
      expect(policies.rows.length).toBeGreaterThan(0);
      expect(policies.rows.filter((policy: { check_expression: string }) => policy.check_expression !== '(station_id = app.current_station_id())')).toEqual([]);
      expect(await asLookupApi(apiClient, { userId: people.viewerA }, async (client) => (await client.query('SELECT app.current_station_id() AS station')).rows[0].station)).toBeNull();
      for (const sql of [
        `INSERT INTO app.clients (station_id, name) VALUES ('${stations.lusaka}', 'Planted client')`,
        `INSERT INTO app.ads (station_id, client_id, title) VALUES ('${stations.lusaka}', '${clients.brandA}', 'Planted ad')`,
      ]) {
        expect(await inClientSession(sql)).toBe('refused');
      }
    });

    it("P5C-DATABASE-05: a client's session (a person, no station) sees none of a station's own rows, even of the ads it follows", async () => {
      const counts = await asLookupApi(apiClient, { userId: people.viewerA }, async (client) =>
        (
          await client.query(
            `SELECT (SELECT count(*)::int FROM app.ads WHERE id = $1) AS ads,
                    (SELECT count(*)::int FROM app.clients WHERE id = $2) AS clients,
                    (SELECT count(*)::int FROM app.campaigns WHERE ad_id = $1) AS campaigns`,
            [ads.brandA, clients.brandA],
          )
        ).rows[0],
      );
      expect(counts).toEqual({ ads: 0, clients: 0, campaigns: 0 });
    });
  });

  describe('the functions', () => {
    const API_FUNCTIONS = [
      'app.list_client_viewers(uuid, uuid)',
      'app.count_client_viewers_of_current_station()',
      'app.create_client_viewer_invitation(uuid, uuid, text, bytea, text)',
      'app.resend_client_viewer_invitation(uuid, uuid, uuid, bytea, text)',
      'app.revoke_client_viewer_invitation(uuid, uuid, uuid, text)',
      'app.remove_client_viewer(uuid, uuid, uuid, text)',
      'app.describe_client_viewer_invitation(bytea)',
      'app.accept_client_viewer_invitation_with_new_account(bytea, text, text, text, bytea, text)',
      'app.accept_client_viewer_invitation_for_signed_in_user(bytea, text)',
      'app.list_client_viewer_accesses()',
      'app.list_client_viewer_ads(uuid)',
      'app.read_client_viewer_ad(uuid, uuid)',
      'app.read_client_viewer_figures(uuid, uuid, integer)',
      'app.list_client_viewer_daily_figures(uuid, integer)',
      'app.list_client_viewer_next_slots(uuid, uuid, integer)',
      'app.read_listener_mix_for_client_ad(uuid, uuid, integer)',
      'app.read_client_viewer_notification_settings()',
      'app.save_client_viewer_notification_settings(boolean, boolean, smallint, jsonb)',
      'app.save_web_push_subscription(text, bytea, text, text)',
      'app.delete_own_web_push_subscription(bytea)',
      'app.list_own_web_push_subscriptions()',
      'app.list_due_air_time_reminders(timestamptz)',
      'app.claim_air_time_reminder(uuid, uuid, timestamptz)',
      'app.delete_old_air_time_reminders(interval)',
      'app.list_web_push_subscriptions_of(uuid)',
      'app.forget_web_push_subscription(bytea)',
      'app.note_web_push_sent(bytea)',
    ];
    /** Used only inside the functions above: nobody but the schema owner may run them. */
    const INTERNAL_FUNCTIONS = [
      'app.is_current_station_content_editor(uuid)',
      'app.compute_listener_mix(uuid, uuid, integer)',
      'app.list_campaign_slot_starts(uuid, timestamptz, timestamptz)',
      'app.can_current_user_view_ad(uuid, uuid)',
    ];
    const describeFunction = async (signature: string) =>
      (
        await setupClient.query(
          `SELECT prosecdef AS is_security_definer, proconfig AS settings, pg_get_userbyid(proowner) AS owner,
                  array_remove(ARRAY[CASE WHEN has_function_privilege('lookup_api', oid, 'EXECUTE') THEN 'lookup_api' END,
                                     CASE WHEN has_function_privilege('lookup_admin_api', oid, 'EXECUTE') THEN 'lookup_admin_api' END,
                                     CASE WHEN has_function_privilege('lookup_fingerprint_worker', oid, 'EXECUTE') THEN 'lookup_fingerprint_worker' END,
                                     CASE WHEN has_function_privilege('public', oid, 'EXECUTE') THEN 'public' END], NULL) AS callers
             FROM pg_proc WHERE oid = $1::regprocedure`,
          [signature],
        )
      ).rows[0] as { is_security_definer: boolean; settings: string[]; owner: string; callers: string[] };

    it.each(API_FUNCTIONS)('P5C-DATABASE-03: %s is a definer function owned by the schema owner, with its search path pinned, run only by the API role', async (signature) => {
      expect(await describeFunction(signature)).toEqual({
        is_security_definer: true,
        settings: [expect.stringMatching(/^search_path=pg_catalog, .*pg_temp$/)],
        owner: 'lookup_schema_owner',
        callers: ['lookup_api'],
      });
    });

    it.each(INTERNAL_FUNCTIONS)('P5C-DATABASE-03: %s runs as its caller, with its search path pinned, and no service role may call it', async (signature) => {
      expect(await describeFunction(signature)).toEqual({
        is_security_definer: false,
        settings: [expect.stringMatching(/^search_path=pg_catalog, .*pg_temp$/)],
        owner: 'lookup_schema_owner',
        callers: [],
      });
    });

    const WRITING_FUNCTIONS = [
      'app.create_client_viewer_invitation(uuid, uuid, text, bytea, text)',
      'app.resend_client_viewer_invitation(uuid, uuid, uuid, bytea, text)',
      'app.revoke_client_viewer_invitation(uuid, uuid, uuid, text)',
      'app.remove_client_viewer(uuid, uuid, uuid, text)',
      'app.accept_client_viewer_invitation_with_new_account(bytea, text, text, text, bytea, text)',
      'app.accept_client_viewer_invitation_for_signed_in_user(bytea, text)',
      'app.save_client_viewer_notification_settings(boolean, boolean, smallint, jsonb)',
      'app.save_web_push_subscription(text, bytea, text, text)',
      'app.delete_own_web_push_subscription(bytea)',
      'app.claim_air_time_reminder(uuid, uuid, timestamptz)',
      'app.delete_old_air_time_reminders(interval)',
      'app.forget_web_push_subscription(bytea)',
      'app.note_web_push_sent(bytea)',
    ];

    it('P5C-DATABASE-05: every client read is read-only (STABLE); only the invitation, settings, device and reminder functions write', async () => {
      const volatility = await setupClient.query(
        `SELECT signature, (SELECT provolatile FROM pg_proc WHERE oid = signature::regprocedure) AS volatility FROM unnest($1::text[]) AS signature`,
        [[...API_FUNCTIONS, ...INTERNAL_FUNCTIONS]],
      );
      const writing = new Set(WRITING_FUNCTIONS);
      expect(volatility.rows.filter((row: { signature: string; volatility: string }) => (row.volatility === 's') === writing.has(row.signature))).toEqual([]);
    });

    it('P5C-DATABASE-03: every client, push and reminder function in the database is one of those listed above', async () => {
      const found = await setupClient.query(
        `SELECT oid::regprocedure::text AS signature FROM pg_proc
          WHERE pronamespace = 'app'::regnamespace AND proname ~ '(client_viewer|web_push|air_time|client_ad|campaign_slot)'`,
      );
      const listed = new Set(
        await Promise.all([...API_FUNCTIONS, ...INTERNAL_FUNCTIONS].map(async (signature) => (await setupClient.query('SELECT $1::regprocedure::text AS name', [signature])).rows[0].name as string)),
      );
      expect(found.rows.map((row: { signature: string }) => row.signature).filter((signature: string) => !listed.has(signature))).toEqual([]);
    });
  });

  describe("an advert's slots, in the station's time", () => {
    it('P5C-ADVERT-01: Monday to Friday 07:00–09:00 in Lusaka gives five slots, each starting at 05:00 UTC', async () => {
      const { campaignId } = await campaign(stations.lusaka, ads.brandB);
      const slots = await slotsOf(campaignId, '2026-10-04T22:00:00Z', '2026-10-11T22:00:00Z');
      expect(slots.map((slot) => slot.startsAt)).toEqual([
        '2026-10-05T05:00:00.000Z',
        '2026-10-06T05:00:00.000Z',
        '2026-10-07T05:00:00.000Z',
        '2026-10-08T05:00:00.000Z',
        '2026-10-09T05:00:00.000Z',
      ]);
      expect(slots[0]).toEqual({ startsAt: '2026-10-05T05:00:00.000Z', endsAt: '2026-10-05T07:00:00.000Z', localDate: '2026-10-05', localStartTime: '07:00', localEndTime: '09:00' });
    });

    it('P5C-ADVERT-01: a slot past midnight belongs to the day it starts, and ends the next morning', async () => {
      const { campaignId } = await campaign(stations.lusaka, ads.brandB, { windows: [[[5], '22:00', '02:00']] });
      expect(await slotsOf(campaignId, '2026-10-08T22:00:00Z', '2026-10-10T10:00:00Z')).toEqual([
        { startsAt: '2026-10-09T20:00:00.000Z', endsAt: '2026-10-10T00:00:00.000Z', localDate: '2026-10-09', localStartTime: '22:00', localEndTime: '02:00' },
      ]);
      // Saturday 00:30 the slot is on air: it started before, so it is not a slot to come.
      expect(await slotsOf(campaignId, '2026-10-09T22:30:00Z', '2026-10-10T10:00:00Z')).toEqual([]);
    });

    it('P5C-ADVERT-01: Sunday into Monday belongs to Sunday', async () => {
      const { campaignId } = await campaign(stations.lusaka, ads.brandB, { windows: [[[7], '23:00', '01:00']] });
      expect(await slotsOf(campaignId, '2026-10-04T22:00:00Z', '2026-10-12T22:00:00Z')).toEqual([
        { startsAt: '2026-10-11T21:00:00.000Z', endsAt: '2026-10-11T23:00:00.000Z', localDate: '2026-10-11', localStartTime: '23:00', localEndTime: '01:00' },
      ]);
    });

    it("P5C-ADVERT-01: the station's clock is followed across a change of summer time (London, 25 October 2026)", async () => {
      const { campaignId } = await campaign(stations.london, ads.brandLondon, { windows: [[[1], '07:00', '08:00']] });
      const slots = await slotsOf(campaignId, '2026-10-19T00:00:00Z', '2026-10-27T00:00:00Z');
      expect(slots.map((slot) => [slot.startsAt, slot.localStartTime])).toEqual([
        ['2026-10-19T06:00:00.000Z', '07:00'],
        ['2026-10-26T07:00:00.000Z', '07:00'],
      ]);
      await campaign(stations.london, ads.brandLondon);
    });

    it("P5C-ADVERT-01: only slots inside the campaign's dates count, and a slot starting at the end of the range does not", async () => {
      const { campaignId } = await campaign(stations.lusaka, ads.brandB, { from: '2026-10-07T00:00:00Z', until: '2026-10-09T05:00:00Z' });
      expect((await slotsOf(campaignId, '2026-10-04T22:00:00Z', '2026-10-11T22:00:00Z')).map((slot) => slot.localDate)).toEqual(['2026-10-07', '2026-10-08']);
      const { campaignId: everyDay } = await campaign(stations.lusaka, ads.brandB);
      expect((await slotsOf(everyDay, '2026-10-05T05:00:00Z', '2026-10-06T05:00:00Z')).map((slot) => slot.localDate)).toEqual(['2026-10-05']);
      await campaign(stations.lusaka, ads.brandB);
    });
  });

  describe('which air-time reminders are due', () => {
    // Brand A's slot: Monday 5 October 07:00 in Lusaka, 05:00 UTC. Viewer A follows Brand A; viewer B follows Brand B.
    it('P5C-NOTIFY-04: with the default 15 minutes, a reminder is due from 04:45 UTC until the slot starts, and only for its followers', async () => {
      expect(await dueForBrandA('2026-10-05T04:44:59Z')).toEqual([]);
      const due = await dueForBrandA('2026-10-05T04:45:00Z');
      expect(due).toEqual([
        expect.objectContaining({
          portal_user_id: people.viewerA,
          local_date: '2026-10-05',
          local_start_time: '07:00',
          local_end_time: '09:00',
          is_today: true,
          station_name: 'Lusaka Client FM',
          ad_title: 'Brand A offer',
          client_name: 'Brand A',
          is_push_on: true,
          is_email_on: false,
        }),
      ]);
      expect(due[0]?.slot_starts_at.toISOString()).toBe('2026-10-05T05:00:00.000Z');
      expect((await dueForBrandA('2026-10-05T04:59:59Z')).map((row) => row.portal_user_id)).toEqual([people.viewerA]);
      // Once the slot has started it is too late: no reminder after the fact.
      expect(await dueForBrandA('2026-10-05T05:00:00Z')).toEqual([]);
    });

    it.each([
      [5, '2026-10-05T04:54:59Z', '2026-10-05T04:55:00Z'],
      [30, '2026-10-05T04:29:59Z', '2026-10-05T04:30:00Z'],
    ])('P5C-NOTIFY-04: with %i minutes chosen, nothing is due at %s and the reminder is due at %s', async (leadMinutes, tooEarly, due) => {
      await withChanges([['INSERT INTO app.client_viewer_notification_settings (portal_user_id, lead_minutes) VALUES ($1, $2)', [people.viewerA, leadMinutes]]], async () => {
        expect(await dueForBrandA(tooEarly)).toEqual([]);
        expect((await dueForBrandA(due)).map((row) => row.portal_user_id)).toEqual([people.viewerA]);
      });
    });

    it.each([
      ['the advert is muted', 'INSERT INTO app.client_viewer_muted_ads (portal_user_id, station_id, ad_id) VALUES ($1, $2, $3)', [people.viewerA, stations.lusaka, ads.brandA]],
      ['push and email are both off', 'INSERT INTO app.client_viewer_notification_settings (portal_user_id, is_push_on, is_email_on) VALUES ($1, false, false)', [people.viewerA]],
      ['the campaign is paused', "UPDATE app.campaigns SET status = 'PAUSED' WHERE ad_id = $1", [ads.brandA]],
      ['the advert is archived', 'UPDATE app.ads SET archived_at = now() WHERE id = $1', [ads.brandA]],
      ['the station is suspended', "UPDATE app.stations SET status = 'SUSPENDED' WHERE id = $1", [stations.lusaka]],
      ['the person is disabled', "UPDATE app.portal_users SET status = 'DISABLED' WHERE id = $1", [people.viewerA]],
      ['the person no longer follows the client', 'DELETE FROM app.client_viewers WHERE portal_user_id = $1 AND station_id = $2', [people.viewerA, stations.lusaka]],
    ])('P5C-NOTIFY-04: no reminder when %s', async (_what, sql, parameters) => {
      await withChanges([[sql, parameters]], async () => {
        expect(await dueForBrandA('2026-10-05T04:50:00Z')).toEqual([]);
      });
    });

    it('P5C-NOTIFY-04: with push off and email on, the reminder goes by email', async () => {
      await withChanges([['INSERT INTO app.client_viewer_notification_settings (portal_user_id, is_push_on, is_email_on) VALUES ($1, false, true)', [people.viewerA]]], async () => {
        expect(await dueForBrandA('2026-10-05T04:50:00Z')).toEqual([expect.objectContaining({ portal_user_id: people.viewerA, is_push_on: false, is_email_on: true })]);
      });
    });

    it('P5C-NOTIFY-04: a suspended station sends nobody a reminder, even its own followers', async () => {
      const due = await setupClient.query('SELECT portal_user_id FROM app.list_due_air_time_reminders($1::timestamptz) WHERE station_id = $2', ['2026-10-05T04:50:00Z', stations.suspended]);
      expect(due.rows).toEqual([]);
    });

    it('P5C-NOTIFY-04: a reminder is claimed once: the second claim of the same slot is refused, and the slot is no longer due', async () => {
      const [due] = await dueForBrandA('2026-10-05T04:50:00Z');
      await withChanges([], async () => {
        const claim = async () =>
          (await setupClient.query('SELECT app.claim_air_time_reminder($1, $2, $3) AS is_claimed', [people.viewerA, due?.campaign_time_window_id, due?.slot_starts_at])).rows[0]
            .is_claimed as boolean;
        expect(await claim()).toBe(true);
        expect(await claim()).toBe(false);
        expect(await dueForBrandA('2026-10-05T04:51:00Z')).toEqual([]);
        // The next day's slot is a slot of its own.
        expect((await dueForBrandA('2026-10-06T04:50:00Z')).map((row) => row.portal_user_id)).toEqual([people.viewerA]);
      });
    });
  });

  describe("a person's own settings and devices", () => {
    it("P5C-NOTIFY-01: muting keeps only adverts the person may view: another client's advert is ignored", async () => {
      const saved = await asLookupApi(apiClient, { userId: people.viewerA }, async (client) => {
        const outcome = (
          await client.query('SELECT app.save_client_viewer_notification_settings(true, false, 5::smallint, $1::jsonb) AS outcome', [
            JSON.stringify([
              { stationId: stations.lusaka, adId: ads.brandA },
              { stationId: stations.lusaka, adId: ads.brandB },
              { stationId: stations.london, adId: ads.brandA },
            ]),
          ])
        ).rows[0].outcome as string;
        return { outcome, settings: (await client.query('SELECT * FROM app.read_client_viewer_notification_settings()')).rows[0] };
      });
      expect(saved).toEqual({ outcome: 'SAVED', settings: { is_push_on: true, is_email_on: false, lead_minutes: 5, muted_ads: [{ stationId: stations.lusaka, adId: ads.brandA }] } });
    });

    it('P5C-NOTIFY-01, P5C-DATABASE-05: someone who follows no client cannot save settings or a device', async () => {
      const outcomes = await asLookupApi(apiClient, { userId: people.stranger }, async (client) => ({
        settings: (await client.query(`SELECT app.save_client_viewer_notification_settings(true, true, 15::smallint, '[]'::jsonb) AS outcome`)).rows[0].outcome,
        device: (await client.query('SELECT app.save_web_push_subscription($1, $2, $3, $4) AS outcome', ['https://push.example.test/stranger', endpointHash('stranger'), 'k'.repeat(87), 'a'.repeat(22)])).rows[0].outcome,
      }));
      expect(outcomes).toEqual({ settings: 'NOT_A_CLIENT_VIEWER', device: 'NOT_A_CLIENT_VIEWER' });
    });

    it('P5C-NOTIFY-03: a person keeps at most 10 devices, the newest; another person can neither list nor delete them', async () => {
      // Each device is turned on in a request of its own, as on real phones (the person's rows go when the test ends).
      for (let device = 1; device <= 11; device += 1) {
        await asPersonCommitted(people.viewerA, 'SELECT app.save_web_push_subscription($1, $2, $3, $4)', [
          `https://push.example.test/device-${device}`,
          endpointHash(`device-${device}`),
          'k'.repeat(87),
          'a'.repeat(22),
        ]);
      }
      const devicesOf = async (person: string) =>
        asLookupApi(apiClient, { userId: person }, async (client) =>
          (await client.query('SELECT endpoint FROM app.list_own_web_push_subscriptions()')).rows.map((row: { endpoint: string }) => row.endpoint),
        );
      const own = await devicesOf(people.viewerA);
      expect(own).toHaveLength(10);
      expect(own).not.toContain('https://push.example.test/device-1');
      expect(own).toContain('https://push.example.test/device-11');
      expect(await devicesOf(people.viewerB)).toEqual([]);
      const deleteAs = async (person: string) =>
        asLookupApi(apiClient, { userId: person }, async (client) =>
          (await client.query('SELECT app.delete_own_web_push_subscription($1) AS outcome', [endpointHash('device-11')])).rows[0].outcome as string,
        );
      expect(await deleteAs(people.viewerB)).toBe('NOT_FOUND');
      expect(await deleteAs(people.viewerA)).toBe('DELETED');
    });
  });

  describe("the client's reads", () => {
    it("P5C-DATABASE-03, P5C-DATABASE-04: a follower sees their client's advert, never another client's at the same station, and nothing at a suspended station", async () => {
      const seen = async (person: string, stationId: string) =>
        asLookupApi(apiClient, { userId: person }, async (client) =>
          (await client.query('SELECT ad_id FROM app.list_client_viewer_ads($1)', [stationId])).rows.map((row: { ad_id: string }) => row.ad_id),
        );
      expect(await seen(people.viewerA, stations.lusaka)).toEqual([ads.brandA]);
      expect(await seen(people.viewerB, stations.lusaka)).toEqual([ads.brandB]);
      expect(await seen(people.stranger, stations.lusaka)).toEqual([]);
      expect(await seen(people.viewerSuspended, stations.suspended)).toEqual([]);
      const read = async (person: string, adId: string) =>
        asLookupApi(apiClient, { userId: person }, async (client) => (await client.query('SELECT ad_id FROM app.read_client_viewer_ad($1, $2)', [stations.lusaka, adId])).rows.length);
      expect(await read(people.viewerA, ads.brandA)).toBe(1);
      expect(await read(people.viewerA, ads.brandB)).toBe(0);
    });

    it('P5C-DATABASE-02, P5C-ACCESS-05: each station stays separate: the London station lists only its own advert for the same person', async () => {
      const accesses = await asLookupApi(apiClient, { userId: people.viewerA }, async (client) => ({
        london: (await client.query('SELECT ad_id FROM app.list_client_viewer_ads($1)', [stations.london])).rows.map((row: { ad_id: string }) => row.ad_id),
        stations: (await client.query('SELECT station_id FROM app.list_client_viewer_accesses() ORDER BY station_name')).rows.map((row: { station_id: string }) => row.station_id),
      }));
      expect(accesses).toEqual({ london: [ads.brandLondon], stations: [stations.london, stations.lusaka] });
    });
  });
});

function endpointHash(name: string): Buffer {
  return createHash('sha256').update(name).digest();
}
