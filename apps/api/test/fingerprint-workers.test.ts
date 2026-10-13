import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INGEST_QUEUE_NAME, RECOGNIZE_QUEUE_NAME, RecognizeJobResult, RecognizeResponse } from '@lookup/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planRefingerprinting, queueRefingerprintJobs } from '../scripts/refingerprint-recordings.js';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { DEFERRED_JOB_PRIORITY } from '../src/features/recognition/recognition.service.js';
import { RecognizeQueue, RecognizeWaitTimedOut } from '../src/infrastructure/job-queues/recognize-queue.js';
import { workerHeartbeatKey } from '../src/infrastructure/job-queues/worker-heartbeat-key.js';
import { ObjectStorage } from '../src/infrastructure/object-storage/object-storage.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertNoInternalDetails } from './support/internal-detail-patterns.js';
import { CALL_CARD, recognize, registerInstall } from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { type PythonWorker, runFingerprinterModule, startPythonWorker } from './support/python-workers.js';
import { createTestApplication, removeTestQueueKeys, type TestApplication } from './support/test-application.js';

/**
 * Step 3 end to end: the real Python workers (services/fingerprinter/workers) on the compose Valkey and
 * Postgres, fed by the real API through BullMQ, with real (synthetic) audio uploaded to the compose
 * object storage. Node adds the jobs, Python takes them: the cross-language contract (S3-TESTS-01).
 * The tests run in order and build on each other, like a station and a listener would.
 */
/** The fingerprint version the API and the workers run (ADR-001, "Real captures, October 2026"), and its hash table. */
const FINGERPRINT_VERSION = 2;
const HASHES = `fingerprints.hashes_version_${FINGERPRINT_VERSION}`;

describe('the fingerprint workers, end to end', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  let owner: PortalTestUser;
  let clientId: string;
  let adId: string;
  let ingestWorker: PythonWorker;
  let recognizeWorker: PythonWorker;
  const extraWorkers: PythonWorker[] = [];
  const audioDirectory = mkdtempSync(join(tmpdir(), 'lookup-test-audio-'));
  const audio = (name: string) => readFileSync(join(audioDirectory, name));
  const queuePrefix = () => process.env.QUEUE_KEY_PREFIX as string;
  const client = () => supertest(testApplication.application.getHttpServer());
  const sessions = new Map<string, Record<string, string>>();
  const installRowIds: string[] = [];
  /** The request id of each upload's completion, by ad: its ingest job and the worker's log lines carry it. */
  const completionRequestIds = new Map<string, string>();

  async function as(user: PortalTestUser) {
    let cookies = sessions.get(user.userId);
    if (!cookies) {
      const response = await client().post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).send({ email: user.email, password: user.password });
      cookies = cookiesSetBy(response);
      sessions.set(user.userId, cookies);
    }
    const send = (method: 'get' | 'post' | 'put', path: string, body?: object) => {
      const request = client()[method](path).set('Origin', PORTAL_ORIGIN).set('Cookie', cookieHeader(cookies as Record<string, string>));
      return body ? request.send(body) : request;
    };
    return send;
  }

  async function uploadAd(user: PortalTestUser, forClientId: string, bytes: Buffer, contentType: string, title: string): Promise<string> {
    const send = await as(user);
    const created = await send('post', `/api/v1/stations/${user.stationId}/ads`, { clientId: forClientId, title, upload: { fileName: 'ad.wav', contentType, sizeBytes: bytes.length } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const put = await fetch(created.body.upload.url, { method: 'PUT', body: bytes, headers: { 'Content-Type': contentType } });
    expect(put.status).toBe(200);
    const completed = await send('post', `/api/v1/stations/${user.stationId}/ads/${created.body.adId}/complete`);
    expect(completed.body.status).toBe('PROCESSING');
    completionRequestIds.set(created.body.adId as string, completed.headers['x-request-id'] as string);
    return created.body.adId as string;
  }

  async function waitForAd(user: PortalTestUser, waitedAdId: string): Promise<Record<string, unknown>> {
    const send = await as(user);
    const startedAt = Date.now();
    for (;;) {
      const response = await send('get', `/api/v1/stations/${user.stationId}/ads/${waitedAdId}`);
      if (response.body.status !== 'PROCESSING') return response.body as Record<string, unknown>;
      if (Date.now() - startedAt > 90_000) {
        const workerLines = ingestWorker.logLines.slice(-15).map((line) => JSON.stringify(line));
        const apiLines = testApplication.logs.lines.filter((line) => /ingest|queue/i.test(JSON.stringify(line))).slice(-10).map((line) => JSON.stringify(line).slice(0, 600));
        throw new Error(['the ad was still PROCESSING after 90 seconds; the ingest worker wrote:', ...workerLines, 'and the API:', ...apiLines].join('\n'));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  const todayAtStation = (daysFromToday = 0) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lusaka' }).format(new Date(Date.now() + daysFromToday * 86_400_000));
  const allDay = [
    { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], localStartTime: '00:00', localEndTime: '12:00' },
    { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], localStartTime: '12:00', localEndTime: '00:00' },
  ];

  async function newInstallToken(): Promise<string> {
    const { installToken } = await registerInstall(client);
    const subject = JSON.parse(Buffer.from((installToken.split('.')[1] as string), 'base64url').toString('utf8')).sub as string;
    installRowIds.push(subject);
    return installToken;
  }

  /** Recordings with these bytes' SHA-256 and their rows in the current hash table: this test's own, whatever else runs. */
  async function rowsOfRecording(bytes: Buffer): Promise<{ recordings: number; hashes: number }> {
    return (
      await setupClient.query(
        `SELECT count(*)::integer AS recordings,
                coalesce(sum((SELECT count(*) FROM ${HASHES} AS hash WHERE hash.audio_asset_number = asset.asset_number)), 0)::integer AS hashes
           FROM fingerprints.audio_assets AS asset WHERE asset.content_sha256 = $1`,
        [createHash('sha256').update(bytes).digest()],
      )
    ).rows[0] as { recordings: number; hashes: number };
  }

  beforeAll(async () => {
    runFingerprinterModule('bench.make_test_audio', ['--output-directory', audioDirectory]);
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
    owner = await testUsers.create();
    clientId = (await (await as(owner))('post', `/api/v1/stations/${owner.stationId}/clients`, { name: 'Brand A' })).body.id as string;
    [ingestWorker, recognizeWorker] = await Promise.all([
      startPythonWorker('ingest', { queueKeyPrefix: queuePrefix() }),
      // Two clips at once, as in production (the worker's default).
      startPythonWorker('recognize', { queueKeyPrefix: queuePrefix(), concurrency: 2 }),
    ]);
    await testApplication.application.get(RecognizeQueue).refreshAdmission();
  }, 240_000);

  afterAll(async () => {
    await Promise.allSettled([ingestWorker?.stop(), recognizeWorker?.stop(), ...extraWorkers.map((worker) => worker.stop())]);
    const assetIds = (await setupClient.query('SELECT DISTINCT audio_asset_id FROM app.ads WHERE station_id = ANY($1) AND audio_asset_id IS NOT NULL', [testUsers.stationIds])).rows.map((row) => row.audio_asset_id);
    await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installRowIds]);
    // Every match also stores the stations it weighed (P4-D8), and those rows refer to the recognition.
    await setupClient.query('DELETE FROM app.recognition_candidates WHERE recognition_id IN (SELECT id FROM app.recognition_events WHERE listener_install_id = ANY($1))', [installRowIds]);
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1)', [installRowIds]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRowIds]);
    await testUsers.cleanUp();
    await setupClient.query('DELETE FROM fingerprints.audio_assets WHERE id = ANY($1)', [assetIds]);
    await setupClient.end();
    await testApplication.close();
  }, 120_000);

  it('an uploaded ad is fingerprinted by the Python ingest worker and becomes READY, with exactly the hashes the engine makes for it', async () => {
    adId = await uploadAd(owner, clientId, audio('ad.wav'), 'audio/wav', 'Summer service offer');
    const ad = await waitForAd(owner, adId);
    expect(ad.status).toBe('READY');
    expect(ad).not.toHaveProperty('audioAssetId');
    const stored = (await setupClient.query(
      `SELECT ad.duration_milliseconds, asset.hash_count, (SELECT count(*)::integer FROM ${HASHES} WHERE audio_asset_number = asset.asset_number) AS hash_rows
         FROM app.ads ad JOIN fingerprints.audio_assets asset ON asset.id = ad.audio_asset_id WHERE ad.id = $1`, [adId])).rows[0];
    const expected = JSON.parse(readFileSync(join(audioDirectory, 'expected.json'), 'utf8')) as { ad_hash_count: number };
    expect(stored).toEqual({ duration_milliseconds: 30_000, hash_count: expected.ad_hash_count, hash_rows: expected.ad_hash_count });
    // Every ingest log line for its job carried the request id of the upload's completion.
    const jobLines = ingestWorker.logLines.filter((line) => line.job_id === `ingest-${adId}`);
    expect(jobLines.map((line) => line.message)).toContain('job finished');
    expect(new Set(jobLines.map((line) => line.request_id))).toEqual(new Set([completionRequestIds.get(adId)]));
    expect(JSON.stringify(ingestWorker.logLines)).not.toMatch(/X-Amz-Signature|X-Amz-Credential/);
  }, 120_000);

  it('a phone-like 8-second AAC clip of the published ad gets MATCH with exactly the station’s saved buttons', async () => {
    const send = await as(owner);
    expect((await send('put', `/api/v1/stations/${owner.stationId}/ads/${adId}/card`, CALL_CARD)).status).toBe(200);
    expect((await send('put', `/api/v1/stations/${owner.stationId}/ads/${adId}/schedule`, { startsOn: todayAtStation(), endsOn: todayAtStation(27), timeWindows: allDay, gracePeriodMinutes: 10 })).status).toBe(200);
    expect((await send('post', `/api/v1/stations/${owner.stationId}/ads/${adId}/publish`)).status).toBe(200);

    const response = await recognize(client, { installToken: await newInstallToken(), audio: audio('clip.m4a') });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(RecognizeResponse.safeParse(response.body).success).toBe(true);
    expect(response.body).toMatchObject({ status: 'MATCH', result: { kind: 'CAMPAIGN', station: { id: owner.stationId }, title: 'Summer service offer', card: { actions: CALL_CARD.actions } } });
    const row = (await setupClient.query('SELECT outcome, aligned_hash_count, match_offset_milliseconds FROM app.recognition_events WHERE id = $1', [response.body.recognition_id])).rows[0];
    expect(row.outcome).toBe('MATCH');
    expect(row.aligned_hash_count).toBeGreaterThanOrEqual(26);
    expect(Math.abs(row.match_offset_milliseconds - 6_000)).toBeLessThan(200);
    expect(recognizeWorker.logLines.some((line) => line.message === 'job finished' && line.request_id === response.headers['x-request-id'])).toBe(true);
  }, 60_000);

  it('an unrelated clip gets NO_MATCH, with a recognition id and no card', async () => {
    const response = await recognize(client, { installToken: await newInstallToken(), audio: audio('unrelated.m4a') });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'NO_MATCH', recognition_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7/) });
    expect(response.body).not.toHaveProperty('result');
  }, 60_000);

  it('re-fingerprinting brings a version 1 recording to the current version: the hashes a new upload gets, no ad changed, and clips still match', async () => {
    const recording = (await setupClient.query(
      'SELECT asset.asset_number FROM app.ads ad JOIN fingerprints.audio_assets asset ON asset.id = ad.audio_asset_id WHERE ad.id = $1', [adId])).rows[0] as { asset_number: number };
    // Back to how every recording was before October 2026: version 1, and nothing in the current table.
    await setupClient.query(`DELETE FROM ${HASHES} WHERE audio_asset_number = $1`, [recording.asset_number]);
    await setupClient.query('UPDATE fingerprints.audio_assets SET fingerprint_version = 1 WHERE asset_number = $1', [recording.asset_number]);
    const adRow = () => setupClient.query('SELECT status, audio_asset_id, duration_milliseconds, updated_at FROM app.ads WHERE id = $1', [adId]).then((result) => result.rows[0]);
    const adBefore = await adRow();

    const plan = await planRefingerprinting(setupClient, FINGERPRINT_VERSION);
    const planned = plan.toRefingerprint.filter((found) => found.audioAssetNumber === recording.asset_number);
    expect(planned).toHaveLength(1);
    const objectStorage = testApplication.application.get(ObjectStorage);
    const queueConnection = new Redis(process.env.KEY_VALUE_STORE_URL as string, { maxRetriesPerRequest: null });
    const queue = new Queue(INGEST_QUEUE_NAME, { connection: queueConnection, prefix: queuePrefix() });
    try {
      await queueRefingerprintJobs(planned, {
        fingerprintVersion: FINGERPRINT_VERSION,
        requestId: 'refingerprint-test',
        createDownloadAddress: (key, seconds) => objectStorage.createWorkerDownloadUrl(key, seconds),
        addJob: (name, data, options) => queue.add(name, data, options),
      });
      const startedAt = Date.now();
      for (;;) {
        const { fingerprint_version } = (await setupClient.query('SELECT fingerprint_version FROM fingerprints.audio_assets WHERE asset_number = $1', [recording.asset_number])).rows[0];
        if (fingerprint_version === FINGERPRINT_VERSION) break;
        if (Date.now() - startedAt > 60_000) throw new Error(`not re-fingerprinted after 60 seconds; the ingest worker wrote:\n${ingestWorker.logLines.slice(-10).map((line) => JSON.stringify(line)).join('\n')}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } finally {
      await queue.close();
      await queueConnection.quit();
    }

    const expected = JSON.parse(readFileSync(join(audioDirectory, 'expected.json'), 'utf8')) as { ad_hash_count: number };
    const stored = (await setupClient.query(
      `SELECT hash_count, (SELECT count(*)::integer FROM ${HASHES} WHERE audio_asset_number = $1) AS hash_rows FROM fingerprints.audio_assets WHERE asset_number = $1`,
      [recording.asset_number])).rows[0];
    expect(stored).toEqual({ hash_count: expected.ad_hash_count, hash_rows: expected.ad_hash_count });
    expect(await adRow()).toEqual(adBefore);
    expect(ingestWorker.logLines.some((line) => line.request_id === 'refingerprint-test' && line.message === 'job finished' && line.outcome === 'REFINGERPRINTED')).toBe(true);
    expect(JSON.stringify(ingestWorker.logLines)).not.toMatch(/X-Amz-Signature|X-Amz-Credential/);
    const response = await recognize(client, { installToken: await newInstallToken(), audio: audio('clip.m4a') });
    expect(response.body).toMatchObject({ status: 'MATCH', result: { title: 'Summer service offer' } });
  }, 120_000);

  it('a clip that starts like an M4A but cannot be decoded is 400 INVALID_AUDIO from the real worker, recorded as such, with none of the decoder’s words', async () => {
    const corrupt = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), randomBytes(8_000)]);
    const response = await recognize(client, { installToken: await newInstallToken(), audio: corrupt });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'INVALID_AUDIO', request_id: response.headers['x-request-id'] });
    assertNoInternalDetails(response.body);
    expect(JSON.stringify(response.body)).not.toMatch(/av\.|ffmpeg|demux|moov|DecodeError|Traceback/i);
    const stored = await setupClient.query('SELECT outcome FROM app.recognition_events WHERE request_id = $1', [response.headers['x-request-id']]);
    expect(stored.rows[0]?.outcome).toBe('INVALID_AUDIO');
  }, 60_000);

  it('the queue contract: a job Node adds is answered by Python in the contract’s shape, and one past its deadline is dropped undecoded', async () => {
    const recognizeQueue = testApplication.application.get(RecognizeQueue);
    const clip = audio('clip.m4a').toString('base64');
    const answer = await recognizeQueue.addAndWait(randomUUID(), { request_id: 'contract-test', audio_base64: clip, codec: 'aac', deadline_epoch_milliseconds: Date.now() + 2_500, fingerprint_version: FINGERPRINT_VERSION }, 2_500);
    expect(RecognizeJobResult.safeParse(answer).success).toBe(true);
    expect(answer.status).toBe('MATCH');

    const expiredJobId = randomUUID();
    const expired = await recognizeQueue.addAndWait(expiredJobId, { request_id: 'expired-test', audio_base64: clip, codec: 'aac', deadline_epoch_milliseconds: Date.now() - 1, fingerprint_version: FINGERPRINT_VERSION }, 2_500);
    expect(expired).toEqual({ status: 'EXPIRED', audio_asset_number: null, aligned_hash_count: 0, match_margin: null, match_offset_milliseconds: null });
    expect(recognizeWorker.logLines.some((line) => line.job_id === expiredJobId && line.message === 'clip recognized')).toBe(false);
  }, 60_000);

  it('two recognize workers share the queue: each clip is answered once, by one of them', async () => {
    extraWorkers.push(await startPythonWorker('recognize', { queueKeyPrefix: queuePrefix() }));
    const recognizeQueue = testApplication.application.get(RecognizeQueue);
    const clip = audio('clip.m4a').toString('base64');
    const jobIds = Array.from({ length: 6 }, () => randomUUID());
    const answers = await Promise.all(jobIds.map((jobId) =>
      recognizeQueue.addAndWait(jobId, { request_id: `two-workers-${jobId}`, audio_base64: clip, codec: 'aac', deadline_epoch_milliseconds: Date.now() + 20_000, fingerprint_version: FINGERPRINT_VERSION }, 20_000)));
    expect(answers.every((answer) => answer.status === 'MATCH')).toBe(true);
    const handledJobIds = [recognizeWorker, ...extraWorkers].flatMap((worker) => worker.logLines.filter((line) => line.message === 'job finished').map((line) => line.job_id));
    for (const jobId of jobIds) expect(handledJobIds.filter((handled) => handled === jobId)).toHaveLength(1);
    await extraWorkers.pop()?.stop();
  }, 180_000);

  it('P4-DEFERRED-07 with the real worker: a deferred job added first and a live job added after are taken live first by a Python worker started afterwards', async () => {
    // A queue of its own, so the worker already running takes nothing from it.
    const separatePrefix = `${queuePrefix()}-priority`;
    const connection = new Redis(process.env.KEY_VALUE_STORE_URL as string, { maxRetriesPerRequest: null });
    const queue = new Queue(RECOGNIZE_QUEUE_NAME, { connection, prefix: separatePrefix });
    let lateWorker: PythonWorker | undefined;
    try {
      const clip = audio('clip.m4a').toString('base64');
      const job = (requestId: string) => ({ request_id: requestId, audio_base64: clip, codec: 'aac', deadline_epoch_milliseconds: Date.now() + 120_000, fingerprint_version: FINGERPRINT_VERSION });
      const deferredJobId = randomUUID();
      const liveJobId = randomUUID();
      const options = { attempts: 1, removeOnComplete: true, removeOnFail: true };
      await queue.add(RECOGNIZE_QUEUE_NAME, job('deferred-first'), { ...options, jobId: deferredJobId, priority: DEFERRED_JOB_PRIORITY });
      await queue.add(RECOGNIZE_QUEUE_NAME, job('live-second'), { ...options, jobId: liveJobId });
      lateWorker = await startPythonWorker('recognize', { queueKeyPrefix: separatePrefix, concurrency: 1 });
      const finishedOrder = () => (lateWorker as PythonWorker).logLines.filter((line) => line.message === 'job finished').map((line) => line.job_id);
      for (let waited = 0; waited < 600 && finishedOrder().length < 2; waited += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(finishedOrder()).toEqual([liveJobId, deferredJobId]);
    } finally {
      await lateWorker?.stop();
      await queue.close();
      await removeTestQueueKeys(connection, separatePrefix);
      await connection.quit();
    }
  }, 120_000);

  it('a failed download is tried again after a delay and the ad still becomes READY, while clips keep being answered', async () => {
    const secondAd = audio('second-ad.wav');
    let downloads = 0;
    const storage = http.createServer((request, response) => {
      downloads += 1;
      if (downloads === 1) {
        setTimeout(() => response.writeHead(503).end(), 2_000);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(secondAd.length) }).end(secondAd);
    });
    await new Promise<void>((resolve) => storage.listen(0, '127.0.0.1', resolve));
    const retriedAdId = randomUUID();
    await setupClient.query(
      `INSERT INTO app.ads (id, station_id, client_id, title, status, upload_object_key, uploaded_at) VALUES ($1, $2, $3, 'Retried ad', 'PROCESSING', 'ad-uploads/retried', now())`,
      [retriedAdId, owner.stationId, clientId],
    );
    const retryConnection = new Redis(process.env.KEY_VALUE_STORE_URL as string, { maxRetriesPerRequest: null });
    const queue = new Queue(INGEST_QUEUE_NAME, { connection: retryConnection, prefix: queuePrefix() });
    try {
      await queue.add(INGEST_QUEUE_NAME, {
        request_id: 'retry-test', ad_id: retriedAdId, download_address: `http://127.0.0.1:${(storage.address() as AddressInfo).port}/second-ad.wav`,
        deadline_epoch_milliseconds: Date.now() + 120_000, fingerprint_version: FINGERPRINT_VERSION,
      }, { jobId: `ingest-${retriedAdId}`, attempts: 3, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: true, removeOnFail: true });

      // While the ingest worker is busy with that, the recognize worker answers at once.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const startedAt = Date.now();
      expect((await recognize(client, { installToken: await newInstallToken(), audio: audio('clip.m4a') })).body.status).toBe('MATCH');
      expect(Date.now() - startedAt).toBeLessThan(2_500);

      const ad = await waitForAd(owner, retriedAdId);
      expect(ad.status).toBe('READY');
      expect(downloads).toBe(2);
      expect(ingestWorker.logLines.some((line) => line.message === 'job failed' && line.code === 'DOWNLOAD_FAILED' && line.request_id === 'retry-test')).toBe(true);
    } finally {
      await queue.close();
      await retryConnection.quit();
      storage.close();
    }
  }, 120_000);

  it('each clip finds its own ad: a clip of a second published ad gets that ad’s buttons, and a clip of the first still gets the first’s; a label edited in the portal reaches the next listener', async () => {
    const send = await as(owner);
    const bookingCard = {
      schema_version: 1,
      layout: 'VERTICAL_STACK',
      actions: [{ type: 'LINK', id: '0192a6c4-0000-4000-8000-0000000000e1', label: 'Book online', style: 'PRIMARY', url: 'https://example.com/book' }],
    };
    const secondAdId = await uploadAd(owner, clientId, audio('second-ad.wav'), 'audio/wav', 'Weekend booking offer');
    expect((await waitForAd(owner, secondAdId)).status).toBe('READY');
    expect((await send('put', `/api/v1/stations/${owner.stationId}/ads/${secondAdId}/card`, bookingCard)).status).toBe(200);
    expect((await send('put', `/api/v1/stations/${owner.stationId}/ads/${secondAdId}/schedule`, { startsOn: todayAtStation(), endsOn: todayAtStation(27), timeWindows: allDay, gracePeriodMinutes: 10 })).status).toBe(200);
    expect((await send('post', `/api/v1/stations/${owner.stationId}/ads/${secondAdId}/publish`)).status).toBe(200);

    const second = await recognize(client, { installToken: await newInstallToken(), audio: audio('second-clip.m4a') });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: 'MATCH', result: { title: 'Weekend booking offer' } });
    expect(second.body.result.card.actions).toEqual(bookingCard.actions);
    const first = await recognize(client, { installToken: await newInstallToken(), audio: audio('clip.m4a') });
    expect(first.body).toMatchObject({ status: 'MATCH', result: { title: 'Summer service offer' } });
    expect(first.body.result.card.actions).toEqual(CALL_CARD.actions);

    // A label edited in the portal while the ad is live is what the very next listener sees.
    const relabelled = { ...bookingCard, actions: [{ ...bookingCard.actions[0], label: 'Book a table' }] };
    expect((await send('put', `/api/v1/stations/${owner.stationId}/ads/${secondAdId}/card`, relabelled)).status).toBe(200);
    const afterEdit = await recognize(client, { installToken: await newInstallToken(), audio: audio('second-clip.m4a') });
    expect(afterEdit.body.result.card.actions).toEqual(relabelled.actions);
  }, 120_000);

  it('a corrupt file ends FAILED with a reason the station can read, and stores no recording', async () => {
    const corrupt = audio('corrupt.wav');
    const corruptAdId = await uploadAd(owner, clientId, corrupt, 'audio/wav', 'Broken upload');
    const ad = await waitForAd(owner, corruptAdId);
    expect(ad).toMatchObject({ status: 'FAILED', processingErrorCode: 'audio_unreadable' });
    expect((await setupClient.query('SELECT audio_asset_id FROM app.ads WHERE id = $1', [corruptAdId])).rows[0].audio_asset_id).toBeNull();
    expect(await rowsOfRecording(corrupt)).toEqual({ recordings: 0, hashes: 0 });
  }, 120_000);

  it('the same ad uploaded by a second station links to the same recording: no new fingerprints, READY, and nothing shows it is shared', async () => {
    const otherOwner = await testUsers.create();
    const otherClientId = (await (await as(otherOwner))('post', `/api/v1/stations/${otherOwner.stationId}/clients`, { name: 'Brand A' })).body.id as string;
    const rowsBefore = await rowsOfRecording(audio('ad.wav'));
    expect(rowsBefore.recordings).toBe(1);
    const otherAdId = await uploadAd(otherOwner, otherClientId, audio('ad.wav'), 'audio/wav', 'Summer service offer');
    const otherAd = await waitForAd(otherOwner, otherAdId);
    expect(otherAd.status).toBe('READY');
    expect(await rowsOfRecording(audio('ad.wav'))).toEqual(rowsBefore);
    const linked = (await setupClient.query('SELECT count(DISTINCT audio_asset_id)::integer AS recordings FROM app.ads WHERE id = ANY($1)', [[adId, otherAdId]])).rows[0];
    expect(linked.recordings).toBe(1);

    // Each station sees only its own ad, with exactly the fields of an unshared one.
    const firstAd = (await (await as(owner))('get', `/api/v1/stations/${owner.stationId}/ads/${adId}`)).body;
    expect(Object.keys(otherAd).sort()).toEqual(Object.keys(firstAd).sort());
    expect(JSON.stringify(otherAd)).not.toMatch(/asset|hash|shared|fingerprint/i);
    expect((await (await as(otherOwner))('get', `/api/v1/stations/${otherOwner.stationId}/ads/${adId}`)).status).toBe(404);
    // Each station's list holds only its own copy and says nothing of the other; neither can reach the other's ad.
    for (const [user, ownAdId, otherStationsAdId] of [[owner, adId, otherAdId], [otherOwner, otherAdId, adId]] as const) {
      const send = await as(user);
      const list = await send('get', `/api/v1/stations/${user.stationId}/ads?view=all`);
      expect(list.status).toBe(200);
      const listedIds = (list.body.ads as Array<{ id: string }>).map((listed) => listed.id);
      expect(listedIds).toContain(ownAdId);
      expect(listedIds).not.toContain(otherStationsAdId);
      expect(JSON.stringify(list.body)).not.toMatch(/asset|hash|shared|fingerprint/i);
      expect((await send('put', `/api/v1/stations/${user.stationId}/ads/${otherStationsAdId}/card`, CALL_CARD)).status).toBe(404);
      expect((await send('get', `/api/v1/stations/${user.stationId}/ads/${otherStationsAdId}/history`)).status).toBe(404);
    }
  }, 120_000);

  it('outside its schedule the clip gets the client’s default card', async () => {
    const send = await as(owner);
    const defaultCardId = randomUUID();
    const defaultCard = { schema_version: 1, layout: 'VERTICAL_STACK', actions: [{ type: 'LINK', id: '0192a6c4-0000-4000-8000-0000000000e1', label: 'Visit us', style: 'PRIMARY', url: 'https://brand.co.zm/' }] };
    await setupClient.query('INSERT INTO app.action_cards (id, station_id, client_id, schema_version, content) VALUES ($1, $2, $3, 1, $4)', [defaultCardId, owner.stationId, clientId, defaultCard]);
    await setupClient.query('UPDATE app.clients SET default_action_card_id = $2 WHERE id = $1', [clientId, defaultCardId]);
    // The schedule now starts tomorrow, so the ad is not on air now.
    expect((await send('put', `/api/v1/stations/${owner.stationId}/ads/${adId}/schedule`, { startsOn: todayAtStation(1), endsOn: todayAtStation(27), timeWindows: allDay, gracePeriodMinutes: 10 })).status).toBe(200);

    const response = await recognize(client, { installToken: await newInstallToken(), audio: audio('clip.m4a') });
    // Two stations own this recording now (the shared upload above has no live campaign, so only this one counts).
    expect(response.body).toMatchObject({ status: 'MATCH', result: { kind: 'CLIENT_DEFAULT', card: { actions: defaultCard.actions } } });
  }, 60_000);

  it('leaves no listener audio and no recognize job in Valkey, and nothing in the workers’ temporary folders', async () => {
    const keyValueStore = new Redis(process.env.KEY_VALUE_STORE_URL as string);
    try {
      const clipSample = audio('clip.m4a').toString('base64').slice(100, 200);
      let cursor = '0';
      const values: string[] = [];
      const jobKeys: string[] = [];
      do {
        const [nextCursor, keys] = await keyValueStore.scan(cursor, 'MATCH', `${queuePrefix()}:*`, 'COUNT', 500);
        for (const key of keys) {
          const type = await keyValueStore.type(key);
          if (/:recognize:[0-9a-f-]{36}$/.test(key)) jobKeys.push(key);
          if (type === 'string') values.push(String(await keyValueStore.get(key)));
          if (type === 'hash') values.push(JSON.stringify(await keyValueStore.hgetall(key)));
          if (type === 'list') values.push(JSON.stringify(await keyValueStore.lrange(key, 0, -1)));
          if (type === 'stream') values.push(JSON.stringify(await keyValueStore.xrange(key, '-', '+')));
          if (type === 'zset') values.push(JSON.stringify(await keyValueStore.zrange(key, 0, -1)));
        }
        cursor = nextCursor;
      } while (cursor !== '0');
      expect(jobKeys).toEqual([]);
      expect(values.join('\n')).not.toContain(clipSample);
      expect(values.join('\n')).not.toMatch(/X-Amz-Signature/);
    } finally {
      await keyValueStore.quit();
    }
    for (const worker of [ingestWorker, recognizeWorker]) expect(readdirSync(worker.temporaryDirectory)).toEqual([]);
    expect(JSON.stringify([...ingestWorker.logLines, ...recognizeWorker.logLines])).not.toContain(audio('clip.m4a').toString('base64').slice(100, 200));
  });

  it('with the recognize worker stopped: first 503 RECOGNITION_TIMEOUT (its heartbeat is still fresh), whose request id finds the full detail in the log; then 503 RECOGNITION_BUSY at once', async () => {
    await recognizeWorker.stop();
    const installToken = await newInstallToken();
    const startedAt = Date.now();
    const timedOut = await recognize(client, { installToken, audio: audio('clip.m4a') });
    expect(timedOut.status).toBe(503);
    expect(timedOut.body.error.code).toBe('RECOGNITION_TIMEOUT');
    expect(Date.now() - startedAt).toBeLessThan(3_500);
    assertNoInternalDetails(timedOut.body);
    expect(JSON.stringify(timedOut.body)).not.toMatch(/queue|worker|valkey|redis|127\.0\.0\.1/i);
    await waitForLogWrites();
    const logLine = testApplication.logs.find((line) => line.requestId === timedOut.headers['x-request-id'] && line.level === 50);
    const loggedStack = String((logLine?.err as { stack?: string } | undefined)?.stack);
    expect(loggedStack).toContain('no answer from a recognize worker within 2500 ms');
    expect(loggedStack).toMatch(/\n\s+at /);

    // Node's own wait rejects too, rather than hanging (S3-TESTS-02).
    await expect(testApplication.application.get(RecognizeQueue).addAndWait(randomUUID(), { request_id: 'stopped', audio_base64: 'AAAA', codec: 'aac', deadline_epoch_milliseconds: Date.now() + 500, fingerprint_version: FINGERPRINT_VERSION }, 500)).rejects.toBeInstanceOf(RecognizeWaitTimedOut);

    const keyValueStore = new Redis(process.env.KEY_VALUE_STORE_URL as string);
    await keyValueStore.del(workerHeartbeatKey(queuePrefix(), 'recognize'));
    await keyValueStore.quit();
    await testApplication.application.get(RecognizeQueue).refreshAdmission();
    const busyStartedAt = Date.now();
    const busy = await recognize(client, { installToken, audio: audio('clip.m4a') });
    expect(busy.status).toBe(503);
    expect(busy.body.error.code).toBe('RECOGNITION_BUSY');
    expect(Date.now() - busyStartedAt).toBeLessThan(1_000);
  }, 60_000);
});
