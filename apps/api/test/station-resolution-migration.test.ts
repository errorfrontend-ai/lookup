import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseRoles } from '../scripts/create-database-roles.js';
import { loadDatabaseSetupConfig } from '../scripts/database-setup-config.js';
import { runMigrations } from '../scripts/run-migrations.js';
import { ALL_MIGRATIONS } from '../src/infrastructure/database/migrations/all-migrations.js';

/**
 * The phase 4 migration, 1791600000000-StationResolution (P4 design §4, §4.7), run up and down as the migration
 * script runs it (database:migrate and database:revert-latest), in a database of its own made for this test and
 * dropped after it, so the shared database is never reverted: rows finished under Step 3 get the resolution Step
 * 3 decided before the strict check is added (P4-D33), and the down step gives back Step 3's schema exactly.
 * Migrations released after it are reverted before it and applied again after it, as revert-latest would.
 */
const MIGRATION_NAMES = ALL_MIGRATIONS.map((migration) => new migration().name);
const LATER_MIGRATION_NAMES = MIGRATION_NAMES.slice(MIGRATION_NAMES.indexOf('StationResolution1791600000000') + 1);

describe('the StationResolution migration, up and down', () => {
  const { setupUrl, rolePasswords } = loadDatabaseSetupConfig();
  const scratchDatabaseName = `lookup_migration_test_${randomBytes(4).toString('hex')}`;
  const scratchUrl = new URL(setupUrl);
  scratchUrl.pathname = `/${scratchDatabaseName}`;
  let scratchClient: pg.Client;
  const ids = {
    station: randomUUID(), client: randomUUID(), card: randomUUID(), ad: randomUUID(), campaign: randomUUID(), install: randomUUID(),
    match: randomUUID(), matchDefault: randomUUID(), noMatch: randomUUID(), busy: randomUUID(),
  };

  const onServer = async (sql: string) => {
    const serverClient = new pg.Client({ connectionString: setupUrl, application_name: 'lookup-tests-migration' });
    await serverClient.connect();
    try {
      await serverClient.query(sql);
    } finally {
      await serverClient.end();
    }
  };
  const rows = async <Row>(sql: string, parameters: unknown[] = []) => (await scratchClient.query(sql, parameters)).rows as Row[];
  /** database:revert-latest, once for each later migration and once more for StationResolution itself. */
  const revertThroughStationResolution = async () => {
    for (let reverted = 0; reverted <= LATER_MIGRATION_NAMES.length; reverted += 1) await runMigrations(scratchUrl.toString(), { revertLatest: true });
  };

  beforeAll(async () => {
    await onServer(`CREATE DATABASE ${scratchDatabaseName}`);
    await createDatabaseRoles(scratchUrl.toString(), rolePasswords);
    await runMigrations(scratchUrl.toString());
    // database:revert-latest: back to the Step 3 schema, where the rows below are made.
    await revertThroughStationResolution();
    scratchClient = new pg.Client({ connectionString: scratchUrl.toString(), application_name: 'lookup-tests-migration' });
    await scratchClient.connect();
  }, 240_000);
  afterAll(async () => {
    await scratchClient?.end();
    await onServer(`DROP DATABASE IF EXISTS ${scratchDatabaseName} WITH (FORCE)`);
  }, 60_000);

  it('P4-D33: rows finished under Step 3 get the resolution it decided, then the strict check holds; status times and cities are filled without moving updated_at', async () => {
    expect((await rows<{ name: string }>('SELECT name FROM app.migrations ORDER BY id DESC LIMIT 1'))[0]?.name).toBe('EngineHookup1791500000000');
    await scratchClient.query(`INSERT INTO app.stations (id, name, frequency_label, status, city, updated_at) VALUES ($1, 'Station A', '98.1 FM', 'ACTIVE', '   ', '2026-01-01T00:00:00Z')`, [ids.station]);
    await scratchClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, 'Brand A')`, [ids.client, ids.station]);
    await scratchClient.query(`INSERT INTO app.action_cards (id, station_id, client_id, schema_version, content) VALUES ($1, $2, $3, 1, '{"schema_version":1}')`, [ids.card, ids.station, ids.client]);
    await scratchClient.query(`INSERT INTO app.ads (id, station_id, client_id, title) VALUES ($1, $2, $3, 'Ad')`, [ids.ad, ids.station, ids.client]);
    await scratchClient.query(
      `INSERT INTO app.campaigns (id, station_id, ad_id, action_card_id, name, status, active_period, updated_at)
       VALUES ($1, $2, $3, $4, 'Campaign', 'PAUSED', tstzrange('2026-01-01T00:00:00Z', '2026-12-01T00:00:00Z'), '2026-02-01T00:00:00Z')`,
      [ids.campaign, ids.station, ids.ad, ids.card],
    );
    await scratchClient.query(`INSERT INTO app.listener_installs (id, install_id_hash, platform, app_version) VALUES ($1, $2, 'ANDROID', '1.0.0')`, [ids.install, randomBytes(32)]);
    for (const [id, outcome, stationId] of [
      [ids.match, 'MATCH', ids.station],
      [ids.matchDefault, 'MATCH_DEFAULT', ids.station],
      [ids.noMatch, 'NO_MATCH', null],
      [ids.busy, 'BUSY', null],
    ]) {
      await scratchClient.query(
        `INSERT INTO app.recognition_events (id, listener_install_id, idempotency_key, request_id, captured_at, received_at, outcome, station_id, clock_skew_milliseconds)
         VALUES ($1, $2, $3, 'test', now(), now(), $4, $5, 1500)`,
        [id, ids.install, randomUUID(), outcome, stationId],
      );
    }

    // database:migrate
    expect(await runMigrations(scratchUrl.toString())).toEqual(['StationResolution1791600000000', ...LATER_MIGRATION_NAMES]);
    const resolutions = await rows<{ id: string; resolution: string | null }>('SELECT id, resolution FROM app.recognition_events');
    expect(Object.fromEntries(resolutions.map((row) => [row.id, row.resolution]))).toEqual({
      [ids.match]: 'SCHEDULE_UNIQUE',
      [ids.matchDefault]: 'SINGLE_OWNER',
      [ids.noMatch]: null,
      [ids.busy]: null,
    });
    await expect(
      scratchClient.query(
        `INSERT INTO app.recognition_events (id, listener_install_id, idempotency_key, request_id, captured_at, received_at, outcome, station_id)
         VALUES ($1, $2, $3, 'test', now(), now(), 'MATCH', $4)`,
        [randomUUID(), ids.install, randomUUID(), ids.station],
      ),
    ).rejects.toThrow(/recognition_events_resolution_outcome_check/);
    expect(await rows('SELECT status_changed_at, updated_at FROM app.campaigns WHERE id = $1', [ids.campaign])).toEqual([
      { status_changed_at: new Date('2026-02-01T00:00:00Z'), updated_at: new Date('2026-02-01T00:00:00Z') },
    ]);
    expect(await rows('SELECT city, updated_at FROM app.stations WHERE id = $1', [ids.station])).toEqual([{ city: null, updated_at: new Date('2026-01-01T00:00:00Z') }]);
    expect(await rows(`SELECT pg_typeof(clock_skew_milliseconds)::text AS type, clock_skew_milliseconds::text AS skew FROM app.recognition_events WHERE id = $1`, [ids.match])).toEqual([
      { type: 'bigint', skew: '1500' },
    ]);
    // A skew no integer can hold, for the down step to meet.
    await scratchClient.query('UPDATE app.recognition_events SET clock_skew_milliseconds = 2592000000 WHERE id = $1', [ids.noMatch]);
  }, 240_000);

  it('the down step gives back Step 3: its functions and their grants, the integer skew, the table-wide read, and no phase 4 table, column or check; up again works', async () => {
    // database:revert-latest
    await revertThroughStationResolution();
    const callable = async (signature: string) =>
      (await rows<{ is_callable: boolean | null }>(
        `SELECT CASE WHEN to_regprocedure($1) IS NULL THEN NULL ELSE has_function_privilege('lookup_api', to_regprocedure($1), 'EXECUTE') END AS is_callable`,
        [signature],
      ))[0]?.is_callable;
    for (const signature of [
      'recognition.claim_recognition(uuid, uuid, uuid, text, timestamptz, timestamptz, integer, timestamptz, boolean, integer)',
      'recognition.finish_recognition(uuid, timestamptz, integer, text, text, integer, uuid, uuid, uuid, integer, real, integer, integer, smallint)',
      'recognition.find_stations_for_audio(integer, timestamptz)',
      'recognition.describe_recognition(uuid, timestamptz, uuid)',
      'app.create_recognition_event_partitions(integer)',
    ]) {
      expect(await callable(signature), signature).toBe(true);
    }
    expect(await callable('app.name_recognition_event_partition_indexes(text)')).toBe(false);
    for (const signature of [
      'recognition.find_station_candidates(integer, timestamptz)',
      'recognition.record_engagement(uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, bigint, timestamptz, text, integer)',
      'app.create_listener_traffic_partitions(integer)',
      'app.is_time_window_open_with_grace(smallint[], time, time, timestamp, interval)',
      'app.set_campaign_status_changed_at()',
    ]) {
      expect(await callable(signature), signature).toBeNull();
    }
    const tables = await rows<{ table_name: string }>(
      `SELECT relname AS table_name FROM pg_class WHERE relnamespace = 'app'::regnamespace
          AND relname IN ('recognition_candidates', 'engagement_events', 'engagement_deduplication_keys', 'campaign_counters', 'recognition_reports')`,
    );
    expect(tables).toEqual([]);
    const columns = await rows<{ column_name: string; data_type: string }>(
      `SELECT table_name || '.' || column_name AS column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'app' AND ((table_name = 'recognition_events' AND column_name IN ('resolution', 'clock_skew_milliseconds'))
                                        OR (table_name = 'campaigns' AND column_name = 'status_changed_at'))`,
    );
    expect(columns).toEqual([{ column_name: 'recognition_events.clock_skew_milliseconds', data_type: 'integer' }]);
    const checks = await rows<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname IN ('recognition_events_resolution_check', 'recognition_events_resolution_outcome_check',
                                                         'campaigns_time_window_grace_period_check', 'stations_city_check')`,
    );
    expect(checks).toEqual([]);
    // The skew no integer can hold becomes unknown again; the others are kept.
    const skews = await rows<{ id: string; skew: number | null }>('SELECT id, clock_skew_milliseconds AS skew FROM app.recognition_events WHERE id = ANY($1)', [[ids.noMatch, ids.match]]);
    expect(Object.fromEntries(skews.map((row) => [row.id, row.skew]))).toEqual({ [ids.noMatch]: null, [ids.match]: 1500 });
    // The API role reads the whole table again, with no column grant left over.
    expect((await rows<{ can_read: boolean }>(`SELECT has_table_privilege('lookup_api', 'app.recognition_events', 'SELECT') AS can_read`))[0]?.can_read).toBe(true);
    const columnGrants = await rows<{ column_name: string }>(
      `SELECT attname AS column_name FROM pg_attribute WHERE attrelid = 'app.recognition_events'::regclass AND coalesce(array_length(attacl, 1), 0) > 0`,
    );
    expect(columnGrants).toEqual([]);
    // Blank cities made NULL stay NULL: nothing told a blank city from none.
    expect(await rows('SELECT city FROM app.stations WHERE id = $1', [ids.station])).toEqual([{ city: null }]);

    // database:migrate, once more.
    expect(await runMigrations(scratchUrl.toString())).toEqual(['StationResolution1791600000000', ...LATER_MIGRATION_NAMES]);
    expect(await callable('recognition.find_station_candidates(integer, timestamptz)')).toBe(true);
  }, 240_000);
});
