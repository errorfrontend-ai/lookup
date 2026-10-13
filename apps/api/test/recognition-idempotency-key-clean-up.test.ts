import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import {
  IDEMPOTENCY_KEY_CALLS_PER_RUN,
  IDEMPOTENCY_KEYS_PER_CALL,
  RecognitionIdempotencyKeyCleanUp,
} from '../src/features/recognition/recognition-idempotency-key-clean-up.js';
import { StationScopedTransaction } from '../src/infrastructure/database/station-scoped-transaction.js';
import { databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { waitForLogWrites } from './support/log-capture.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * The idempotency key clean-up (P4 design §5.12; P4-IDEMPOTENCY-19): keys a phone can no longer retry (older than 48
 * hours; a capture older than 24 hours is refused before any claim) are deleted daily, in batches, through runJob.
 * The keys are written straight into the table here, with the ages each case needs.
 */
describe('the recognition idempotency key clean-up', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  const installRows: string[] = [];

  /** An install row of its own, so this file's keys never mix with another file's. */
  async function newInstallRow(): Promise<string> {
    const row = await setupClient.query(
      `INSERT INTO app.listener_installs (install_id_hash, platform, app_version, last_seen_at) VALUES ($1, 'ANDROID', '1.0.0', now()) RETURNING id`,
      [randomBytes(32)],
    );
    installRows.push(row.rows[0].id as string);
    return row.rows[0].id as string;
  }

  /** `count` keys of the install made `hoursAgo` hours ago. */
  async function addKeys(installRowId: string, count: number, hoursAgo: number): Promise<void> {
    await setupClient.query(
      `INSERT INTO app.recognition_idempotency_keys (listener_install_id, idempotency_key, recognition_event_id, recognition_received_at, created_at)
       SELECT $1, gen_random_uuid(), gen_random_uuid(), now() - make_interval(hours => $3), now() - make_interval(hours => $3)
         FROM generate_series(1, $2)`,
      [installRowId, count, hoursAgo],
    );
  }

  const keysLeft = async (installRowId: string) =>
    (
      await setupClient.query(
        `SELECT round(extract(epoch FROM now() - created_at) / 3600)::integer AS hours_ago, count(*)::integer AS keys
           FROM app.recognition_idempotency_keys WHERE listener_install_id = $1 GROUP BY 1 ORDER BY 1`,
        [installRowId],
      )
    ).rows as Array<{ hours_ago: number; keys: number }>;

  beforeAll(async () => {
    // The schedule is off here, as in every other test file; each case runs the job by hand.
    const config = { ...loadAppConfig(), RECOGNITION_IDEMPOTENCY_KEY_CLEAN_UP_INTERVAL_SECONDS: 0 };
    testApplication = await createTestApplication({ overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config) });
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await Promise.all([setupClient.connect(), apiClient.connect()]);
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRows]);
    await Promise.all([setupClient.end(), apiClient.end()]);
    await testApplication.close();
  });

  it('P4-IDEMPOTENCY-19: keys older than 48 hours are deleted and newer ones kept, and the run logs how many went under its own request id', async () => {
    const install = await newInstallRow();
    await addKeys(install, 3, 49);
    await addKeys(install, 2, 72);
    await addKeys(install, 4, 47);
    await addKeys(install, 1, 1);

    const deleted = await testApplication.application.get(RecognitionIdempotencyKeyCleanUp).runOnce();
    expect(deleted).toBeGreaterThanOrEqual(5);
    expect(await keysLeft(install)).toEqual([
      { hours_ago: 1, keys: 1 },
      { hours_ago: 47, keys: 4 },
    ]);
    await waitForLogWrites();
    const runLine = testApplication.logs.find((line) => line.msg === 'deleted expired recognition idempotency keys');
    expect(runLine).toMatchObject({ job: 'recognition-idempotency-key-clean-up', requestId: expect.stringMatching(/^recognition-idempotency-key-clean-up-/), deletedCount: deleted });
  });

  it('deletes in batches of 1,000 until a batch comes back short: 2,500 old keys go in one run', async () => {
    const install = await newInstallRow();
    await addKeys(install, 2_500, 50);
    const batches = vi.spyOn(testApplication.application.get(StationScopedTransaction), 'run');
    try {
      const deleted = await testApplication.application.get(RecognitionIdempotencyKeyCleanUp).runOnce();
      expect(deleted).toBeGreaterThanOrEqual(2_500);
      // One transaction per batch: full batches of 1,000, then the short one that ends the run.
      expect(batches).toHaveBeenCalledTimes(Math.floor(deleted / IDEMPOTENCY_KEYS_PER_CALL) + 1);
    } finally {
      batches.mockRestore();
    }
    expect(await keysLeft(install)).toEqual([]);
  });

  it('stops after 20 batches in one run, however many keys are left, so one run never holds the table for long', async () => {
    const calls = vi.spyOn(testApplication.application.get(StationScopedTransaction), 'run').mockResolvedValue([{ deleted_count: IDEMPOTENCY_KEYS_PER_CALL }]);
    try {
      const deleted = await testApplication.application.get(RecognitionIdempotencyKeyCleanUp).runOnce();
      expect(calls).toHaveBeenCalledTimes(IDEMPOTENCY_KEY_CALLS_PER_RUN);
      expect(deleted).toBe(IDEMPOTENCY_KEY_CALLS_PER_RUN * IDEMPOTENCY_KEYS_PER_CALL);
    } finally {
      calls.mockRestore();
    }
  });

  it('a failed run is logged with its stack and resolves to 0; the next run still works', async () => {
    const install = await newInstallRow();
    await addKeys(install, 2, 60);
    const failing = vi.spyOn(testApplication.application.get(StationScopedTransaction), 'run').mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    try {
      expect(await testApplication.application.get(RecognitionIdempotencyKeyCleanUp).runOnce()).toBe(0);
    } finally {
      failing.mockRestore();
    }
    await waitForLogWrites();
    const failure = testApplication.logs.find((line) => line.level === 50 && line.job === 'recognition-idempotency-key-clean-up');
    expect((failure?.err as { stack?: string } | undefined)?.stack).toContain('connection terminated unexpectedly');
    expect(await testApplication.application.get(RecognitionIdempotencyKeyCleanUp).runOnce()).toBeGreaterThanOrEqual(2);
    expect(await keysLeft(install)).toEqual([]);
  });

  it('the database refuses to delete keys younger than 25 hours, whoever asks, since a phone may still retry them', async () => {
    const install = await newInstallRow();
    await addKeys(install, 1, 30);
    for (const tooYoung of ['24 hours', '1 hour']) {
      await expect(apiClient.query('SELECT recognition.delete_expired_recognition_idempotency_keys($1::interval, 10)', [tooYoung])).rejects.toThrow(/younger than 25 hours/);
    }
    expect(await keysLeft(install)).toEqual([{ hours_ago: 30, keys: 1 }]);
  });
});
