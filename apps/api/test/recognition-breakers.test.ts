import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { RecognitionService } from '../src/features/recognition/recognition.service.js';
import { RecognizeQueue } from '../src/infrastructure/job-queues/recognize-queue.js';
import { databaseSetupClient } from './support/database-clients.js';
import { FakeRecognizeWorker, noMatch, recognize, registerInstall } from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/** Short waits, so a send with no worker answering times out quickly; the deferred one stays the longer, as configured. */
const LIVE_WAIT_MILLISECONDS = 500;
const DEFERRED_WAIT_MILLISECONDS = 700;

/**
 * Two circuit breakers (P4 design §5.3, P4-D15; P4-ADMISSION-03): deferred sends wait at a lower priority and time out
 * by design under load, so they have their own breaker. Their timeouts never open the live breaker, live admission
 * looks only at the live breaker, deferred admission refuses while either is open, and a clip the worker could not
 * read (INVALID_AUDIO) opens neither.
 */
describe('the live and deferred recognition breakers', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let worker: FakeRecognizeWorker;
  let recognizeQueue: RecognizeQueue;
  let service: RecognitionService;
  const installRows: string[] = [];
  const client = () => supertest(testApplication.application.getHttpServer());

  async function newInstall() {
    const install = await registerInstall(client);
    const hash = testApplication.application.get(InstallTokens).hashInstallId(install.installId);
    installRows.push((await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash])).rows[0].id as string);
    return install;
  }

  const send = (installToken: string, kind: 'live' | 'deferred') => recognize(client, { installToken, fields: { is_deferred: kind === 'deferred' ? 'true' : 'false' } });

  beforeAll(async () => {
    const config = { ...loadAppConfig(), RECOGNITION_WAIT_MILLISECONDS: LIVE_WAIT_MILLISECONDS, RECOGNITION_DEFERRED_WAIT_MILLISECONDS: DEFERRED_WAIT_MILLISECONDS };
    testApplication = await createTestApplication({ overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config) });
    setupClient = databaseSetupClient();
    await setupClient.connect();
    recognizeQueue = testApplication.application.get(RecognizeQueue);
    service = testApplication.application.get(RecognitionService);
    worker = new FakeRecognizeWorker(process.env.KEY_VALUE_STORE_URL as string, process.env.QUEUE_KEY_PREFIX as string);
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();
  });
  beforeEach(async () => {
    worker.answer = () => noMatch();
    worker.resume();
    service.circuitBreaker.close();
    service.deferredCircuitBreaker.close();
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();
  });
  afterAll(async () => {
    await worker.close();
    await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRows]);
    await setupClient.end();
    await testApplication.close();
  });

  it('a clip the worker could not read opens neither breaker, live or deferred', async () => {
    worker.answer = () => ({ fail: 'INVALID_AUDIO' });
    const liveInstall = await newInstall();
    const deferredInstall = await newInstall();
    for (let sent = 0; sent < 6; sent += 1) {
      expect((await send(liveInstall.installToken, 'live')).body.error.code).toBe('INVALID_AUDIO');
      expect((await send(deferredInstall.installToken, 'deferred')).body.error.code).toBe('INVALID_AUDIO');
    }
    expect(service.circuitBreaker.opened).toBe(false);
    expect(service.deferredCircuitBreaker.opened).toBe(false);
    expect(service.circuitBreaker.stats.failures).toBe(0);
    expect(service.deferredCircuitBreaker.stats.failures).toBe(0);
  });

  it('P4-ADMISSION-03: ten deferred sends that time out open the deferred breaker and leave the live one closed with no failure; live clips go on, deferred ones are refused', async () => {
    const outbox = await newInstall();
    const listener = await newInstall();
    await worker.pause();
    const timedOut = await Promise.all(Array.from({ length: 10 }, () => send(outbox.installToken, 'deferred')));
    for (const response of timedOut) expect(response.status).toBe(503);
    expect(service.deferredCircuitBreaker.opened).toBe(true);
    expect(service.circuitBreaker.opened).toBe(false);
    expect(service.circuitBreaker.stats.failures).toBe(0);

    worker.resume();
    const live = await send(listener.installToken, 'live');
    expect(live.status, JSON.stringify(live.body)).toBe(200);

    const refused = await send(listener.installToken, 'deferred');
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('RECOGNITION_BUSY');
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(60);
    expect(retryAfter).toBeLessThanOrEqual(300);
    await waitForLogWrites();
    expect(testApplication.logs.find((line) => line.requestId === refused.headers['x-request-id'] && line.cause === 'deferred_breaker_open')).toBeDefined();
  });

  it('P4-ADMISSION-03: a live breaker that opens refuses deferred sends too, since the workers are in trouble for everyone', async () => {
    const install = await newInstall();
    service.circuitBreaker.open();
    const jobsBefore = worker.receivedJobs.length;
    const deferred = await send(install.installToken, 'deferred');
    expect(deferred.status).toBe(503);
    expect(deferred.body.error.code).toBe('RECOGNITION_BUSY');
    expect(Number(deferred.headers['retry-after'])).toBeGreaterThanOrEqual(60);
    const live = await send(install.installToken, 'live');
    expect(live.status).toBe(503);
    expect(live.headers['retry-after']).toBe('10');
    expect(worker.receivedJobs.length).toBe(jobsBefore);
    expect(service.deferredCircuitBreaker.opened).toBe(false);
  });
});
