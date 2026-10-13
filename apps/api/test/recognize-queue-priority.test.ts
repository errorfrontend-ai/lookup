import { randomUUID } from 'node:crypto';
import { RECOGNIZE_QUEUE_NAME, type RecognizeJobData } from '@lookup/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { DEFERRED_JOB_PRIORITY } from '../src/features/recognition/recognition.service.js';
import { RecognizeQueue, RecognizeWaitTimedOut } from '../src/infrastructure/job-queues/recognize-queue.js';
import { databaseSetupClient } from './support/database-clients.js';
import { FakeRecognizeWorker, noMatch, recognize, registerInstall } from './support/listener-test-kit.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const keyValueStoreUrl = () => process.env.KEY_VALUE_STORE_URL as string;
const queuePrefix = () => process.env.QUEUE_KEY_PREFIX as string;

const jobData = (requestId: string): RecognizeJobData => ({
  request_id: requestId,
  audio_base64: 'AAAA',
  codec: 'aac',
  deadline_epoch_milliseconds: Date.now() + 30_000,
  fingerprint_version: 2,
});

/**
 * Priority and waiting for clips sent later (P4 design §5.3; P4-DEFERRED-07, -08): a deferred job goes into BullMQ's
 * prioritised set, which a worker takes only once no plain waiting (live) job is left, and its deadline and wait are
 * 5 seconds where a live job's are 2.5. The queue depth that admission reads counts both.
 */
describe('the recognize queue: deferred jobs wait behind live ones', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let recognizeQueue: RecognizeQueue;
  let inspection: Queue;
  const installRows: string[] = [];
  const client = () => supertest(testApplication.application.getHttpServer());

  /** Waits (up to 3 seconds) until the queue holds the given numbers of plain waiting and prioritised jobs. */
  async function waitForQueued(waiting: number, prioritized: number): Promise<void> {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const counts = await inspection.getJobCounts('waiting', 'prioritized');
      if (counts.waiting === waiting && counts.prioritized === prioritized) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`the queue never held ${waiting} waiting and ${prioritized} prioritised jobs`);
  }

  beforeAll(async () => {
    testApplication = await createTestApplication();
    recognizeQueue = testApplication.application.get(RecognizeQueue);
    inspection = new Queue(RECOGNIZE_QUEUE_NAME, { connection: new Redis(keyValueStoreUrl(), { maxRetriesPerRequest: null }), prefix: queuePrefix() });
    setupClient = databaseSetupClient();
    await setupClient.connect();
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRows]);
    await setupClient.end();
    await inspection.close();
    await testApplication.close();
  });

  it('P4-DEFERRED-07: with no worker running, a deferred job and then a live job are added; a worker started afterwards takes the live job first', async () => {
    const deferredJobId = randomUUID();
    const liveJobId = randomUUID();
    const deferred = recognizeQueue.addAndWait(deferredJobId, jobData('deferred'), 10_000, { priority: DEFERRED_JOB_PRIORITY });
    await waitForQueued(0, 1);
    const live = recognizeQueue.addAndWait(liveJobId, jobData('live'), 10_000);
    await waitForQueued(1, 1);

    const worker = new FakeRecognizeWorker(keyValueStoreUrl(), queuePrefix(), { concurrency: 1 });
    try {
      await Promise.all([deferred, live]);
      expect(worker.receivedJobs.map((job) => job.id)).toEqual([liveJobId, deferredJobId]);
      expect(worker.receivedJobs.map((job) => job.options.priority)).toEqual([undefined, DEFERRED_JOB_PRIORITY]);
    } finally {
      await worker.close();
    }
  });

  it('the depth admission reads counts the prioritised (deferred) jobs with the waiting (live) ones', async () => {
    const waits = [
      recognizeQueue.addAndWait(randomUUID(), jobData('deferred-1'), 1_500, { priority: DEFERRED_JOB_PRIORITY }),
      recognizeQueue.addAndWait(randomUUID(), jobData('deferred-2'), 1_500, { priority: DEFERRED_JOB_PRIORITY }),
      recognizeQueue.addAndWait(randomUUID(), jobData('live'), 1_500),
    ];
    await waitForQueued(1, 2);
    await recognizeQueue.refreshAdmission();
    expect(recognizeQueue.admissionState().waitingJobCount).toBe(3);
    // Nobody takes them: each wait ends, and each job is taken out of the queue with its audio.
    for (const outcome of await Promise.allSettled(waits)) {
      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(RecognizeWaitTimedOut);
    }
    await waitForQueued(0, 0);
  });

  it('P4-DEFERRED-08: through the route, a deferred send’s job has priority 10 and a deadline 5,000 ms after it was added; a live send’s has no priority and 2,500 ms', async () => {
    const worker = new FakeRecognizeWorker(keyValueStoreUrl(), queuePrefix());
    try {
      await worker.startHeartbeat();
      await recognizeQueue.refreshAdmission();
      worker.answer = () => noMatch();
      const install = await registerInstall(client);
      const hash = testApplication.application.get(InstallTokens).hashInstallId(install.installId);
      installRows.push((await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash])).rows[0].id as string);

      expect((await recognize(client, { installToken: install.installToken, fields: { is_deferred: 'true' } })).status).toBe(200);
      expect((await recognize(client, { installToken: install.installToken, fields: { is_deferred: 'false' } })).status).toBe(200);
      const [deferredJob, liveJob] = worker.receivedJobs;
      expect(deferredJob?.options.priority).toBe(DEFERRED_JOB_PRIORITY);
      expect(liveJob?.options.priority).toBeUndefined();
      const deadlineAfterAdding = (job: typeof deferredJob) => (job ? job.data.deadline_epoch_milliseconds - job.addedAt : Number.NaN);
      expect(deadlineAfterAdding(deferredJob)).toBeGreaterThan(4_900);
      expect(deadlineAfterAdding(deferredJob)).toBeLessThanOrEqual(5_000);
      expect(deadlineAfterAdding(liveJob)).toBeGreaterThan(2_400);
      expect(deadlineAfterAdding(liveJob)).toBeLessThanOrEqual(2_500);
    } finally {
      await worker.close();
    }
  });
});
