import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAXIMUM_CLIP_BYTES } from '@lookup/contracts';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { RecognitionService } from '../src/features/recognition/recognition.service.js';
import { RecognizeQueue } from '../src/infrastructure/job-queues/recognize-queue.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import {
  aacClipBytes,
  defaultRecognizeFields,
  FakeRecognizeWorker,
  noMatch,
  randomClientAddress,
  recognize,
  sendRecognizeAndStall,
  sendRecognizeInChunks,
} from './support/listener-test-kit.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const MINIMUM_APP_VERSION = '0.2.0';
const RECOGNITIONS_PER_ADDRESS_PER_MINUTE = 5;
const IN_FLIGHT_LIMIT = 2;
const LIVE_PER_MINUTE = 6;
/** Over the 256 KiB clip limit, while the whole body stays under its own limit, so it is the audio part that is refused. */
const OVER_THE_CLIP_LIMIT = MAXIMUM_CLIP_BYTES + 8_000;

/**
 * The order of checks on POST /api/v1/recognize (P4 design §5.2, contract Correction 1; S3-REQUEST-13 re-run,
 * P4-DEFERRED-13, P4-IDEMPOTENCY-02, -21): request id; the listener ceiling; the install token (401); the update gate
 * (426); the recognize per-address limit (429); the body's type and declared length (415, 413); when the text fields
 * have arrived, the place in flight (503) and the per-install allowance (429); invalid fields (400); the audio part
 * (413); its first bytes (415); the capture time (422); the claim (409 or a replay); admission (503). Each case sends
 * a request that breaks two rules and shows the earlier one answers.
 */
describe('POST /api/v1/recognize, the order of checks', () => {
  let testApplication: TestApplication;
  let server: http.Server;
  let setupClient: pg.Client;
  let worker: FakeRecognizeWorker;
  let recognizeQueue: RecognizeQueue;
  const installRows: string[] = [];
  const client = () => supertest(server);

  async function newInstall(appVersion = '1.0.0') {
    const installId = randomUUID();
    const response = await client()
      .post('/api/v1/installs')
      .set('X-Forwarded-For', randomClientAddress())
      .send({ install_id: installId, platform: 'ANDROID', app_version: appVersion });
    expect(response.status).toBe(200);
    const hash = testApplication.application.get(InstallTokens).hashInstallId(installId);
    const rowId = (await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash])).rows[0].id as string;
    installRows.push(rowId);
    return { installId, installToken: response.body.install_token as string, rowId };
  }

  const expectRefusal = (response: { status: number; body: unknown }, httpStatus: number, code: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(httpStatus);
    expect(assertErrorEnvelope(response.body).error.code).toBe(code);
  };

  /** Uses up an install's live minute: six clips, then the seventh is refused. */
  async function useUpLiveMinute(installToken: string) {
    for (let sent = 0; sent < LIVE_PER_MINUTE; sent += 1) expect((await recognize(client, { installToken })).status).toBe(200);
    expectRefusal(await recognize(client, { installToken }), 429, 'RATE_LIMITED');
  }

  /**
   * Holds every place in flight with clips that stall mid-audio, and returns once they are held; `answers` resolves
   * to their answers once the read limit ends them.
   */
  async function holdEveryPlace() {
    const holder = await newInstall();
    const stalled = Array.from({ length: IN_FLIGHT_LIMIT }, () => sendRecognizeAndStall(server, { installToken: holder.installToken, fields: defaultRecognizeFields() }));
    const service = testApplication.application.get(RecognitionService);
    for (let waited = 0; waited < 100 && service.inFlightCount < IN_FLIGHT_LIMIT; waited += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    if (service.inFlightCount < IN_FLIGHT_LIMIT) {
      const answers = await Promise.all(stalled);
      throw new Error(`the stalled clips held ${service.inFlightCount} places; they were answered ${answers.map((answer) => `${answer.status} ${answer.body}`).join(', ')}`);
    }
    return { answers: Promise.all(stalled) };
  }

  beforeAll(async () => {
    const config = {
      ...loadAppConfig(),
      LISTENER_MINIMUM_APP_VERSION: MINIMUM_APP_VERSION,
      RECOGNITIONS_PER_CLIENT_ADDRESS_PER_MINUTE: RECOGNITIONS_PER_ADDRESS_PER_MINUTE,
      RECOGNITIONS_IN_FLIGHT_LIMIT: IN_FLIGHT_LIMIT,
      RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT: 1,
      RECOGNIZE_BODY_READ_MILLISECONDS: 2_500,
    };
    testApplication = await createTestApplication({ overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config) });
    server = testApplication.application.getHttpServer() as http.Server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    setupClient = databaseSetupClient();
    await setupClient.connect();
    recognizeQueue = testApplication.application.get(RecognizeQueue);
    worker = new FakeRecognizeWorker(process.env.KEY_VALUE_STORE_URL as string, process.env.QUEUE_KEY_PREFIX as string);
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();
  });
  beforeEach(async () => {
    worker.answer = () => noMatch();
    worker.receivedJobs.length = 0;
    testApplication.application.get(RecognitionService).circuitBreaker.close();
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

  it('the token before the update gate, the update gate before the per-address limit, and that limit before the body’s type', async () => {
    const current = await newInstall();
    const old = await newInstall('0.1.0');
    expectRefusal(await recognize(client, { installToken: `${old.installToken}x` }), 401, 'INSTALL_TOKEN_INVALID');

    const address = randomClientAddress();
    for (let sent = 0; sent < RECOGNITIONS_PER_ADDRESS_PER_MINUTE; sent += 1) {
      expect((await recognize(client, { installToken: current.installToken, clientAddress: address, fields: { codec: 'not-a-codec' } })).status).toBe(400);
    }
    expectRefusal(await recognize(client, { installToken: old.installToken, clientAddress: address }), 426, 'APP_UPDATE_REQUIRED');
    const json = await client().post('/api/v1/recognize').set('X-Forwarded-For', address).set('Authorization', `Bearer ${current.installToken}`).send(defaultRecognizeFields());
    expectRefusal(json, 429, 'RATE_LIMITED');
  });

  it('the body’s type and declared length before the per-install allowance: with the minute used up, JSON is 415 and an oversized body 413', async () => {
    const install = await newInstall();
    await useUpLiveMinute(install.installToken);
    const json = await client().post('/api/v1/recognize').set('X-Forwarded-For', randomClientAddress()).set('Authorization', `Bearer ${install.installToken}`).send(defaultRecognizeFields());
    expectRefusal(json, 415, 'UNSUPPORTED_MEDIA_TYPE');
    const oversized = await sendRecognizeInChunks(server, { installToken: install.installToken, chunk: Buffer.alloc(1_024), chunkCount: 1, declaredLength: 400_000 });
    expectRefusal({ status: oversized.status, body: JSON.parse(oversized.body) }, 413, 'PAYLOAD_TOO_LARGE');
  });

  it('the place in flight before the per-install allowance: with every place taken, an install whose minute is used up gets 503, not 429', async () => {
    const install = await newInstall();
    await useUpLiveMinute(install.installToken);
    const held = await holdEveryPlace();
    const busy = await recognize(client, { installToken: install.installToken });
    expectRefusal(busy, 503, 'RECOGNITION_BUSY');
    expect(busy.headers['retry-after']).toBe('10');
    for (const answer of await held.answers) expect(answer.status).toBe(400);
  });

  it('the per-install allowance before the fields are judged: with the minute used up, invalid fields get 429, not 400', async () => {
    const install = await newInstall();
    await useUpLiveMinute(install.installToken);
    expectRefusal(await recognize(client, { installToken: install.installToken, fields: { codec: 'not-a-codec' } }), 429, 'RATE_LIMITED');
  });

  it('the fields before the audio: invalid fields with a clip over the clip limit (but a body within its own) get 400 naming the field, not 413', async () => {
    const install = await newInstall();
    const response = await recognize(client, { installToken: install.installToken, fields: { codec: 'not-a-codec' }, audio: aacClipBytes(OVER_THE_CLIP_LIMIT) });
    expectRefusal(response, 400, 'VALIDATION_FAILED');
    expect(response.body.error.fields).toEqual([{ path: 'codec', code: 'invalid_value' }]);
  });

  it('a clip refused from its fields leaves the phone’s kept-alive connection ready: its next request is answered at once on the same connection', async () => {
    const install = await newInstall();
    // One connection kept alive, as the app's client keeps one: the second request must go on the same socket.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const { port } = server.address() as AddressInfo;
      const boundary = `----lookup-test-${randomUUID()}`;
      const fields = { ...defaultRecognizeFields(), codec: 'not-a-codec' };
      const body = Buffer.concat([
        ...Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="clip.m4a"\r\nContent-Type: audio/mp4\r\n\r\n`),
        aacClipBytes(200_000),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const send = (options: http.RequestOptions, payload?: Buffer) =>
        new Promise<{ status: number; isReusedSocket: boolean }>((resolve, reject) => {
          const request = http.request({ host: '127.0.0.1', port, agent, ...options }, (response) => {
            response.resume();
            response.on('end', () => resolve({ status: response.statusCode ?? 0, isReusedSocket: request.reusedSocket }));
          });
          request.setTimeout(5_000, () => request.destroy(new Error('no answer within 5 seconds')));
          request.on('error', reject);
          request.end(payload);
        });
      const refused = await send(
        {
          method: 'POST',
          path: '/api/v1/recognize',
          headers: {
            Authorization: `Bearer ${install.installToken}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(body.length),
            'X-Forwarded-For': randomClientAddress(),
          },
        },
        body,
      );
      expect(refused.status).toBe(400);
      const next = await send({ method: 'GET', path: '/api/v1/health' });
      expect(next).toEqual({ status: 200, isReusedSocket: true });
    } finally {
      agent.destroy();
    }
  });

  it('then the audio part, its first bytes and the capture time, in that order', async () => {
    const install = await newInstall();
    const expired = { captured_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), sent_at: new Date().toISOString() };
    const notARecording = Buffer.alloc(OVER_THE_CLIP_LIMIT, 7);
    expectRefusal(await recognize(client, { installToken: install.installToken, fields: expired, audio: notARecording }), 413, 'PAYLOAD_TOO_LARGE');
    expectRefusal(await recognize(client, { installToken: install.installToken, fields: expired, audio: Buffer.from('not a recording at all') }), 415, 'UNSUPPORTED_MEDIA_TYPE');
    expectRefusal(await recognize(client, { installToken: install.installToken, fields: expired }), 422, 'CAPTURE_EXPIRED');
    expect(worker.receivedJobs).toHaveLength(0);
  });

  it('P4-DEFERRED-13: an audio part before the text fields, or any part after the audio, is 400 audio_part_before_fields', async () => {
    const install = await newInstall();
    const fields = defaultRecognizeFields();
    let audioFirst = client().post('/api/v1/recognize').set('X-Forwarded-For', randomClientAddress()).set('Authorization', `Bearer ${install.installToken}`);
    audioFirst = audioFirst.attach('audio', aacClipBytes(), { filename: 'clip.m4a', contentType: 'audio/mp4' });
    for (const [name, value] of Object.entries(fields)) audioFirst = audioFirst.field(name, value);
    const answer = await audioFirst;
    expectRefusal(answer, 400, 'VALIDATION_FAILED');
    expect(answer.body.error.fields).toEqual([{ path: 'audio', code: 'audio_part_before_fields' }]);

    let partAfter = client().post('/api/v1/recognize').set('X-Forwarded-For', randomClientAddress()).set('Authorization', `Bearer ${install.installToken}`);
    for (const [name, value] of Object.entries(defaultRecognizeFields())) partAfter = partAfter.field(name, value);
    partAfter = partAfter.attach('audio', aacClipBytes(), { filename: 'clip.m4a', contentType: 'audio/mp4' }).field('station_hint', randomUUID());
    const after = await partAfter;
    expectRefusal(after, 400, 'VALIDATION_FAILED');
    expect(after.body.error.fields).toEqual([{ path: 'audio', code: 'audio_part_before_fields' }]);
    expect(worker.receivedJobs).toHaveLength(0);
  });

  it('a required field that never arrives is answered with the contract’s issue once the body is read; no audio part at all names the audio', async () => {
    const install = await newInstall();
    const missing = await recognize(client, { installToken: install.installToken, fields: { codec: undefined } });
    expectRefusal(missing, 400, 'VALIDATION_FAILED');
    expect(missing.body.error.fields).toEqual([{ path: 'codec', code: 'invalid_value' }]);
    const noAudio = await recognize(client, { installToken: install.installToken, audio: null });
    expectRefusal(noAudio, 400, 'VALIDATION_FAILED');
    expect(noAudio.body.error.fields).toEqual([{ path: 'audio', code: 'invalid_type' }]);
  });

  it('a request with no audio part counts against the live allowance like any other: after six in a minute, the seventh clip gets 429', async () => {
    const install = await newInstall();
    for (let sent = 0; sent < LIVE_PER_MINUTE; sent += 1) {
      expectRefusal(await recognize(client, { installToken: install.installToken, audio: null }), 400, 'VALIDATION_FAILED');
    }
    expectRefusal(await recognize(client, { installToken: install.installToken }), 429, 'RATE_LIMITED');
  });

  it('P4-IDEMPOTENCY-02: a repeated key with an invalid body is refused, not replayed; a finished key is replayed while admission refuses new work', async () => {
    const install = await newInstall();
    const fields = defaultRecognizeFields();
    const first = await recognize(client, { installToken: install.installToken, fields });
    expect(first.status).toBe(200);
    expectRefusal(await recognize(client, { installToken: install.installToken, fields: { ...fields, codec: 'not-a-codec' } }), 400, 'VALIDATION_FAILED');
    expectRefusal(await recognize(client, { installToken: install.installToken, fields, audio: Buffer.from('not a recording at all') }), 415, 'UNSUPPORTED_MEDIA_TYPE');

    await worker.stopHeartbeat();
    await recognizeQueue.refreshAdmission();
    const replay = await recognize(client, { installToken: install.installToken, fields });
    expect(replay.status).toBe(200);
    expect(replay.body.recognition_id).toBe(first.body.recognition_id);
    expectRefusal(await recognize(client, { installToken: install.installToken }), 503, 'RECOGNITION_BUSY');
    expect(worker.receivedJobs).toHaveLength(1);
  });

  it('P4-IDEMPOTENCY-21: two sends of one key at the same moment give one worker job, one 200 and one 409 with Retry-After', async () => {
    worker.answer = () => ({ delayMilliseconds: 1_000, answer: noMatch() });
    const install = await newInstall();
    const fields = defaultRecognizeFields();
    const answers = await Promise.all([1, 2].map(() => recognize(client, { installToken: install.installToken, fields }).then((response) => response)));
    expect(answers.map((response) => response.status).sort()).toEqual([200, 409]);
    const inProgress = answers.find((response) => response.status === 409);
    expect(inProgress?.body.error.code).toBe('RECOGNITION_IN_PROGRESS');
    expect(inProgress?.headers['retry-after']).toBe('3');
    expect(worker.receivedJobs).toHaveLength(1);
    const rows = await setupClient.query('SELECT count(*)::integer AS stored FROM app.recognition_events WHERE listener_install_id = $1 AND idempotency_key = $2', [install.rowId, fields.idempotency_key]);
    expect(rows.rows[0].stored).toBe(1);
  });

  it('the claim before admission: a key still being worked on gets 409 even while admission would refuse new work', async () => {
    worker.answer = () => ({ delayMilliseconds: 1_500, answer: noMatch() });
    const install = await newInstall();
    const fields = defaultRecognizeFields();
    const first = recognize(client, { installToken: install.installToken, fields }).then((response) => response);
    for (let waited = 0; waited < 100 && worker.receivedJobs.length === 0; waited += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    await worker.stopHeartbeat();
    await recognizeQueue.refreshAdmission();
    expectRefusal(await recognize(client, { installToken: install.installToken, fields }), 409, 'RECOGNITION_IN_PROGRESS');
    expect((await first).status).toBe(200);
  });
});
