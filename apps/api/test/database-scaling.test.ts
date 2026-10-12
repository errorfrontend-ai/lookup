import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ListenerTrafficPartitions, PARTITION_MONTHS_AHEAD } from '../src/infrastructure/database/listener-traffic-partitions.js';
import { asLookupApi, databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { createTestApplication } from './support/test-application.js';

/** The tables that grow with listener traffic, each partitioned by month on its arrival column. */
const LISTENER_TRAFFIC_TABLES = ['recognition_events', 'recognition_candidates', 'engagement_events'];

/** Recognitions, their candidates and button taps are partitioned by month so the tables stay fast as they grow. */
describe('recognition event partitions', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await setupClient.connect();
    await apiClient.connect();
  });
  afterAll(async () => {
    await apiClient.end();
    await setupClient.end();
  });

  const monthPartitionName = (monthsFromNow: number, parentTable = 'recognition_events') => {
    const now = new Date();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsFromNow, 1));
    return `${parentTable}_${month.getUTCFullYear()}_${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const partitionsOf = async (parentTable: string) =>
    (
      await setupClient.query(
        `SELECT child.relname AS partition_name
           FROM pg_inherits inheritance
           JOIN pg_class parent ON parent.oid = inheritance.inhparent
           JOIN pg_class child ON child.oid = inheritance.inhrelid
          WHERE parent.relname = $1 AND parent.relnamespace = 'app'::regnamespace`,
        [parentTable],
      )
    ).rows.map((row) => row.partition_name as string);

  it('has a partition for this month and the next three, plus a default', async () => {
    for (const parentTable of LISTENER_TRAFFIC_TABLES) {
      const partitionNames = await partitionsOf(parentTable);
      for (const monthsFromNow of [0, 1, 2, 3]) expect(partitionNames).toContain(monthPartitionName(monthsFromNow, parentTable));
      expect(partitionNames).toContain(`${parentTable}_default`);
    }
  });

  it('P4-DATABASE-03: candidates and taps are range-partitioned by month on their arrival columns: the recognition’s receipt, and the tap’s own', async () => {
    const keys = await setupClient.query(
      `SELECT partrelid::regclass::text AS table_name, pg_get_partkeydef(partrelid) AS partition_key FROM pg_partitioned_table
        WHERE partrelid IN ('app.recognition_events'::regclass, 'app.recognition_candidates'::regclass, 'app.engagement_events'::regclass) ORDER BY 1`,
    );
    expect(keys.rows).toEqual([
      { table_name: 'app.engagement_events', partition_key: 'RANGE (received_at)' },
      { table_name: 'app.recognition_candidates', partition_key: 'RANGE (recognition_received_at)' },
      { table_name: 'app.recognition_events', partition_key: 'RANGE (received_at)' },
    ]);
    // A month's bounds are the same in all three, so a month of candidates goes with its month of recognitions.
    const bounds = await setupClient.query(
      `SELECT child.relname AS partition_name, pg_get_expr(child.relpartbound, child.oid) AS bound FROM pg_class child
        WHERE child.relname = ANY($1)`,
      [LISTENER_TRAFFIC_TABLES.map((parentTable) => monthPartitionName(1, parentTable))],
    );
    expect(new Set(bounds.rows.map((row) => row.bound)).size).toBe(1);
    expect(bounds.rows).toHaveLength(3);
  });

  it('the scheduler can top up future months, and running it twice creates nothing new', async () => {
    await asLookupApi(apiClient, {}, async (client) => {
      const firstRun = await client.query('SELECT app.create_listener_traffic_partitions(5) AS created_count');
      expect(firstRun.rows[0].created_count).toBeGreaterThanOrEqual(0);
      const secondRun = await client.query('SELECT app.create_listener_traffic_partitions(5) AS created_count');
      expect(secondRun.rows[0].created_count).toBe(0);
      for (const parentTable of LISTENER_TRAFFIC_TABLES) {
        const exists = await client.query('SELECT to_regclass($1) IS NOT NULL AS exists', [`app.${monthPartitionName(5, parentTable)}`]);
        expect(exists.rows[0].exists, parentTable).toBe(true);
      }
    });
  });

  it('refuses an unreasonable number of months', async () => {
    await expect(
      asLookupApi(apiClient, {}, (client) => client.query('SELECT app.create_listener_traffic_partitions(1000)')),
    ).rejects.toThrow(/months_ahead must be between 0 and 24/);
  });

  it('the API role cannot reach a partition directly, around the parent table and its policies', async () => {
    for (const parentTable of LISTENER_TRAFFIC_TABLES) {
      for (const partitionName of [monthPartitionName(0, parentTable), `${parentTable}_default`]) {
        await expect(
          asLookupApi(apiClient, {}, (client) => client.query(`SELECT 1 FROM app.${partitionName} LIMIT 1`)),
          partitionName,
        ).rejects.toThrow(/permission denied/);
      }
    }
  });

  it('S1-SCALING-04: the API recreates a missing future month when it starts', async () => {
    const furthest = (parentTable: string) => monthPartitionName(PARTITION_MONTHS_AHEAD, parentTable);
    for (const parentTable of LISTENER_TRAFFIC_TABLES) {
      const rowCount = await setupClient.query(`SELECT count(*)::int AS row_count FROM app.${furthest(parentTable)}`);
      expect(rowCount.rows[0].row_count, 'the furthest month must be empty to drop it safely').toBe(0);
    }
    await setupClient.query(`DROP TABLE app.${furthest('recognition_candidates')}`);
    await setupClient.query(`DROP TABLE app.${furthest('engagement_events')}`);
    // Candidates hold a foreign key on each month of recognitions, so that month is detached before it is dropped.
    await setupClient.query(`ALTER TABLE app.recognition_events DETACH PARTITION app.${furthest('recognition_events')}`);
    await setupClient.query(`DROP TABLE app.${furthest('recognition_events')}`);

    const testApplication = await createTestApplication();
    await testApplication.close();

    for (const parentTable of LISTENER_TRAFFIC_TABLES) {
      const recreated = await setupClient.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`app.${furthest(parentTable)}`]);
      expect(recreated.rows[0].exists, parentTable).toBe(true);
    }
  });

  it('S1-SCALING-04: the top-up runs again every day, and a failed run is logged rather than thrown', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn().mockResolvedValueOnce([{ created_count: 0 }]).mockRejectedValueOnce(new Error('database restarting'));
      const logger = { setContext: vi.fn(), info: vi.fn(), error: vi.fn() };
      const partitions = new ListenerTrafficPartitions({ query } as unknown as DataSource, logger as never);

      await partitions.onApplicationBootstrap();
      expect(query).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(query).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining('will retry'));

      partitions.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('S1-SCALING-05: an old month can be detached whole without touching the other months', async () => {
    const thisMonth = monthPartitionName(0);
    const nextMonth = monthPartitionName(1);
    const installId = randomUUID();
    await setupClient.query('BEGIN');
    try {
      await setupClient.query(`INSERT INTO app.listener_installs (id, install_id_hash, platform, app_version) VALUES ($1, $2, 'ANDROID', 'test')`, [
        installId,
        Buffer.from(randomUUID()),
      ]);
      const insertEvent = (receivedAt: Date) =>
        setupClient.query(
          `INSERT INTO app.recognition_events (id, listener_install_id, idempotency_key, request_id, captured_at, received_at, outcome)
           VALUES ($1, $2, $3, 'test', $4, $4, 'NO_MATCH')`,
          [randomUUID(), installId, randomUUID(), receivedAt],
        );
      const now = new Date();
      await insertEvent(now);
      await insertEvent(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15)));

      // In the order of ADR-003: the month's candidates refer to its recognitions (whenever any recognition of the
      // month weighed a station), so their month goes first and drops its foreign key.
      const candidatesThisMonth = monthPartitionName(0, 'recognition_candidates');
      await setupClient.query(`ALTER TABLE app.recognition_candidates DETACH PARTITION app.${candidatesThisMonth}`);
      await setupClient.query(`ALTER TABLE app.${candidatesThisMonth} DROP CONSTRAINT recognition_candidates_recognition_foreign_key`);
      await setupClient.query(`ALTER TABLE app.recognition_events DETACH PARTITION app.${thisMonth}`);

      const remaining = await setupClient.query(`SELECT count(*)::int AS row_count FROM app.recognition_events WHERE listener_install_id = $1`, [installId]);
      expect(remaining.rows[0].row_count).toBe(1);
      const inNextMonth = await setupClient.query(`SELECT count(*)::int AS row_count FROM app.${nextMonth} WHERE listener_install_id = $1`, [installId]);
      expect(inNextMonth.rows[0].row_count).toBe(1);
    } finally {
      await setupClient.query('ROLLBACK');
    }
  });

  it('S1-SCALING-06: an idempotency key can be used once per install, whatever the month', async () => {
    const installId = randomUUID();
    const idempotencyKey = randomUUID();
    await setupClient.query('BEGIN');
    try {
      await setupClient.query(`INSERT INTO app.listener_installs (id, install_id_hash, platform, app_version) VALUES ($1, $2, 'ANDROID', 'test')`, [
        installId,
        Buffer.from(randomUUID()),
      ]);
      const insertKey = (receivedAt: string) =>
        setupClient.query(
          `INSERT INTO app.recognition_idempotency_keys (listener_install_id, idempotency_key, recognition_event_id, recognition_received_at)
           VALUES ($1, $2, $3, $4)`,
          [installId, idempotencyKey, randomUUID(), receivedAt],
        );
      await insertKey('2026-10-31T23:59:00Z');
      await expect(insertKey('2026-11-01T00:01:00Z')).rejects.toThrow(/recognition_idempotency_keys_primary_key/);
    } finally {
      await setupClient.query('ROLLBACK');
    }
  });

  it('P4-DATABASE-05, ALL-SCALING-01 (A8): a month of recognitions detaches after its month of candidates, in the order of ADR-003, while a tap of the next month that names one of them stays', async () => {
    const thisMonth = (parentTable: string) => monthPartitionName(0, parentTable);
    const now = new Date();
    const nextMonthMoment = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2));
    const ids = { station: randomUUID(), client: randomUUID(), card: randomUUID(), ad: randomUUID(), campaign: randomUUID(), install: randomUUID(), recognition: randomUUID(), tap: randomUUID() };
    await setupClient.query('BEGIN');
    try {
      await setupClient.query(`INSERT INTO app.stations (id, name, frequency_label, status) VALUES ($1, $2, '98.1 FM', 'ACTIVE')`, [ids.station, `Detach test ${ids.station.slice(0, 8)}`]);
      await setupClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, 'Brand A')`, [ids.client, ids.station]);
      await setupClient.query(`INSERT INTO app.action_cards (id, station_id, client_id, schema_version, content) VALUES ($1, $2, $3, 1, '{"schema_version":1}')`, [ids.card, ids.station, ids.client]);
      await setupClient.query(`INSERT INTO app.ads (id, station_id, client_id, title) VALUES ($1, $2, $3, 'Ad')`, [ids.ad, ids.station, ids.client]);
      await setupClient.query(
        `INSERT INTO app.campaigns (id, station_id, ad_id, action_card_id, name, status, active_period) VALUES ($1, $2, $3, $4, 'Campaign', 'ACTIVE', tstzrange(now() - interval '1 day', now() + interval '60 days'))`,
        [ids.campaign, ids.station, ids.ad, ids.card],
      );
      await setupClient.query(`INSERT INTO app.listener_installs (id, install_id_hash, platform, app_version) VALUES ($1, $2, 'ANDROID', 'test')`, [ids.install, Buffer.from(randomUUID())]);
      // A recognition answered this month with a chooser, its candidate, and a tap on it that arrives next month.
      await setupClient.query(
        `INSERT INTO app.recognition_events (id, listener_install_id, idempotency_key, request_id, captured_at, received_at, outcome, resolution)
         VALUES ($1, $2, $3, 'test', $4, $4, 'CHOOSE_STATION', 'UNRESOLVED')`,
        [ids.recognition, ids.install, randomUUID(), now],
      );
      await setupClient.query(
        `INSERT INTO app.recognition_candidates (recognition_id, recognition_received_at, station_id, campaign_id, action_card_id, card_kind, is_in_window, display_position)
         VALUES ($1, $2, $3, $4, $5, 'CAMPAIGN', true, 1)`,
        [ids.recognition, now, ids.station, ids.campaign, ids.card],
      );
      await setupClient.query(
        `INSERT INTO app.engagement_events (id, received_at, recognition_id, recognition_received_at, station_id, campaign_id, action_card_id, card_kind,
                                            action_id, action_type, occurred_at, client_occurred_at, clock_skew_milliseconds, is_counted, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'CAMPAIGN', $8, 'CALL', $2, $2, 0, false, 'test')`,
        [ids.tap, nextMonthMoment, ids.recognition, now, ids.station, ids.campaign, ids.card, randomUUID()],
      );
      await setupClient.query(
        `INSERT INTO app.engagement_deduplication_keys (recognition_id, action_id, recognition_received_at, engagement_event_id, engagement_received_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [ids.recognition, randomUUID(), now, ids.tap, nextMonthMoment],
      );
      const inTapMonth = await setupClient.query(`SELECT count(*)::integer AS taps FROM app.${monthPartitionName(1, 'engagement_events')} WHERE id = $1`, [ids.tap]);
      expect(inTapMonth.rows[0].taps).toBe(1);

      // The recognitions first: refused, because their candidates still refer to them.
      await setupClient.query('SAVEPOINT recognitions_first');
      await expect(setupClient.query(`ALTER TABLE app.recognition_events DETACH PARTITION app.${thisMonth('recognition_events')}`)).rejects.toThrow(/violates foreign key constraint/);
      await setupClient.query('ROLLBACK TO SAVEPOINT recognitions_first');

      // The runbook: detach the candidates' month, drop its foreign key (or archive and drop the table), then the recognitions' month.
      await setupClient.query(`ALTER TABLE app.recognition_candidates DETACH PARTITION app.${thisMonth('recognition_candidates')}`);
      await setupClient.query(`ALTER TABLE app.${thisMonth('recognition_candidates')} DROP CONSTRAINT recognition_candidates_recognition_foreign_key`);
      await setupClient.query(`ALTER TABLE app.recognition_events DETACH PARTITION app.${thisMonth('recognition_events')}`);
      // ... and in the same step, the tap keys of that month of recognitions.
      const deletedKeys = await setupClient.query(
        `DELETE FROM app.engagement_deduplication_keys WHERE recognition_received_at >= date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
           AND recognition_received_at < (date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' AND recognition_id = $2`,
        [now, ids.recognition],
      );
      expect(deletedKeys.rowCount).toBe(1);

      expect((await setupClient.query('SELECT count(*)::integer AS found FROM app.recognition_events WHERE id = $1', [ids.recognition])).rows[0].found).toBe(0);
      expect((await setupClient.query('SELECT count(*)::integer AS found FROM app.recognition_candidates WHERE recognition_id = $1', [ids.recognition])).rows[0].found).toBe(0);
      const tap = await setupClient.query('SELECT recognition_id FROM app.engagement_events WHERE id = $1', [ids.tap]);
      expect(tap.rows).toEqual([{ recognition_id: ids.recognition }]);
    } finally {
      await setupClient.query('ROLLBACK');
    }
  });
});
