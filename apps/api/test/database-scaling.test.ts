import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asLookupApi, databaseSetupClient, lookupApiClient } from './support/database-clients.js';

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
});
