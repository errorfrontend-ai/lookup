import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { RecognitionService } from '../src/features/recognition/recognition.service.js';
import { RecognizeQueue } from '../src/infrastructure/job-queues/recognize-queue.js';
import { databaseSetupClient } from './support/database-clients.js';
import {
  AiringAds,
  defaultRecognizeFields,
  FakeRecognizeWorker,
  match,
  noMatch,
  recognize,
  recognizeJobCount,
  registerInstall,
  safeActionCard,
  sendRecognizeAndStall,
} from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/** This file's settings, changed from the defaults where a case needs it; each one is read from the configuration. */
const DEFERRED_PER_INSTALL_PER_HOUR = 4;
const IN_FLIGHT_LIMIT = 4;
const DEFERRED_IN_FLIGHT_LIMIT = 2;
const BODY_READ_MILLISECONDS = 4_000;
const REPLAYS_PER_INSTALL_PER_HOUR = 60;
const LIVE_PER_MINUTE = 6;

const keyValueStoreUrl = () => process.env.KEY_VALUE_STORE_URL as string;
const queuePrefix = () => process.env.QUEUE_KEY_PREFIX as string;

/**
 * Clips sent later (P4 design §5.2, §5.3; contract §1.2): the deferred flag and the time rules, the deferred and replay
 * allowances, the deferred share of the places in flight, shedding with a jittered Retry-After, and the 5-second wait,
 * against the real API, database and queue with a stand-in worker. The deferred allowance is 4 an hour here (10 by
 * default) and the places 4 and 2 (32 and 16), which also shows the configured values are the ones used.
 */
describe('POST /api/v1/recognize, clips sent later', () => {
  let testApplication: TestApplication;
  let server: http.Server;
  let setupClient: pg.Client;
  let worker: FakeRecognizeWorker;
  let recognizeQueue: RecognizeQueue;
  let airingAds: AiringAds;
  const installRows: string[] = [];
  const client = () => supertest(server);

  async function newInstall() {
    const install = await registerInstall(client);
    const hash = testApplication.application.get(InstallTokens).hashInstallId(install.installId);
    const rowId = (await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash])).rows[0].id as string;
    installRows.push(rowId);
    return { ...install, rowId };
  }

  /** Fields of a clip the outbox sends: heard `heardSecondsAgo` before it is sent now, with the flag as given. */
  const clipFields = (options: { deferred: boolean; heardSecondsAgo?: number; key?: string }) => {
    const sentAt = Date.now();
    return {
      ...defaultRecognizeFields(),
      idempotency_key: options.key ?? randomUUID(),
      captured_at: new Date(sentAt - (options.heardSecondsAgo ?? 9) * 1_000).toISOString(),
      sent_at: new Date(sentAt).toISOString(),
      is_deferred: options.deferred ? 'true' : 'false',
    };
  };
  const sendDeferred = (installToken: string, key?: string) => recognize(client, { installToken, fields: clipFields({ deferred: true, key }) });
  const sendLive = (installToken: string, key?: string) => recognize(client, { installToken, fields: clipFields({ deferred: false, key }) });

  const eventRow = async (recognitionId: string) =>
    (await setupClient.query('SELECT is_deferred, captured_at, received_at, client_captured_at, attempt_count, outcome FROM app.recognition_events WHERE id = $1', [recognitionId]))
      .rows[0] as { is_deferred: boolean; captured_at: Date; received_at: Date; client_captured_at: Date; attempt_count: number; outcome: string };

  const expectDeferredRetryAfter = (headers: Record<string, unknown>) => {
    const retryAfter = Number(headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(60);
    expect(retryAfter).toBeLessThanOrEqual(300);
    return retryAfter;
  };

  /** Waits until this instance holds the given number of places (all, and deferred). */
  async function waitForPlaces(all: number, deferred: number): Promise<void> {
    const service = testApplication.application.get(RecognitionService);
    for (let waited = 0; waited < 150 && (service.inFlightCount !== all || service.deferredInFlightCount !== deferred); waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect([service.inFlightCount, service.deferredInFlightCount]).toEqual([all, deferred]);
  }

  beforeAll(async () => {
    const config = {
      ...loadAppConfig(),
      RECOGNITIONS_DEFERRED_PER_INSTALL_PER_HOUR: DEFERRED_PER_INSTALL_PER_HOUR,
      RECOGNITIONS_IN_FLIGHT_LIMIT: IN_FLIGHT_LIMIT,
      RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT: DEFERRED_IN_FLIGHT_LIMIT,
      RECOGNIZE_BODY_READ_MILLISECONDS: BODY_READ_MILLISECONDS,
      RECOGNITION_REPLAYS_PER_INSTALL_PER_HOUR: REPLAYS_PER_INSTALL_PER_HOUR,
    };
    testApplication = await createTestApplication({ overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config) });
    server = testApplication.application.getHttpServer() as http.Server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    setupClient = databaseSetupClient();
    await setupClient.connect();
    airingAds = new AiringAds(setupClient);
    recognizeQueue = testApplication.application.get(RecognizeQueue);
    worker = new FakeRecognizeWorker(keyValueStoreUrl(), queuePrefix());
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();
  });
  beforeEach(async () => {
    worker.answer = () => noMatch();
    worker.receivedJobs.length = 0;
    worker.resume();
    testApplication.application.get(RecognitionService).circuitBreaker.close();
    testApplication.application.get(RecognitionService).deferredCircuitBreaker.close();
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();
  });
  afterAll(async () => {
    await worker.close();
    await airingAds.removeAll(installRows);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRows]);
    await setupClient.end();
    await testApplication.close();
  });

  // ---- the flag and the two times --------------------------------------------------------------------

  it('P4-DEFERRED-01: a send the app flags as deferred, with a fresh capture time, is stored and answered as deferred', async () => {
    const { installToken } = await newInstall();
    const response = await recognize(client, { installToken, fields: clipFields({ deferred: true, heardSecondsAgo: 9 }) });
    expect(response.status).toBe(200);
    expect(response.body.is_deferred).toBe(true);
    expect((await eventRow(response.body.recognition_id)).is_deferred).toBe(true);
  });

  it('P4-DEFERRED-02: unflagged, a clip that arrives 121 seconds after it was heard is deferred and one at 119 seconds is not; the answer and the row agree', async () => {
    const { installToken } = await newInstall();
    for (const [heardSecondsAgo, isDeferred] of [[121, true], [119, false]] as const) {
      const response = await recognize(client, { installToken, fields: clipFields({ deferred: false, heardSecondsAgo }) });
      expect(response.status).toBe(200);
      expect(response.body.is_deferred, String(heardSecondsAgo)).toBe(isDeferred);
      expect((await eventRow(response.body.recognition_id)).is_deferred, String(heardSecondsAgo)).toBe(isDeferred);
    }
  });

  it('P4-TIMERULE-01: a clip heard 3 hours before it was sent keeps both times, about 3 hours apart', async () => {
    const { installToken } = await newInstall();
    const response = await recognize(client, { installToken, fields: clipFields({ deferred: true, heardSecondsAgo: 3 * 3_600 }) });
    expect(response.status).toBe(200);
    const row = await eventRow(response.body.recognition_id);
    const apart = row.received_at.getTime() - row.captured_at.getTime();
    expect(Math.abs(apart - 3 * 3_600_000)).toBeLessThan(2_000);
    expect(new Date(response.body.captured_at).getTime()).toBe(row.captured_at.getTime());
  });

  it('P4-CLOCK-01, -02: a phone 3 hours slow is judged against the window it was really heard in, and stored within seconds of the true time', async () => {
    // On air from an hour ago to an hour from now (UTC); three hours ago it was not, and the client's usual card would show.
    const clock = (moment: number) => new Date(moment).toISOString().slice(11, 16);
    const ad = await airingAds.create({
      timeZone: 'UTC',
      windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: clock(Date.now() - 3_600_000), to: clock(Date.now() + 3_600_000) }],
      card: safeActionCard({ firstNumber: 101 }),
      defaultCard: safeActionCard({ firstNumber: 201 }),
    });
    worker.answer = () => match(ad.audioAssetNumber);
    const { installToken } = await newInstall();
    const now = Date.now();
    const slow = 3 * 3_600_000;
    const response = await recognize(client, {
      installToken,
      fields: { ...defaultRecognizeFields(), captured_at: new Date(now - slow - 9_000).toISOString(), sent_at: new Date(now - slow).toISOString(), is_deferred: 'true' },
    });
    expect(response.body).toMatchObject({ status: 'MATCH', result: { kind: 'CAMPAIGN' } });
    const row = await eventRow(response.body.recognition_id);
    expect(Math.abs(row.captured_at.getTime() - (now - 9_000))).toBeLessThan(2_000);
    expect(row.client_captured_at.getTime()).toBe(now - slow - 9_000);
  });

  it('P4-CLOCK-07: the same expired clip sent twice gets 422 CAPTURE_EXPIRED both times, and nothing is queued or stored', async () => {
    const { installToken, rowId } = await newInstall();
    const fields = clipFields({ deferred: true, heardSecondsAgo: 25 * 3_600 });
    const jobsBefore = await recognizeJobCount(keyValueStoreUrl(), queuePrefix());
    for (let sent = 0; sent < 2; sent += 1) {
      const response = await recognize(client, { installToken, fields });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('CAPTURE_EXPIRED');
    }
    expect(await recognizeJobCount(keyValueStoreUrl(), queuePrefix())).toBe(jobsBefore);
    expect(worker.receivedJobs).toHaveLength(0);
    expect((await setupClient.query('SELECT count(*)::integer AS stored FROM app.recognition_events WHERE listener_install_id = $1', [rowId])).rows[0].stored).toBe(0);
  });

  it('P4-CLOCK-08: at exactly 24 hours old and exactly 2 minutes ahead a clip is taken and stored; a millisecond past either is a 422, never a 500', async () => {
    const { installToken } = await newInstall();
    // How old a clip is depends only on its two phone times: received − (captured + received − sent) = sent − captured.
    const sentAt = Date.now();
    const at = (capturedOffsetMilliseconds: number) => ({
      ...defaultRecognizeFields(),
      captured_at: new Date(sentAt + capturedOffsetMilliseconds).toISOString(),
      sent_at: new Date(sentAt).toISOString(),
      is_deferred: 'true',
    });
    const oldest = await recognize(client, { installToken, fields: at(-86_400_000) });
    expect(oldest.status, JSON.stringify(oldest.body)).toBe(200);
    expect((await recognize(client, { installToken, fields: at(-86_400_001) })).body.error.code).toBe('CAPTURE_EXPIRED');
    const furthestAhead = await recognize(client, { installToken, fields: at(120_000) });
    expect(furthestAhead.status, JSON.stringify(furthestAhead.body)).toBe(200);
    expect((await recognize(client, { installToken, fields: at(120_001) })).body.error.code).toBe('CAPTURE_TIME_INVALID');
    for (const stored of [oldest, furthestAhead]) expect((await eventRow(stored.body.recognition_id)).outcome).toBe('NO_MATCH');
  });

  it('P4-IDEMPOTENCY-22: a clip that went Busy as a live send and is then sent from the outbox is stored and answered as deferred', async () => {
    const { installToken } = await newInstall();
    const key = randomUUID();
    await worker.stopHeartbeat();
    await recognizeQueue.refreshAdmission();
    const busy = await sendLive(installToken, key);
    expect(busy.status).toBe(503);
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();
    const fromOutbox = await sendDeferred(installToken, key);
    expect(fromOutbox.status).toBe(200);
    expect(fromOutbox.body.is_deferred).toBe(true);
    const row = await eventRow(fromOutbox.body.recognition_id);
    expect(row).toMatchObject({ is_deferred: true, attempt_count: 2, outcome: 'NO_MATCH' });
  });

  // ---- the allowances ----------------------------------------------------------------------------------

  it('P4-DEFERRED-03, -04, -10: deferred sends have their own allowance (4 an hour here): the 5th new key gets 429 while a live send goes on, and the reverse', async () => {
    const outbox = await newInstall();
    for (let sent = 0; sent < DEFERRED_PER_INSTALL_PER_HOUR; sent += 1) expect((await sendDeferred(outbox.installToken)).status).toBe(200);
    const refused = await sendDeferred(outbox.installToken);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatchObject({ code: 'RATE_LIMITED', request_id: refused.headers['x-request-id'] });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(3_600);
    expect((await sendLive(outbox.installToken)).status).toBe(200);

    const listener = await newInstall();
    for (let sent = 0; sent < LIVE_PER_MINUTE; sent += 1) expect((await sendLive(listener.installToken)).status).toBe(200);
    expect((await sendLive(listener.installToken)).status).toBe(429);
    expect((await sendDeferred(listener.installToken)).status).toBe(200);
  });

  it('P4-DEFERRED-14: a key resent after a 503 counts against the replay allowance, not the deferred one, until its fifth attempt', async () => {
    const { installToken } = await newInstall();
    const key = randomUUID();
    await worker.stopHeartbeat();
    await recognizeQueue.refreshAdmission();
    // The first send counts (1 of 4); the three resends of the held key do not.
    for (let attempt = 1; attempt <= 4; attempt += 1) expect((await sendDeferred(installToken, key)).status).toBe(503);
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();
    for (let sent = 1; sent < DEFERRED_PER_INSTALL_PER_HOUR; sent += 1) expect((await sendDeferred(installToken)).status).toBe(200);
    // The held key has had 4 attempts: its 5th is still exempt. Its 6th (after 5 attempts) counts like any new clip.
    expect((await sendDeferred(installToken, key)).status).toBe(200);
    expect((await setupClient.query('SELECT attempt_count FROM app.recognition_events WHERE listener_install_id = ANY($1) AND idempotency_key = $2', [installRows, key])).rows[0].attempt_count).toBe(5);
    expect((await sendDeferred(installToken, key)).status).toBe(429);
    expect((await sendDeferred(installToken)).status).toBe(429);
  });

  it('P4-DEFERRED-14: replays of a finished key count against the replay allowance: the 61st send of held keys in an hour gets 429 with the seconds left, and the live allowance is untouched', async () => {
    const { installToken } = await newInstall();
    const fields = clipFields({ deferred: false });
    const first = await recognize(client, { installToken, fields });
    expect(first.status).toBe(200);
    for (let replay = 1; replay <= REPLAYS_PER_INSTALL_PER_HOUR; replay += 1) {
      const again = await recognize(client, { installToken, fields: { ...fields, sent_at: new Date().toISOString() } });
      expect(again.status, `replay ${replay}`).toBe(200);
      expect(again.body.recognition_id).toBe(first.body.recognition_id);
    }
    const refused = await recognize(client, { installToken, fields: { ...fields, sent_at: new Date().toISOString() } });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(3_500);
    expect(worker.receivedJobs).toHaveLength(1);
    // The first send was this minute's only live clip: five more go through.
    for (let sent = 1; sent < LIVE_PER_MINUTE; sent += 1) expect((await sendLive(installToken)).status).toBe(200);
  });

  // ---- shedding and places in flight -------------------------------------------------------------------

  it('P4-DEFERRED-05: with the queue depth between the deferred limit (20) and the live limit (50), a deferred send gets 503 and a live one is processed', async () => {
    const { installToken } = await newInstall();
    const depth = vi.spyOn(recognizeQueue, 'admissionState').mockReturnValue({ waitingJobCount: 30, isWorkerAlive: true });
    try {
      const deferred = await sendDeferred(installToken);
      expect(deferred.status).toBe(503);
      expect(deferred.body.error.code).toBe('RECOGNITION_BUSY');
      expectDeferredRetryAfter(deferred.headers);
      const live = await sendLive(installToken);
      expect(live.status).toBe(200);
      expect(worker.receivedJobs).toHaveLength(1);
    } finally {
      depth.mockRestore();
    }
    await waitForLogWrites();
    expect(testApplication.logs.lines.some((line) => line.cause === 'queue_too_deep' && line.sendKind === 'deferred')).toBe(true);
  });

  it('P4-ADMISSION-02, P4-DEFERRED-06: fifty deferred sends refused for lack of a deferred place each get a Retry-After within 60–300, not all equal, and none is counted against the listener', async () => {
    const holder = await newInstall();
    const crowd = await newInstall();
    // Two outbox clips stall mid-audio, holding the two deferred places until the read limit ends them.
    const stalled = [1, 2].map(() => sendRecognizeAndStall(server, { installToken: holder.installToken, fields: clipFields({ deferred: true }) }));
    await waitForPlaces(2, 2);
    const retryAfters: number[] = [];
    for (let sent = 0; sent < 50; sent += 1) {
      const refused = await sendDeferred(crowd.installToken);
      expect(refused.status).toBe(503);
      expect(refused.body.error.code).toBe('RECOGNITION_BUSY');
      retryAfters.push(expectDeferredRetryAfter(refused.headers));
    }
    expect(new Set(retryAfters).size).toBeGreaterThan(1);
    // A live clip still finds a place while the deferred ones are full.
    expect((await sendLive(crowd.installToken)).status).toBe(200);
    for (const answer of await Promise.all(stalled)) expect(answer.status).toBe(400);
    await waitForPlaces(0, 0);
    // None of the fifty used the crowd's allowance: all four deferred sends of the hour are still there.
    for (let sent = 0; sent < DEFERRED_PER_INSTALL_PER_HOUR; sent += 1) expect((await sendDeferred(crowd.installToken)).status).toBe(200);
  });

  it('P4-ADMISSION-02, P4-DEFERRED-05: with the deferred places held by jobs a worker keeps, a third deferred send gets 503 while a live send is still admitted', async () => {
    // The worker keeps deferred jobs (their deadline is 5 s away) and answers live ones (2.5 s).
    worker.answer = (data) => (data.deadline_epoch_milliseconds - Date.now() > 3_500 ? { hang: true } : noMatch());
    const outbox = await newInstall();
    const listener = await newInstall();
    // Started now (a supertest request is only sent once something awaits it).
    const held = [1, 2].map(() => sendDeferred(outbox.installToken).then((response) => response));
    await waitForPlaces(2, 2);
    const third = await sendDeferred(outbox.installToken);
    expect(third.status).toBe(503);
    expectDeferredRetryAfter(third.headers);
    const live = await sendLive(listener.installToken);
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    for (const response of await Promise.all(held)) expect(response.status).toBe(503);
    worker.releaseHungJobs();
    await waitForLogWrites();
    expect(testApplication.logs.find((line) => line.requestId === third.headers['x-request-id'] && line.cause === 'too_many_deferred_in_flight')).toBeDefined();
  });

  it('P4-ADMISSION-02: with every place taken, a deferred send refused for lack of a place gets the deferred Retry-After, never the live 10', async () => {
    const holder = await newInstall();
    const outbox = await newInstall();
    const stalled = Array.from({ length: IN_FLIGHT_LIMIT }, () => sendRecognizeAndStall(server, { installToken: holder.installToken, fields: clipFields({ deferred: false }) }));
    await waitForPlaces(IN_FLIGHT_LIMIT, 0);
    const deferred = await sendDeferred(outbox.installToken);
    expect(deferred.status).toBe(503);
    expectDeferredRetryAfter(deferred.headers);
    const live = await sendLive(outbox.installToken);
    expect(live.status).toBe(503);
    expect(live.headers['retry-after']).toBe('10');
    for (const answer of await Promise.all(stalled)) expect(answer.status).toBe(400);
  });

  it('P4-DEFERRED-09: with a worker that never answers, a deferred send gives up after about 5 seconds and a live one after about 2.5', async () => {
    const { installToken } = await newInstall();
    await worker.pause();
    const timed = async (send: () => Promise<supertest.Response>) => {
      const startedAt = Date.now();
      const response = await send();
      return { response, elapsed: Date.now() - startedAt };
    };
    const [deferred, live] = await Promise.all([timed(() => sendDeferred(installToken)), timed(() => sendLive(installToken))]);
    expect(deferred.response.status).toBe(503);
    expect(deferred.response.body.error.code).toBe('RECOGNITION_TIMEOUT');
    expect(deferred.elapsed).toBeGreaterThanOrEqual(5_000);
    expect(deferred.elapsed).toBeLessThan(6_500);
    expectDeferredRetryAfter(deferred.response.headers);
    expect(live.response.status).toBe(503);
    expect(live.response.body.error.code).toBe('RECOGNITION_TIMEOUT');
    expect(live.elapsed).toBeGreaterThanOrEqual(2_500);
    expect(live.elapsed).toBeLessThan(4_000);
    expect(live.response.headers['retry-after']).toBe('5');
    worker.resume();
  });
});
