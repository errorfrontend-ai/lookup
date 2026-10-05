import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PARTITION_MONTHS_AHEAD, RecognitionEventPartitions } from '../src/infrastructure/database/recognition-event-partitions.js';
import { asLookupApi, databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { createTestApplication } from './support/test-application.js';

/** Recognition events are partitioned by month so the table stays fast as it grows. */
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

  const monthPartitionName = (monthsFromNow: number) => {
    const now = new Date();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsFromNow, 1));
    return `recognition_events_${month.getUTCFullYear()}_${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  it('has a partition for this month and the next three, plus a default', async () => {
    const result = await setupClient.query(
      `SELECT child.relname AS partition_name
         FROM pg_inherits inheritance
         JOIN pg_class parent ON parent.oid = inheritance.inhparent
         JOIN pg_class child ON child.oid = inheritance.inhrelid
        WHERE parent.relname = 'recognition_events'`,
    );
    const partitionNames = result.rows.map((row) => row.partition_name);
    for (const monthsFromNow of [0, 1, 2, 3]) expect(partitionNames).toContain(monthPartitionName(monthsFromNow));
    expect(partitionNames).toContain('recognition_events_default');
  });

  it('the scheduler can top up future months, and running it twice creates nothing new', async () => {
    await asLookupApi(apiClient, {}, async (client) => {
      const firstRun = await client.query('SELECT app.create_recognition_event_partitions(5) AS created_count');
      expect(firstRun.rows[0].created_count).toBeGreaterThanOrEqual(0);
      const secondRun = await client.query('SELECT app.create_recognition_event_partitions(5) AS created_count');
      expect(secondRun.rows[0].created_count).toBe(0);
    });
  });

  it('refuses an unreasonable number of months', async () => {
    await expect(
      asLookupApi(apiClient, {}, (client) => client.query('SELECT app.create_recognition_event_partitions(1000)')),
    ).rejects.toThrow(/months_ahead must be between 0 and 24/);
  });

  it('the API role cannot reach a partition directly, around the parent table and its policies', async () => {
    await expect(
      asLookupApi(apiClient, {}, (client) => client.query(`SELECT 1 FROM app.${monthPartitionName(0)} LIMIT 1`)),
    ).rejects.toThrow(/permission denied/);
  });

  it('S1-SCALING-04: the API recreates a missing future month when it starts', async () => {
    const furthestMonth = monthPartitionName(PARTITION_MONTHS_AHEAD);
    const rowCount = await setupClient.query(`SELECT count(*)::int AS row_count FROM app.${furthestMonth}`);
    expect(rowCount.rows[0].row_count, 'the furthest month must be empty to drop it safely').toBe(0);
    await setupClient.query(`DROP TABLE app.${furthestMonth}`);

    const testApplication = await createTestApplication();
    await testApplication.close();

    const recreated = await setupClient.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`app.${furthestMonth}`]);
    expect(recreated.rows[0].exists).toBe(true);
  });

  it('S1-SCALING-04: the top-up runs again every day, and a failed run is logged rather than thrown', async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn().mockResolvedValueOnce([{ created_count: 0 }]).mockRejectedValueOnce(new Error('database restarting'));
      const logger = { setContext: vi.fn(), info: vi.fn(), error: vi.fn() };
      const partitions = new RecognitionEventPartitions({ query } as unknown as DataSource, logger as never);

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
});
