/**
 * Fingerprints every stored recording again with the workers' current fingerprint version (ADR-001, "Real captures,
 * October 2026"). Development only for now: switching versions with no gap in production is phase 8
 * (P8-ACOUSTIC-DUPLICATES-07).
 *
 *   npm run fingerprints:refingerprint -w @lookup/api
 *
 * The cut-over, in order: stop the workers; migrate (npm run database:migrate); restart the API so it sends jobs for
 * the new version (rebuild it first if it runs from dist); start the workers on the new version; run this; identify.
 * For each recording still on an older version it picks one ad whose original upload is that recording, signs a
 * short-lived download address for the workers (they hold no storage credentials), and queues one `refingerprint` job
 * on the ingest queue. Then it waits, showing progress, until no job is left, and exits with 1 unless every recording
 * reached the version. Safe to run again: a recording already on the version is left alone, a job's id names its
 * recording and version, and a job still waiting from an earlier run is replaced by a fresh one.
 *
 * It refuses to run unless the setup database, Valkey and the object storage are on this machine and NODE_ENV is not
 * production (the walkthrough tools' guard), and it prints recording numbers and counts only: no ad, station, address
 * or key.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { INGEST_QUEUE_NAME, REFINGERPRINT_JOB_NAME, RefingerprintJobData } from '@lookup/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import { loadAppConfig } from '../src/config/app-config.js';
import { INGEST_JOB_LIFETIME_SECONDS } from '../src/infrastructure/job-queues/ingest-queue.js';
import { ObjectStorage } from '../src/infrastructure/object-storage/object-storage.js';
import { WalkthroughToolProblem, assertDevelopmentDatabase, assertOnThisMachine } from './development-walkthrough-tools.js';

type Database = Pick<pg.Client, 'query'>;

export interface RecordingToRefingerprint {
  audioAssetNumber: number;
  uploadObjectKey: string;
}

export interface RefingerprintingPlan {
  /** Recordings on an older version with an upload to read again, oldest first. */
  toRefingerprint: RecordingToRefingerprint[];
  /** Recordings on an older version that no ad's upload matches; they stay as they are. */
  withoutUpload: number[];
  alreadyCurrentCount: number;
}

/** What to re-fingerprint. An upload counts only if its checksum is the recording's, so the worker can check the bytes. */
export async function planRefingerprinting(database: Database, fingerprintVersion: number): Promise<RefingerprintingPlan> {
  const older = (
    await database.query(
      `SELECT asset.asset_number,
              (SELECT ad.upload_object_key FROM app.ads AS ad
                WHERE ad.audio_asset_id = asset.id AND ad.upload_content_sha256 = asset.content_sha256 AND ad.upload_object_key IS NOT NULL
                ORDER BY ad.archived_at IS NOT NULL, ad.created_at LIMIT 1) AS upload_object_key
         FROM fingerprints.audio_assets AS asset
        WHERE asset.fingerprint_version < $1
        ORDER BY asset.asset_number`,
      [fingerprintVersion],
    )
  ).rows as Array<{ asset_number: number; upload_object_key: string | null }>;
  const current = await database.query(`SELECT count(*)::integer AS count FROM fingerprints.audio_assets WHERE fingerprint_version >= $1`, [fingerprintVersion]);
  return {
    toRefingerprint: older.flatMap((row) => (row.upload_object_key ? [{ audioAssetNumber: row.asset_number, uploadObjectKey: row.upload_object_key }] : [])),
    withoutUpload: older.filter((row) => !row.upload_object_key).map((row) => row.asset_number),
    alreadyCurrentCount: (current.rows[0] as { count: number }).count,
  };
}

export const refingerprintJobId = (audioAssetNumber: number, fingerprintVersion: number) => `refingerprint-${audioAssetNumber}-version-${fingerprintVersion}`;

export const REFINGERPRINT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: true,
  removeOnFail: true,
} as const;

export interface RefingerprintQueueing {
  fingerprintVersion: number;
  requestId: string;
  createDownloadAddress: (uploadObjectKey: string, expiresInSeconds: number) => Promise<string>;
  /** Adds the job; the command line replaces a job still waiting from an earlier run (addOrReplaceWaitingJob). */
  addJob: (name: string, data: RefingerprintJobData, options: typeof REFINGERPRINT_JOB_OPTIONS & { jobId: string }) => Promise<unknown>;
  now?: () => number;
}

/** One job per recording, each checked against the contract before it is queued. */
export async function queueRefingerprintJobs(recordings: readonly RecordingToRefingerprint[], queueing: RefingerprintQueueing): Promise<string[]> {
  const now = queueing.now ?? Date.now;
  const jobIds: string[] = [];
  for (const recording of recordings) {
    const data = RefingerprintJobData.parse({
      request_id: queueing.requestId,
      audio_asset_number: recording.audioAssetNumber,
      download_address: await queueing.createDownloadAddress(recording.uploadObjectKey, INGEST_JOB_LIFETIME_SECONDS),
      deadline_epoch_milliseconds: now() + INGEST_JOB_LIFETIME_SECONDS * 1000,
      fingerprint_version: queueing.fingerprintVersion,
    });
    const jobId = refingerprintJobId(recording.audioAssetNumber, queueing.fingerprintVersion);
    await queueing.addJob(REFINGERPRINT_JOB_NAME, data, { ...REFINGERPRINT_JOB_OPTIONS, jobId });
    jobIds.push(jobId);
  }
  return jobIds;
}

/**
 * Adds the job. BullMQ ignores an add whose id is already queued, which would keep an earlier run's download address,
 * deadline and request id; so a job still waiting from an earlier run is removed and added fresh. One a worker is
 * already running is left to finish.
 */
export async function addOrReplaceWaitingJob(
  queue: Pick<Queue, 'add' | 'getJob'>,
  name: string,
  data: RefingerprintJobData,
  options: typeof REFINGERPRINT_JOB_OPTIONS & { jobId: string },
): Promise<'queued' | 'already-running'> {
  const earlier = await queue.getJob(options.jobId);
  if (earlier) {
    if ((await earlier.getState()) === 'active') return 'already-running';
    try {
      await earlier.remove();
    } catch {
      return 'already-running'; // a worker took it in the meantime
    }
  }
  await queue.add(name, data, options);
  return 'queued';
}

export interface RefingerprintWatch {
  total: number;
  countDone: () => Promise<number>;
  countQueued: () => Promise<number>;
  report: (line: string) => void;
  limitMilliseconds?: number;
  pollMilliseconds?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface RefingerprintWait {
  done: number;
  queued: number;
  timedOut: boolean;
}

const WAIT_LIMIT_MILLISECONDS = 10 * 60_000;
const POLL_MILLISECONDS = 2_000;
const VALKEY_CONNECT_LIMIT_MILLISECONDS = 8_000;

/** Waits until every recording is on the version, or no job is left, or the limit passes, showing progress. */
export async function waitForRefingerprinting(watch: RefingerprintWatch): Promise<RefingerprintWait> {
  const now = watch.now ?? Date.now;
  const sleep = watch.sleep ?? ((milliseconds: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const startedAt = now();
  let lastDone = -1;
  for (;;) {
    const done = await watch.countDone();
    if (done !== lastDone) watch.report(`  ${done} of ${watch.total} done`);
    lastDone = done;
    const queued = await watch.countQueued();
    if (done >= watch.total) return { done, queued, timedOut: false };
    // A job can finish between the two counts, so count once more when none is left.
    if (queued === 0) return { done: await watch.countDone(), queued, timedOut: false };
    if (now() - startedAt > (watch.limitMilliseconds ?? WAIT_LIMIT_MILLISECONDS)) return { done, queued, timedOut: true };
    await sleep(watch.pollMilliseconds ?? POLL_MILLISECONDS);
  }
}

export interface RefingerprintingOutcome {
  report: string;
  /** True only when every recording that could be re-fingerprinted reached the version. */
  isComplete: boolean;
}

/** The last words of a run, and whether it worked. */
export function describeRefingerprintWait(wait: RefingerprintWait, total: number, fingerprintVersion: number, requestId: string): RefingerprintingOutcome {
  if (wait.done >= total) return { report: `All ${total} recording(s) are on fingerprint version ${fingerprintVersion}.`, isComplete: true };
  if (wait.timedOut) {
    return {
      report:
        `Stopped waiting after ${WAIT_LIMIT_MILLISECONDS / 60_000} minutes: ${wait.done} of ${total} done and ${wait.queued} still queued. ` +
        `Are the workers running (npm run workers)? The queued jobs stay until their address expires, ${INGEST_JOB_LIFETIME_SECONDS / 60} minutes after queueing; run this again to see where it stands.`,
      isComplete: false,
    };
  }
  return {
    report:
      `${wait.done} of ${total} recording(s) are on fingerprint version ${fingerprintVersion}; the others could not be re-fingerprinted. ` +
      `The workers' log says why, under request id ${requestId}. Do the workers run fingerprint version ${fingerprintVersion}?`,
    isComplete: false,
  };
}

async function countOnVersion(database: Database, audioAssetNumbers: readonly number[], fingerprintVersion: number): Promise<number> {
  const result = await database.query(
    `SELECT count(*)::integer AS count FROM fingerprints.audio_assets WHERE asset_number = ANY($1::integer[]) AND fingerprint_version >= $2`,
    [[...audioAssetNumbers], fingerprintVersion],
  );
  return (result.rows[0] as { count: number }).count;
}

/**
 * A Valkey connection that is ready, or a plain refusal within seconds. Without a limit, ioredis retries for ever and
 * BullMQ waits for ever, printing each raw error, which can hold the address.
 */
export async function connectToValkey(address: string, limitMilliseconds = VALKEY_CONNECT_LIMIT_MILLISECONDS): Promise<Redis> {
  const keyValueStore = new Redis(address, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3_000,
    commandTimeout: 5_000,
    retryStrategy: (attempt) => (attempt > 2 ? null : 500),
  });
  keyValueStore.on('error', () => undefined); // reported below in plain words
  let limit: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      keyValueStore.connect().then(() => keyValueStore.ping()),
      new Promise((_, reject) => {
        limit = setTimeout(() => reject(new Error('timed out')), limitMilliseconds);
      }),
    ]);
    return keyValueStore;
  } catch {
    keyValueStore.disconnect();
    throw new WalkthroughToolProblem('Valkey (KEY_VALUE_STORE_URL) cannot be reached. Is Docker running, and is its address in apps/api/.env right?');
  } finally {
    clearTimeout(limit);
  }
}

/** Runs the whole re-fingerprint on the setup database: what to print, and whether every recording got there. */
export async function runRefingerprinting(environment: NodeJS.ProcessEnv, report: (line: string) => void = console.log): Promise<RefingerprintingOutcome> {
  const connection = assertDevelopmentDatabase(environment.DATABASE_SETUP_URL, environment.NODE_ENV);
  assertOnThisMachine(environment.KEY_VALUE_STORE_URL, 'KEY_VALUE_STORE_URL');
  assertOnThisMachine(environment.OBJECT_STORAGE_ENDPOINT, 'OBJECT_STORAGE_ENDPOINT');
  const config = loadAppConfig(environment);
  const fingerprintVersion = config.FINGERPRINT_VERSION;
  const keyValueStore = await connectToValkey(config.KEY_VALUE_STORE_URL);
  const queue = new Queue(INGEST_QUEUE_NAME, { connection: keyValueStore, prefix: config.QUEUE_KEY_PREFIX });
  queue.on('error', () => undefined); // a lost connection fails the call that needed it, which is reported in plain words
  const database = new pg.Client({ ...connection, application_name: 'lookup-refingerprint-recordings', connectionTimeoutMillis: 5_000, query_timeout: 15_000 });
  try {
    await database.connect();
    const plan = await planRefingerprinting(database, fingerprintVersion);
    const summary = [`Fingerprint version ${fingerprintVersion}: ${plan.alreadyCurrentCount} recording(s) already on it.`];
    if (plan.withoutUpload.length) {
      summary.push(`${plan.withoutUpload.length} recording(s) have no upload to read again and stay as they are (numbers ${plan.withoutUpload.join(', ')}).`);
    }
    if (plan.toRefingerprint.length === 0) return { report: [...summary, 'Nothing to re-fingerprint.'].join('\n'), isComplete: true };

    const objectStorage = new ObjectStorage(config);
    const requestId = `refingerprint-${randomUUID()}`;
    let alreadyRunning = 0;
    const jobIds = await queueRefingerprintJobs(plan.toRefingerprint, {
      fingerprintVersion,
      requestId,
      createDownloadAddress: (key, seconds) => objectStorage.createWorkerDownloadUrl(key, seconds),
      addJob: async (name, data, options) => {
        if ((await addOrReplaceWaitingJob(queue, name, data, options)) === 'already-running') alreadyRunning += 1;
      },
    });
    const running = alreadyRunning ? ` ${alreadyRunning} of them were already being worked on from an earlier run.` : '';
    report(`${summary.join('\n')}\nQueued ${jobIds.length} recording(s) for the workers (request id ${requestId}).${running} Waiting for them…`);

    const audioAssetNumbers = plan.toRefingerprint.map((recording) => recording.audioAssetNumber);
    const wait = await waitForRefingerprinting({
      total: audioAssetNumbers.length,
      countDone: () => countOnVersion(database, audioAssetNumbers, fingerprintVersion),
      countQueued: async () => (await Promise.all(jobIds.map((jobId) => queue.getJob(jobId)))).filter((job) => job !== undefined).length,
      report,
    });
    return describeRefingerprintWait(wait, audioAssetNumbers.length, fingerprintVersion, requestId);
  } finally {
    await queue.close().catch(() => undefined);
    keyValueStore.disconnect();
    await database.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const environmentFile = resolve(import.meta.dirname, '..', '.env');
  if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
  runRefingerprinting(process.env)
    .then(({ report, isComplete }) => {
      if (isComplete) {
        console.log(report);
      } else {
        console.error(report);
        process.exitCode = 1;
      }
    })
    .catch((error: unknown) => {
      // Our own refusals are written for people; anything else is summed up by its code alone, as its text can hold values.
      const code = typeof (error as { code?: unknown }).code === 'string' ? ` (${(error as { code: string }).code})` : '';
      console.error(
        error instanceof WalkthroughToolProblem
          ? error.message
          : `Re-fingerprinting failed${code}. Is Docker running, is the database migrated (npm run database:migrate), and is apps/api/.env complete?`,
      );
      process.exit(1);
    });
}
