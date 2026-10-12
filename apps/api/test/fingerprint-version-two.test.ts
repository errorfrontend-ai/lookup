import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { INGEST_QUEUE_NAME, RefingerprintJobData } from '@lookup/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WalkthroughToolProblem } from '../scripts/development-walkthrough-tools.js';
import {
  addOrReplaceWaitingJob,
  describeRefingerprintWait,
  planRefingerprinting,
  queueRefingerprintJobs,
  REFINGERPRINT_JOB_OPTIONS,
  refingerprintJobId,
  runRefingerprinting,
  waitForRefingerprinting,
} from '../scripts/refingerprint-recordings.js';
import { databaseSetupClient, fingerprintWorkerClient, lookupApiClient } from './support/database-clients.js';

/**
 * Fingerprint version 2 (ADR-001, "Real captures, October 2026"): its hash table and the worker's one way to record a
 * new version, read from the database; and the development script that queues the re-fingerprinting.
 */
describe('fingerprint version 2', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  let workerClient: pg.Client;
  const stationIds: string[] = [];
  const assetIds: string[] = [];

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    workerClient = fingerprintWorkerClient();
    await Promise.all([setupClient.connect(), apiClient.connect(), workerClient.connect()]);
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.ads WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.clients WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM fingerprints.audio_assets WHERE id = ANY($1)', [assetIds]);
    await Promise.all([setupClient.end(), apiClient.end(), workerClient.end()]);
  });

  /** A recording on `version`, with `hashRows` rows of its own in version 2's table. */
  async function newRecording(version: number, hashRows = 0): Promise<{ assetId: string; assetNumber: number; contentSha256: Buffer }> {
    const assetId = randomUUID();
    const contentSha256 = randomBytes(32);
    assetIds.push(assetId);
    const assetNumber = (
      await setupClient.query(
        `INSERT INTO fingerprints.audio_assets (id, content_sha256, duration_milliseconds, fingerprint_version, hash_count) VALUES ($1, $2, 30000, $3, 500) RETURNING asset_number`,
        [assetId, contentSha256, version],
      )
    ).rows[0].asset_number as number;
    for (let row = 0; row < hashRows; row += 1) {
      await setupClient.query('INSERT INTO fingerprints.hashes_version_2 (hash, audio_asset_number, time_offset_frames) VALUES ($1, $2, $3)', [1_000 + row, assetNumber, row]);
    }
    return { assetId, assetNumber, contentSha256 };
  }

  async function newStationWithClient(): Promise<{ stationId: string; clientId: string }> {
    const stationId = randomUUID();
    const clientId = randomUUID();
    stationIds.push(stationId);
    await setupClient.query(`INSERT INTO app.stations (id, name, frequency_label, status) VALUES ($1, $2, '98.1 FM', 'ACTIVE')`, [stationId, `Version 2 test ${stationId.slice(0, 8)}`]);
    await setupClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, 'Brand A')`, [clientId, stationId]);
    return { stationId, clientId };
  }

  async function newAd(at: { stationId: string; clientId: string }, recording: { assetId: string; contentSha256: Buffer }, options: { uploadSha256?: Buffer; archived?: boolean; createdSecondsAgo?: number } = {}) {
    const adId = randomUUID();
    const uploadObjectKey = `ad-uploads/${at.stationId}/${adId}/audio`;
    await setupClient.query(
      `INSERT INTO app.ads (id, station_id, client_id, title, status, upload_object_key, upload_content_sha256, audio_asset_id, archived_at, created_at)
       VALUES ($1, $2, $3, 'Version 2 test ad', 'READY', $4, $5, $6, CASE WHEN $7 THEN now() END, now() - make_interval(secs => $8))`,
      [adId, at.stationId, at.clientId, uploadObjectKey, options.uploadSha256 ?? recording.contentSha256, recording.assetId, options.archived ?? false, options.createdSecondsAgo ?? 0],
    );
    return uploadObjectKey;
  }

  describe('the hash table', () => {
    it('has the same columns, foreign key and indexes as version 1', async () => {
      const shape = async (table: string) => ({
        columns: (
          await setupClient.query(
            `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'fingerprints' AND table_name = $1 ORDER BY ordinal_position`,
            [table],
          )
        ).rows,
        foreignKeys: (await setupClient.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f'`, [`fingerprints.${table}`])).rows,
        indexes: (
          await setupClient.query(`SELECT replace(indexdef, $2, 'hashes_version_N') AS definition FROM pg_indexes WHERE schemaname = 'fingerprints' AND tablename = $1 ORDER BY indexname`, [
            table,
            table,
          ])
        ).rows,
      });
      const versionTwo = await shape('hashes_version_2');
      expect(versionTwo.columns).toEqual([
        { column_name: 'hash', data_type: 'bigint', is_nullable: 'NO' },
        { column_name: 'audio_asset_number', data_type: 'integer', is_nullable: 'NO' },
        { column_name: 'time_offset_frames', data_type: 'integer', is_nullable: 'NO' },
      ]);
      expect(versionTwo).toEqual(await shape('hashes_version_1'));
    });

    it('S1-PRIVILEGES-11, -24: the worker reads, adds and removes its rows and nothing more; neither API role has any right on it', async () => {
      const privileges = await setupClient.query(
        `SELECT role_name, array_agg(privilege ORDER BY privilege) FILTER (WHERE has_table_privilege(role_name, 'fingerprints.hashes_version_2', privilege)) AS granted
           FROM unnest(ARRAY['lookup_api', 'lookup_admin_api', 'lookup_fingerprint_worker']) AS role_name,
                unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS privilege
          GROUP BY role_name ORDER BY role_name`,
      );
      expect(privileges.rows).toEqual([
        { role_name: 'lookup_admin_api', granted: null },
        { role_name: 'lookup_api', granted: null },
        { role_name: 'lookup_fingerprint_worker', granted: ['DELETE', 'INSERT', 'SELECT'] },
      ]);
    });
  });

  describe('fingerprints.record_asset_refingerprinted', () => {
    const record = (client: pg.Client, assetNumber: number, version: number) =>
      client.query('SELECT fingerprints.record_asset_refingerprinted($1::integer, $2::smallint) AS recorded', [assetNumber, version]).then((result) => result.rows[0].recorded as boolean);
    const assetRow = (assetNumber: number) =>
      setupClient.query('SELECT fingerprint_version, hash_count FROM fingerprints.audio_assets WHERE asset_number = $1', [assetNumber]).then((result) => result.rows[0]);

    it('ALL-DATABASE-06, -07: is a definer function with its search path pinned, run only by the worker', async () => {
      const described = (
        await setupClient.query(
          `SELECT prosecdef AS is_security_definer, proconfig AS settings, pg_get_function_result(oid) AS result,
                  array_remove(ARRAY[CASE WHEN has_function_privilege('lookup_api', oid, 'EXECUTE') THEN 'lookup_api' END,
                                     CASE WHEN has_function_privilege('lookup_admin_api', oid, 'EXECUTE') THEN 'lookup_admin_api' END,
                                     CASE WHEN has_function_privilege('lookup_fingerprint_worker', oid, 'EXECUTE') THEN 'lookup_fingerprint_worker' END], NULL) AS callers
             FROM pg_proc WHERE oid = 'fingerprints.record_asset_refingerprinted(integer, smallint)'::regprocedure`,
        )
      ).rows[0];
      expect(described).toEqual({ is_security_definer: true, settings: [expect.stringMatching(/^search_path=pg_catalog, .*pg_temp$/)], result: 'boolean', callers: ['lookup_fingerprint_worker'] });
      await expect(record(apiClient, 1, 2)).rejects.toThrow(/permission denied/);
    });

    it('moves a recording on an older version to the new one with the hash count it counts itself, once', async () => {
      const recording = await newRecording(1, 3);
      expect(await record(workerClient, recording.assetNumber, 2)).toBe(true);
      expect(await assetRow(recording.assetNumber)).toEqual({ fingerprint_version: 2, hash_count: 3 });
      // Again, or for a version that is not newer: nothing changes.
      expect(await record(workerClient, recording.assetNumber, 2)).toBe(false);
      expect(await record(workerClient, recording.assetNumber, 1)).toBe(false);
      expect(await assetRow(recording.assetNumber)).toEqual({ fingerprint_version: 2, hash_count: 3 });
    });

    it('answers false for a recording that does not exist, and refuses a version with no hash table or no version at all', async () => {
      expect(await record(workerClient, 2_000_000_000, 2)).toBe(false);
      const recording = await newRecording(1);
      await expect(record(workerClient, recording.assetNumber, 9)).rejects.toMatchObject({ code: '22023' });
      await expect(workerClient.query('SELECT fingerprints.record_asset_refingerprinted($1::integer, NULL)', [recording.assetNumber])).rejects.toMatchObject({ code: '22023' });
      expect(await assetRow(recording.assetNumber)).toEqual({ fingerprint_version: 1, hash_count: 500 });
    });
  });

  describe('the re-fingerprint script', () => {
    it('P4-TOOLS-01: refuses another machine’s database, Valkey or storage, or production, before it connects, with no address in the refusal', async () => {
      const local = {
        DATABASE_SETUP_URL: 'postgresql://lookup:a-secret-password@127.0.0.1:55432/lookup',
        KEY_VALUE_STORE_URL: 'redis://:a-secret-valkey-password@127.0.0.1:46379/0',
        OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:39000',
        NODE_ENV: 'development',
      };
      const refusals: Array<[Record<string, string>, RegExp]> = [
        [{ ...local, DATABASE_SETUP_URL: 'postgresql://lookup:a-secret-password@database.example.com:5432/lookup' }, /DATABASE_SETUP_URL points somewhere else/],
        [{ ...local, DATABASE_SETUP_URL: `${local.DATABASE_SETUP_URL}?host=database.example.com` }, /settings after "\?"/],
        [{ ...local, NODE_ENV: 'production' }, /development only/],
        [{ ...local, KEY_VALUE_STORE_URL: 'redis://:a-secret-valkey-password@valkey.example.com:6379/0' }, /KEY_VALUE_STORE_URL points somewhere else/],
        [{ ...local, KEY_VALUE_STORE_URL: `${local.KEY_VALUE_STORE_URL}?host=valkey.example.com` }, /KEY_VALUE_STORE_URL carries settings after "\?"/],
        [{ ...local, OBJECT_STORAGE_ENDPOINT: 'https://storage.example.com' }, /OBJECT_STORAGE_ENDPOINT points somewhere else/],
      ];
      for (const [environment, refusal] of refusals) {
        const refused = await runRefingerprinting(environment).then(
          () => null,
          (error: unknown) => error,
        );
        expect(refused, JSON.stringify(refusal.source)).toBeInstanceOf(WalkthroughToolProblem);
        expect((refused as Error).message).toMatch(refusal);
        expect((refused as Error).message).not.toMatch(/a-secret|example\.com|127\.0\.0\.1/);
      }
    });

    it('stops within seconds with a plain refusal when Valkey cannot be reached, instead of retrying for ever', async () => {
      const startedAt = Date.now();
      const environment = { ...process.env, KEY_VALUE_STORE_URL: 'redis://:a-secret-valkey-password@127.0.0.1:1/0' };
      const refused = await runRefingerprinting(environment, () => undefined).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(WalkthroughToolProblem);
      expect((refused as Error).message).toMatch(/Valkey \(KEY_VALUE_STORE_URL\) cannot be reached/);
      expect((refused as Error).message).not.toMatch(/a-secret|127\.0\.0\.1|ECONNREFUSED/);
      expect(Date.now() - startedAt).toBeLessThan(15_000);
    }, 30_000);

    it('waits until every recording is on the version, or no job is left, or the limit passes, and says whether it worked', async () => {
      const watch = (counts: { done: number[]; queued: number[] }, limitMilliseconds = 60_000) => {
        let clock = 0;
        return waitForRefingerprinting({
          total: 3,
          countDone: async () => counts.done.shift() ?? 0,
          countQueued: async () => counts.queued.shift() ?? 0,
          report: () => undefined,
          limitMilliseconds,
          pollMilliseconds: 1_000,
          now: () => clock,
          sleep: async (milliseconds) => {
            clock += milliseconds;
          },
        });
      };
      // Every recording gets there.
      const finished = await watch({ done: [1, 3], queued: [2, 0] });
      expect(describeRefingerprintWait(finished, 3, 2, 'request')).toEqual({ report: 'All 3 recording(s) are on fingerprint version 2.', isComplete: true });
      // The jobs are gone but one recording never moved: a failure, naming the request id to look up.
      const gone = await watch({ done: [2, 2, 2], queued: [1, 0] });
      expect(gone).toEqual({ done: 2, queued: 0, timedOut: false });
      const goneOutcome = describeRefingerprintWait(gone, 3, 2, 'refingerprint-request');
      expect(goneOutcome.isComplete).toBe(false);
      expect(goneOutcome.report).toMatch(/^2 of 3 .*could not be re-fingerprinted.*refingerprint-request/);
      // No worker takes the jobs: it stops at the limit and says so.
      const stuck = await watch({ done: [0, 0, 0, 0], queued: [3, 3, 3, 3] }, 2_500);
      expect(stuck).toEqual({ done: 0, queued: 3, timedOut: true });
      expect(describeRefingerprintWait(stuck, 3, 2, 'request')).toMatchObject({ isComplete: false, report: expect.stringMatching(/^Stopped waiting .*0 of 3 done and 3 still queued/) });
    });

    it('replaces a job still waiting from an earlier run, so the fresh address, deadline and request id are the ones used', async () => {
      const connection = new Redis(process.env.KEY_VALUE_STORE_URL as string, { maxRetriesPerRequest: null });
      const queue = new Queue(INGEST_QUEUE_NAME, { connection, prefix: `lookup-test-refingerprint-${randomBytes(4).toString('hex')}` });
      try {
        const job = (requestId: string) =>
          RefingerprintJobData.parse({
            request_id: requestId,
            audio_asset_number: 7,
            download_address: `http://127.0.0.1:39000/lookup-ad-uploads/key?X-Amz-Signature=${requestId}`,
            deadline_epoch_milliseconds: 1_791_361_800_000,
            fingerprint_version: 2,
          });
        const options = { ...REFINGERPRINT_JOB_OPTIONS, jobId: refingerprintJobId(7, 2) };
        expect(await addOrReplaceWaitingJob(queue, 'refingerprint', job('earlier-run'), options)).toBe('queued');
        expect(await addOrReplaceWaitingJob(queue, 'refingerprint', job('this-run'), options)).toBe('queued');
        expect((await queue.getJob(options.jobId))?.data.request_id).toBe('this-run');
        expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 1 });
      } finally {
        await queue.obliterate({ force: true });
        await queue.close();
        await connection.quit();
      }
    });

    it('plans one upload per recording on an older version, preferring a live ad, and leaves current recordings and mismatched uploads out', async () => {
      const station = await newStationWithClient();
      const olderWithTwoAds = await newRecording(1);
      const archivedKey = await newAd(station, olderWithTwoAds, { archived: true, createdSecondsAgo: 120 });
      const liveKey = await newAd(station, olderWithTwoAds, { createdSecondsAgo: 60 });
      const olderWithAMismatchedUpload = await newRecording(1);
      await newAd(station, olderWithAMismatchedUpload, { uploadSha256: randomBytes(32) });
      const current = await newRecording(2);
      await newAd(station, current);

      const plan = await planRefingerprinting(setupClient, 2);

      const ours = (numbers: number[]) => numbers.filter((number) => [olderWithTwoAds, olderWithAMismatchedUpload, current].some((recording) => recording.assetNumber === number));
      expect(plan.toRefingerprint.filter((recording) => ours([recording.audioAssetNumber]).length)).toEqual([{ audioAssetNumber: olderWithTwoAds.assetNumber, uploadObjectKey: liveKey }]);
      expect(liveKey).not.toBe(archivedKey);
      expect(ours(plan.withoutUpload)).toEqual([olderWithAMismatchedUpload.assetNumber]);
      expect(plan.alreadyCurrentCount).toBeGreaterThanOrEqual(1);
    });

    it('queues one contract-shaped job per recording, named by recording and version, so running it again queues nothing new', async () => {
      const added: Array<{ name: string; data: unknown; options: Record<string, unknown> }> = [];
      const addresses: Array<[string, number]> = [];
      const queueing = {
        fingerprintVersion: 2,
        requestId: `refingerprint-${randomUUID()}`,
        createDownloadAddress: async (key: string, seconds: number) => {
          addresses.push([key, seconds]);
          return `http://127.0.0.1:39000/lookup-ad-uploads/${key}?X-Amz-Expires=${seconds}&X-Amz-Signature=${createHash('sha256').update(key).digest('hex')}`;
        },
        addJob: async (name: string, data: unknown, options: Record<string, unknown>) => {
          added.push({ name, data, options });
        },
        now: () => 1_791_361_800_000,
      };
      const recordings = [
        { audioAssetNumber: 7, uploadObjectKey: 'ad-uploads/a/b/audio' },
        { audioAssetNumber: 8, uploadObjectKey: 'ad-uploads/a/c/audio' },
      ];

      const first = await queueRefingerprintJobs(recordings, queueing);
      const second = await queueRefingerprintJobs(recordings, queueing);

      expect(first).toEqual(['refingerprint-7-version-2', 'refingerprint-8-version-2']);
      expect(second).toEqual(first);
      expect(refingerprintJobId(7, 2)).toBe('refingerprint-7-version-2');
      expect(addresses).toEqual([['ad-uploads/a/b/audio', 1800], ['ad-uploads/a/c/audio', 1800], ['ad-uploads/a/b/audio', 1800], ['ad-uploads/a/c/audio', 1800]]);
      const [job] = added;
      expect(job?.name).toBe('refingerprint');
      expect(RefingerprintJobData.parse(job?.data)).toEqual({
        request_id: queueing.requestId,
        audio_asset_number: 7,
        download_address: expect.stringMatching(/^http:\/\/127\.0\.0\.1:39000\/lookup-ad-uploads\/ad-uploads\/a\/b\/audio\?X-Amz-Expires=1800/),
        deadline_epoch_milliseconds: 1_791_361_800_000 + 1_800_000,
        fingerprint_version: 2,
      });
      expect(job?.options).toEqual({ ...REFINGERPRINT_JOB_OPTIONS, jobId: 'refingerprint-7-version-2' });
      expect(added.map((queued) => queued.options.jobId)).toEqual([...first, ...second]);
    });
  });
});
