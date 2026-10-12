import { randomInt, randomUUID } from 'node:crypto';
import type http from 'node:http';
import { RECOGNIZE_QUEUE_NAME, RecognizeResponse } from '@lookup/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { RecognitionService } from '../src/features/recognition/recognition.service.js';
import { ACCESS_TOKEN_COOKIE } from '../src/features/authentication/session-cookies.js';
import { RecognizeQueue } from '../src/infrastructure/job-queues/recognize-queue.js';
import { KEY_VALUE_STORE } from '../src/infrastructure/key-value-store/key-value-store.module.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope, assertNoInternalDetails } from './support/internal-detail-patterns.js';
import {
  aacClipBytes,
  AiringAds,
  CALL_CARD,
  defaultRecognizeFields,
  FakeRecognizeWorker,
  match,
  noMatch,
  recognize,
  recognizeJobCount,
  registerInstall,
  sendRecognizeAndStall,
  sendRecognizeInChunks,
} from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { PORTAL_ORIGIN } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * POST /api/v1/recognize against the real API, database and Valkey, with a stand-in worker that
 * answers what each test says (the real Python worker is in fingerprint-workers.test.ts). This file
 * runs with low limits to test them quickly: 3 clips waiting, 30 requests a minute per address, 4
 * recognitions at once, 1.5 seconds to receive a clip.
 */
describe('POST /api/v1/recognize', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let airingAds: AiringAds;
  let worker: FakeRecognizeWorker;
  let recognizeQueue: RecognizeQueue;
  let server: http.Server;
  const installRows: string[] = [];
  const client = () => supertest(testApplication.application.getHttpServer());
  const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  const keyValueStoreUrl = () => process.env.KEY_VALUE_STORE_URL as string;
  const queuePrefix = () => process.env.QUEUE_KEY_PREFIX as string;

  async function newInstall() {
    const install = await registerInstall(client);
    const hash = testApplication.application.get(InstallTokens).hashInstallId(install.installId);
    const row = await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash]);
    installRows.push(row.rows[0].id as string);
    return { ...install, rowId: row.rows[0].id as string };
  }

  const eventRow = async (recognitionId: string) =>
    (await setupClient.query('SELECT * FROM app.recognition_events WHERE id = $1', [recognitionId])).rows[0] as Record<string, unknown> | undefined;

  beforeAll(async () => {
    process.env.RECOGNITION_QUEUE_DEPTH_LIMIT = '3';
    process.env.RECOGNITIONS_PER_CLIENT_ADDRESS_PER_MINUTE = '30';
    process.env.RECOGNITIONS_IN_FLIGHT_LIMIT = '4';
    process.env.RECOGNIZE_BODY_READ_MILLISECONDS = '1500';
    testApplication = await createTestApplication();
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
    testApplication.application.get(RecognitionService).circuitBreaker.close();
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

  // ---- what reaches the worker, and what comes back ------------------------------------------------
  describe('a clip of an ad that is on air', () => {
    it('answers MATCH with the station, the client, the title and exactly the saved buttons, in the contract’s shape', async () => {
      const ad = await airingAds.create();
      worker.answer = () => match(ad.audioAssetNumber);
      const { installToken } = await newInstall();
      const response = await recognize(client, { installToken });

      expect(response.status).toBe(200);
      expect(RecognizeResponse.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({
        status: 'MATCH',
        request_id: response.headers['x-request-id'],
        is_deferred: false,
        result: {
          kind: 'CAMPAIGN',
          station: { id: ad.stationId, frequency_label: '98.1 FM', city: null, logo: null },
          client: { name: 'Brand A', logo: null },
          title: 'Summer service offer',
          card: { schema_version: 1, layout: 'VERTICAL_STACK', header_image: null, actions: CALL_CARD.actions },
        },
      });
      expect(response.body).not.toHaveProperty('candidates');
    });

    it('records the recognition: install, request id, times, outcome, the match facts, where it resolved, and when it completed', async () => {
      const ad = await airingAds.create();
      worker.answer = () => match(ad.audioAssetNumber, { aligned_hash_count: 61, match_margin: 3.25, match_offset_milliseconds: 4048 });
      const { installToken, rowId } = await newInstall();
      const startedAt = Date.now();
      const response = await recognize(client, { installToken, fields: { clip_duration_milliseconds: '8000' } });
      const requestMilliseconds = Date.now() - startedAt;

      const recognitionId = response.body.recognition_id as string;
      const row = await eventRow(recognitionId);
      expect(row).toMatchObject({
        listener_install_id: rowId,
        request_id: response.headers['x-request-id'],
        outcome: 'MATCH',
        audio_asset_id: ad.audioAssetId,
        station_id: ad.stationId,
        campaign_id: ad.campaignId,
        action_card_id: ad.actionCardId,
        aligned_hash_count: 61,
        match_margin: 3.25,
        match_offset_milliseconds: 4048,
        clip_duration_milliseconds: 8000,
        fingerprint_version: 2,
        attempt_count: 1,
      });
      expect(row?.completed_at).toBeInstanceOf(Date);
      expect((row?.captured_at as Date).toISOString()).toBe(response.body.captured_at);
      expect(row?.latency_milliseconds as number).toBeGreaterThan(0);
      expect(row?.latency_milliseconds as number).toBeLessThanOrEqual(requestMilliseconds);
      // The id is a UUIDv7 made by the API: it is the stored row's id and sorts by creation.
      expect(recognitionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    });

    it('sends the worker exactly the request id, the clip, the codec, a 2.5-second deadline and the fingerprint version, tried once and removed when done', async () => {
      const ad = await airingAds.create();
      worker.answer = () => match(ad.audioAssetNumber);
      const { installToken } = await newInstall();
      const clip = aacClipBytes(6_000);
      const sentAt = Date.now();
      const response = await recognize(client, { installToken, audio: clip });

      const [job] = worker.receivedJobs;
      expect(Object.keys(job?.data ?? {}).sort()).toEqual(['audio_base64', 'codec', 'deadline_epoch_milliseconds', 'fingerprint_version', 'request_id']);
      expect(job?.data).toMatchObject({ request_id: response.headers['x-request-id'], codec: 'aac', fingerprint_version: 2, audio_base64: clip.toString('base64') });
      expect(job?.data.deadline_epoch_milliseconds).toBeGreaterThanOrEqual(sentAt + 2_400);
      expect(job?.data.deadline_epoch_milliseconds).toBeLessThanOrEqual(Date.now() + 2_500);
      expect(job?.options).toMatchObject({ attempts: 1, removeOnComplete: true, removeOnFail: true });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await recognizeJobCount(keyValueStoreUrl(), queuePrefix())).toBe(0);
    });

    it('gives the client’s default card outside the schedule (stored as MATCH_DEFAULT), and no card when there is none', async () => {
      const defaultCard = { schema_version: 1, layout: 'VERTICAL_STACK', actions: [{ type: 'LINK', id: '0192a6c4-0000-4000-8000-0000000000d1', label: 'Visit us', style: 'PRIMARY', url: 'https://brand.co.zm/' }] };
      const withDefault = await airingAds.create({ windows: [{ days: [1], from: '03:00', to: '03:15' }], period: ['2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z'], defaultCard });
      worker.answer = () => match(withDefault.audioAssetNumber);
      const { installToken } = await newInstall();
      const response = await recognize(client, { installToken });
      expect(response.body).toMatchObject({ status: 'MATCH', result: { kind: 'CLIENT_DEFAULT', card: { actions: defaultCard.actions } } });
      expect((await eventRow(response.body.recognition_id))?.outcome).toBe('MATCH_DEFAULT');

      const withoutDefault = await airingAds.create({ windows: [{ days: [1], from: '03:00', to: '03:15' }], period: ['2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z'] });
      worker.answer = () => match(withoutDefault.audioAssetNumber);
      const second = await recognize(client, { installToken });
      expect(second.body.status).toBe('NO_MATCH');
      expect(second.body).not.toHaveProperty('result');
    });

    it('judges "on air" at the moment the clip was heard, in the station’s time zone, not when it arrived', async () => {
      // On air for one hour, three hours ago (in Lusaka time); the clip was heard then and sent now.
      const heardAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const lusakaHour = (heardAt.getUTCHours() + 2) % 24;
      const hour = (value: number) => `${String(value).padStart(2, '0')}:00`;
      const ad = await airingAds.create({ windows: [{ days: [1, 2, 3, 4, 5, 6, 7], from: hour(lusakaHour), to: hour((lusakaHour + 1) % 24) }] });
      worker.answer = () => match(ad.audioAssetNumber);
      const { installToken } = await newInstall();
      const now = new Date();
      const heard = await recognize(client, { installToken, fields: { captured_at: new Date(Date.UTC(heardAt.getUTCFullYear(), heardAt.getUTCMonth(), heardAt.getUTCDate(), heardAt.getUTCHours(), 30)).toISOString(), sent_at: now.toISOString(), is_deferred: 'true' } });
      expect(heard.body).toMatchObject({ status: 'MATCH', is_deferred: true, result: { kind: 'CAMPAIGN' } });
      const heardNow = await recognize(client, { installToken });
      expect(heardNow.body.status).toBe('NO_MATCH');
    });

    it('returns a button edited in the portal on the very next recognition', async () => {
      const ad = await airingAds.create();
      worker.answer = () => match(ad.audioAssetNumber);
      const { installToken } = await newInstall();
      expect((await recognize(client, { installToken })).body.result.card.actions[0].label).toBe('Call us');
      // A saved edit is a new card version, which the live campaign shows from then on.
      const editedCardId = randomUUID();
      const edited = { ...CALL_CARD, actions: [{ ...CALL_CARD.actions[0], label: 'Call the shop' }] };
      await setupClient.query('INSERT INTO app.action_cards (id, station_id, client_id, schema_version, content) VALUES ($1, $2, $3, 1, $4)', [editedCardId, ad.stationId, ad.clientId, edited]);
      await setupClient.query('UPDATE app.campaigns SET action_card_id = $2 WHERE id = $1', [ad.campaignId, editedCardId]);
      expect((await recognize(client, { installToken })).body.result.card.actions[0].label).toBe('Call the shop');
    });

    it('answers NO_MATCH for nothing matched and for an AMBIGUOUS result, storing each as what it was', async () => {
      const { installToken } = await newInstall();
      worker.answer = () => noMatch();
      const nothing = await recognize(client, { installToken });
      expect(nothing.status).toBe(200);
      expect(nothing.body).toEqual({ status: 'NO_MATCH', recognition_id: expect.any(String), request_id: nothing.headers['x-request-id'], is_deferred: false, captured_at: expect.any(String) });
      expect(await eventRow(nothing.body.recognition_id)).toMatchObject({ outcome: 'NO_MATCH', station_id: null, campaign_id: null, action_card_id: null, audio_asset_id: null });

      const ad = await airingAds.create();
      worker.answer = () => match(ad.audioAssetNumber, { status: 'AMBIGUOUS', match_margin: 1.2 });
      const ambiguous = await recognize(client, { installToken });
      expect(ambiguous.body.status).toBe('NO_MATCH');
      expect(JSON.stringify(ambiguous.body)).not.toContain('AMBIGUOUS');
      expect((await eventRow(ambiguous.body.recognition_id))?.outcome).toBe('AMBIGUOUS');
    });

    it('never answers with a station that is not active', async () => {
      const { installToken } = await newInstall();
      for (const stationStatus of ['PENDING_VERIFICATION', 'PENDING_REVIEW', 'REJECTED', 'SUSPENDED']) {
        const ad = await airingAds.create({ stationStatus, defaultCard: CALL_CARD });
        worker.answer = () => match(ad.audioAssetNumber);
        const response = await recognize(client, { installToken });
        expect(response.body.status, stationStatus).toBe('NO_MATCH');
        expect(response.body, stationStatus).not.toHaveProperty('result');
      }
    });
  });

  // ---- checks at the door -------------------------------------------------------------------------
  describe('checks before any work is done', () => {
    it('refuses a missing, malformed, tampered or expired install token with 401 INSTALL_TOKEN_INVALID, before the size or anything else', async () => {
      const { installToken, rowId } = await newInstall();
      const tampered = `${installToken.slice(0, -4)}AAAA`;
      const { installToken: expired } = await testApplication.application.get(InstallTokens).issue(rowId, new Date(Date.now() - 31 * 24 * 60 * 60 * 1000));
      for (const token of [null, '', 'not-a-token', tampered, expired]) {
        const response = await recognize(client, { installToken: token, audio: aacClipBytes(300_000) });
        expect(response.status, String(token).slice(0, 12)).toBe(401);
        expect(response.body.error).toMatchObject({ code: 'INSTALL_TOKEN_INVALID', request_id: response.headers['x-request-id'] });
      }
      expect(worker.receivedJobs).toHaveLength(0);
    });

    it('refuses a blocked install’s token', async () => {
      const { installToken, rowId } = await newInstall();
      await setupClient.query(`UPDATE app.listener_installs SET status = 'BLOCKED' WHERE id = $1`, [rowId]);
      expect((await recognize(client, { installToken })).body.error.code).toBe('INSTALL_TOKEN_INVALID');
    });

    it('counts per install: the seventh clip in a minute is refused with 429 and nothing is queued, while another install on the same address goes on', async () => {
      const address = newClientAddress();
      const first = await newInstall();
      const second = await newInstall();
      for (let clip = 0; clip < 6; clip += 1) expect((await recognize(client, { installToken: first.installToken, clientAddress: address })).status).toBe(200);
      const jobsBefore = worker.receivedJobs.length;
      const refused = await recognize(client, { installToken: first.installToken, clientAddress: address });
      expect(refused.status).toBe(429);
      expect(refused.body.error).toMatchObject({ code: 'RATE_LIMITED', request_id: refused.headers['x-request-id'] });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(worker.receivedJobs.length).toBe(jobsBefore);
      expect((await recognize(client, { installToken: second.installToken, clientAddress: address })).status).toBe(200);
    });

    it('counts per install whatever the address: clips of one install from two addresses share one allowance', async () => {
      const { installToken } = await newInstall();
      const [home, work, elsewhere] = [newClientAddress(), newClientAddress(), newClientAddress()];
      for (let clip = 0; clip < 6; clip += 1) {
        expect((await recognize(client, { installToken, clientAddress: clip % 2 === 0 ? home : work, fields: { codec: 'not-a-codec' } })).status).toBe(400);
      }
      const refused = await recognize(client, { installToken, clientAddress: elsewhere });
      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe('RATE_LIMITED');
    });

    it('every refusal is the shared error envelope: code, message and request id, and the fields only when the request failed validation', async () => {
      const now = Date.now();
      const busyKey = randomUUID();
      const cases: Array<[string, (installToken: string) => Promise<supertest.Response>]> = [
        ['INSTALL_TOKEN_INVALID', () => recognize(client, { installToken: 'not-a-token' })],
        ['VALIDATION_FAILED', (installToken) => recognize(client, { installToken, fields: { codec: undefined } })],
        ['PAYLOAD_TOO_LARGE', (installToken) => recognize(client, { installToken, audio: aacClipBytes(262_145) })],
        ['UNSUPPORTED_MEDIA_TYPE', (installToken) => recognize(client, { installToken, audio: Buffer.from('not a recording at all') })],
        ['CAPTURE_EXPIRED', (installToken) => recognize(client, { installToken, fields: { captured_at: new Date(now - 3 * 86_400_000).toISOString(), sent_at: new Date(now).toISOString() } })],
        ['CAPTURE_TIME_INVALID', (installToken) => recognize(client, { installToken, fields: { captured_at: new Date(now + 5 * 60_000).toISOString(), sent_at: new Date(now).toISOString() } })],
        ['INVALID_AUDIO', async (installToken) => {
          worker.answer = () => ({ fail: 'INVALID_AUDIO' });
          return recognize(client, { installToken });
        }],
        ['RECOGNITION_IN_PROGRESS', async (installToken) => {
          worker.answer = () => ({ delayMilliseconds: 1_000, answer: noMatch() });
          const fields = { ...defaultRecognizeFields(), idempotency_key: busyKey };
          const first = recognize(client, { installToken, fields }).then((response) => response);
          for (let waited = 0; waited < 50 && worker.receivedJobs.length === 0; waited += 1) await new Promise((resolve) => setTimeout(resolve, 20));
          const repeat = await recognize(client, { installToken, fields });
          await first;
          return repeat;
        }],
        ['RECOGNITION_BUSY', async (installToken) => {
          await worker.stopHeartbeat();
          await recognizeQueue.refreshAdmission();
          try {
            return await recognize(client, { installToken });
          } finally {
            await worker.startHeartbeat();
            await recognizeQueue.refreshAdmission();
          }
        }],
      ];
      for (const [code, send] of cases) {
        worker.receivedJobs.length = 0;
        const { installToken } = await newInstall();
        const response = await send(installToken);
        const envelope = assertErrorEnvelope(response.body);
        expect(envelope.error.code, code).toBe(code);
        expect(envelope.error.request_id, code).toBe(response.headers['x-request-id']);
        expect('fields' in envelope.error, code).toBe(code === 'VALIDATION_FAILED');
      }
    });

    it('counts per address too, across installs, because installs cost nothing to make: the 31st request in a minute is refused, another address goes on', async () => {
      const address = newClientAddress();
      const installs = [];
      for (let install = 0; install < 6; install += 1) installs.push(await newInstall());
      // Six requests from each of five installs (each install's own limit), all from one address: this file's 30.
      for (const install of installs.slice(0, 5)) {
        for (let request = 0; request < 6; request += 1) {
          expect((await recognize(client, { installToken: install.installToken, clientAddress: address, fields: { codec: 'not-a-codec' } })).status).toBe(400);
        }
      }
      const fresh = installs[5] as (typeof installs)[number];
      const refused = await recognize(client, { installToken: fresh.installToken, clientAddress: address });
      expect(refused.status).toBe(429);
      expect(refused.body.error).toMatchObject({ code: 'RATE_LIMITED', request_id: refused.headers['x-request-id'] });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(worker.receivedJobs).toHaveLength(0);
      expect((await recognize(client, { installToken: fresh.installToken })).status).toBe(200);
    });

    it('refuses a clip that stops arriving with 400 once the read time is up, in plain words, and keeps nothing', async () => {
      const { installToken, rowId } = await newInstall();
      const answer = await sendRecognizeAndStall(server, { installToken });
      expect(answer.status).toBe(400);
      expect(answer.answeredAfterMilliseconds).toBeGreaterThanOrEqual(1_400);
      expect(answer.answeredAfterMilliseconds).toBeLessThan(3_000);
      const body = JSON.parse(answer.body);
      expect(body.error).toMatchObject({ code: 'BAD_REQUEST', message: 'The recording took too long to arrive. Please try again.' });
      assertNoInternalDetails(body);
      expect(worker.receivedJobs).toHaveLength(0);
      expect((await setupClient.query('SELECT count(*)::integer AS stored FROM app.recognition_events WHERE listener_install_id = $1', [rowId])).rows[0].stored).toBe(0);
    });

    it('past the limit of recognitions at once on this instance, reading clips included, refuses the next at once as busy and takes clips again once places free up', async () => {
      const service = testApplication.application.get(RecognitionService);
      const slow = await newInstall();
      const next = await newInstall();
      const stalled = Array.from({ length: 4 }, () => sendRecognizeAndStall(server, { installToken: slow.installToken }));
      for (let waited = 0; waited < 50 && service.inFlightCount < 4; waited += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(service.inFlightCount).toBe(4);
      const startedAt = Date.now();
      const refused = await recognize(client, { installToken: next.installToken });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(refused.status).toBe(503);
      expect(refused.body.error).toMatchObject({ code: 'RECOGNITION_BUSY', request_id: refused.headers['x-request-id'] });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(JSON.stringify(refused.body)).not.toMatch(/flight|limit|instance/i);
      await waitForLogWrites();
      expect(testApplication.logs.find((line) => line.requestId === refused.headers['x-request-id'] && line.cause === 'too_many_in_flight')).toBeDefined();
      for (const answer of await Promise.all(stalled)) expect(answer.status).toBe(400);
      expect(service.inFlightCount).toBe(0);
      expect((await recognize(client, { installToken: next.installToken })).status).toBe(200);
      expect(worker.receivedJobs).toHaveLength(1);
    });

    it('while clips wait for a worker the API keeps answering other routes at once: nothing is decoded on its event loop', async () => {
      worker.answer = () => ({ delayMilliseconds: 1_500, answer: noMatch() });
      const { installToken } = await newInstall();
      const waiting = Array.from({ length: 3 }, () => recognize(client, { installToken }).then((response) => response.status));
      for (let waited = 0; waited < 50 && worker.receivedJobs.length < 3; waited += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(worker.receivedJobs).toHaveLength(3);
      const startedAt = Date.now();
      const health = await client().get('/api/v1/health');
      expect(health.status).toBe(200);
      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(await Promise.all(waiting)).toEqual([200, 200, 200]);
    });

    it('an invalid token does not use up any install’s allowance', async () => {
      const { installToken } = await newInstall();
      for (let attempt = 0; attempt < 8; attempt += 1) expect((await recognize(client, { installToken: `${installToken}x` })).status).toBe(401);
      expect((await recognize(client, { installToken })).status).toBe(200);
    });

    it('takes multipart only: a JSON body is refused with 415, and GET runs nothing', async () => {
      const { installToken } = await newInstall();
      const json = await client().post('/api/v1/recognize').set('Authorization', `Bearer ${installToken}`).send({ audio: 'AAAA', ...defaultRecognizeFields() });
      expect(json.status).toBe(415);
      expect(json.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      const get = await client().get('/api/v1/recognize').set('Authorization', `Bearer ${installToken}`);
      expect(get.status).toBe(404);
      expect(get.body.error.request_id).toBe(get.headers['x-request-id']);
      expect(worker.receivedJobs).toHaveLength(0);
    });

    it.each(['clip_duration_milliseconds', 'codec', 'idempotency_key', 'captured_at', 'sent_at', 'is_deferred'])('names %s when it is missing', async (field) => {
      const { installToken } = await newInstall();
      const response = await recognize(client, { installToken, fields: { [field]: undefined } });
      expect(response.status).toBe(400);
      expect(response.body.error.fields).toContainEqual(expect.objectContaining({ path: field }));
    });

    it('names the audio when the clip is missing, and refuses unknown fields without echoing them', async () => {
      const { installToken } = await newInstall();
      const withoutAudio = await recognize(client, { installToken, audio: null });
      expect(withoutAudio.body.error.fields).toContainEqual({ path: 'audio', code: 'invalid_type' });
      const extra = await recognize(client, { installToken, fields: { fingerprint_hashes: 'secret-unknown-value' } });
      expect(extra.status).toBe(400);
      expect(JSON.stringify(extra.body)).not.toContain('secret-unknown-value');
    });

    it.each([['1999', 400], ['2000', 200], ['15000', 200], ['15001', 400]])('a clip of %s ms is answered %s', async (duration, status) => {
      const { installToken } = await newInstall();
      const response = await recognize(client, { installToken, fields: { clip_duration_milliseconds: duration } });
      expect(response.status).toBe(status);
      if (status === 400) {
        expect(response.body.error).toMatchObject({ code: 'VALIDATION_FAILED', request_id: response.headers['x-request-id'] });
        expect(response.body.error.fields).toContainEqual(expect.objectContaining({ path: 'clip_duration_milliseconds' }));
      }
      expect(worker.receivedJobs).toHaveLength(status === 200 ? 1 : 0);
    });

    it('takes the caller’s request id when it is a UUID, carrying it to the answer and the worker’s job, and replaces any other', async () => {
      const { installToken } = await newInstall();
      const requestId = randomUUID();
      const response = await recognize(client, { installToken }).set('X-Request-Id', requestId);
      expect(response.status).toBe(200);
      expect(response.headers['x-request-id']).toBe(requestId);
      expect(response.body.request_id).toBe(requestId);
      expect(worker.receivedJobs.map((job) => job.data.request_id)).toEqual([requestId]);

      const hostile = '"><script>alert(1)</script>' + 'x'.repeat(200);
      const replaced = await recognize(client, { installToken }).set('X-Request-Id', hostile);
      expect(replaced.status).toBe(200);
      expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(replaced.body.request_id).toBe(replaced.headers['x-request-id']);
      expect(worker.receivedJobs[1]?.data.request_id).toBe(replaced.headers['x-request-id']);
      expect(JSON.stringify(replaced.body)).not.toContain('script');
    });

    it('accepts a valid station hint, refuses one that is not a station id', async () => {
      const { installToken } = await newInstall();
      expect((await recognize(client, { installToken, fields: { station_hint: randomUUID() } })).status).toBe(200);
      expect((await recognize(client, { installToken, fields: { station_hint: 'station-a' } })).body.error.fields).toContainEqual(expect.objectContaining({ path: 'station_hint' }));
    });

    it('takes a clip of exactly 256 KiB and refuses one byte more with 413, before any job', async () => {
      const { installToken } = await newInstall();
      expect((await recognize(client, { installToken, audio: aacClipBytes(262_144) })).status).toBe(200);
      const tooLarge = await recognize(client, { installToken, audio: aacClipBytes(262_145) });
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.body.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', request_id: tooLarge.headers['x-request-id'] });
      assertNoInternalDetails(tooLarge.body);
      expect(worker.receivedJobs).toHaveLength(1);
    });

    it('cuts a multi-megabyte upload off once it passes the limit, without reading the rest', async () => {
      const { installToken } = await newInstall();
      const declared = await sendRecognizeInChunks(server, { installToken, chunk: Buffer.alloc(64 * 1024), chunkCount: 160, declaredLength: 10 * 1024 * 1024 });
      expect(declared.status).toBe(413);
      expect(declared.bytesWrittenBeforeAnswer).toBeLessThan(2 * 1024 * 1024);
      const undeclared = await sendRecognizeInChunks(server, { installToken, chunk: Buffer.alloc(64 * 1024), chunkCount: 160 });
      expect(undeclared.status).toBe(413);
      expect(undeclared.bytesWrittenBeforeAnswer).toBeLessThan(4 * 1024 * 1024);
      assertNoInternalDetails(JSON.parse(undeclared.body));
    });

    it('answers a cut-off multipart body with 400 and none of the parser’s words', async () => {
      const { installToken } = await newInstall();
      const response = await client()
        .post('/api/v1/recognize')
        .set('Authorization', `Bearer ${installToken}`)
        .set('Content-Type', 'multipart/form-data; boundary=----cut')
        .send('------cut\r\nContent-Disposition: form-data; name="codec"\r\n\r\naac\r\n------cut\r\nContent-Disposition: form-data; name="audio"; filename="a"\r\n\r\nftyp');
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toMatch(/Unexpected end|busboy|multipart/i);
      assertNoInternalDetails(response.body);
    });

    it('checks the clip’s first bytes, not its name or declared type', async () => {
      const { installToken } = await newInstall();
      for (const bytes of [Buffer.from('this is a text file pretending to be a clip'), Buffer.from('\x89PNG\r\n\x1a\n0000'), Buffer.from(Array.from({ length: 64 }, () => randomInt(256)))]) {
        const response = await recognize(client, { installToken, audio: bytes, fileName: 'clip.m4a', contentType: 'audio/mp4' });
        expect(response.status).toBe(415);
        expect(response.body.error).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE', request_id: response.headers['x-request-id'] });
      }
      // An empty clip, sent by hand as a real part with no bytes (a client library may leave an empty part out).
      const boundary = '----lookup-empty-clip';
      const formParts = Object.entries(defaultRecognizeFields()).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
      const empty = await client()
        .post('/api/v1/recognize')
        .set('Authorization', `Bearer ${installToken}`)
        .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
        .send(`${formParts.join('')}--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="clip.m4a"\r\nContent-Type: audio/mp4\r\n\r\n\r\n--${boundary}--\r\n`);
      expect(empty.status).toBe(415);
      expect(empty.body.error).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE', request_id: empty.headers['x-request-id'] });
      const misnamed = await recognize(client, { installToken, fileName: 'notes.txt', contentType: 'text/plain' });
      expect(misnamed.status).toBe(200);
      expect((await recognize(client, { installToken, fields: { codec: 'opus' } })).status).toBe(415);
      expect(worker.receivedJobs).toHaveLength(1);
    });

    it('refuses a clip heard over a day ago or claiming a future time, in the envelope, with nothing queued or stored', async () => {
      const { installToken, rowId } = await newInstall();
      const now = Date.now();
      const old = await recognize(client, { installToken, fields: { captured_at: new Date(now - 3 * 86_400_000).toISOString(), sent_at: new Date(now).toISOString() } });
      expect(old.status).toBe(422);
      expect(old.body.error.code).toBe('CAPTURE_EXPIRED');
      assertNoInternalDetails(old.body);
      const future = await recognize(client, { installToken, fields: { captured_at: new Date(now + 5 * 60_000).toISOString(), sent_at: new Date(now).toISOString() } });
      expect(future.body.error.code).toBe('CAPTURE_TIME_INVALID');
      expect(worker.receivedJobs).toHaveLength(0);
      expect((await setupClient.query('SELECT count(*)::integer AS stored FROM app.recognition_events WHERE listener_install_id = $1', [rowId])).rows[0].stored).toBe(0);
    });

    it('corrects the capture time by the phone’s clock: a phone 3 hours slow still records when it was really heard', async () => {
      const { installToken } = await newInstall();
      const now = Date.now();
      const slow = 3 * 60 * 60 * 1000;
      const response = await recognize(client, { installToken, fields: { captured_at: new Date(now - slow - 10_000).toISOString(), sent_at: new Date(now - slow).toISOString() } });
      expect(response.status).toBe(200);
      expect(Math.abs(new Date(response.body.captured_at).getTime() - (now - 10_000))).toBeLessThan(2_000);
      const row = await eventRow(response.body.recognition_id);
      // A bigint column, which the driver gives as text (P4-D18): any skew is stored exactly.
      expect(Number(row?.clock_skew_milliseconds)).toBeGreaterThan(slow - 2_000);
      expect((row?.client_captured_at as Date).getTime()).toBe(now - slow - 10_000);
    });

    it('a listener install token opens no portal route, whether sent as a bearer token or as the portal’s session cookie', async () => {
      const ad = await airingAds.create();
      const { installToken } = await newInstall();
      for (const [method, path] of [['post', `/api/v1/stations/${ad.stationId}/ads`], ['put', `/api/v1/stations/${ad.stationId}/ads/${ad.adId}/card`], ['put', `/api/v1/stations/${ad.stationId}/ads/${ad.adId}/schedule`], ['post', `/api/v1/stations/${ad.stationId}/ads/${ad.adId}/publish`], ['get', `/api/v1/stations/${ad.stationId}/ads`], ['get', '/api/v1/auth/me']] as const) {
        // From the portal's own origin, so the cross-site check passes and the sign-in check is what answers.
        const response = await client()[method](path)
          .set('Origin', PORTAL_ORIGIN)
          .set('X-Forwarded-For', newClientAddress())
          .set('Authorization', `Bearer ${installToken}`)
          .set('Cookie', `${ACCESS_TOKEN_COOKIE}=${installToken}`)
          .send({});
        expect(response.status, `${method} ${path}`).toBe(401);
      }
    });
  });

  // ---- busy, slow and broken workers --------------------------------------------------------------
  describe('when the workers cannot answer', () => {
    it('with no worker heartbeat: 503 RECOGNITION_BUSY with Retry-After at once, nothing queued', async () => {
      await worker.stopHeartbeat();
      await recognizeQueue.refreshAdmission();
      const { installToken } = await newInstall();
      const startedAt = Date.now();
      const response = await recognize(client, { installToken });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(response.status).toBe(503);
      expect(response.body.error).toMatchObject({ code: 'RECOGNITION_BUSY', request_id: response.headers['x-request-id'] });
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      expect(JSON.stringify(response.body)).not.toMatch(/queue|worker|heartbeat|breaker|valkey|redis/i);
      expect(await recognizeJobCount(keyValueStoreUrl(), queuePrefix())).toBe(0);
      expect((await eventRow((await setupClient.query(`SELECT id FROM app.recognition_events WHERE request_id = $1`, [response.headers['x-request-id']])).rows[0].id))?.outcome).toBe('BUSY');
      await waitForLogWrites();
      expect(testApplication.logs.find((line) => line.requestId === response.headers['x-request-id'] && line.cause === 'no_worker_heartbeat')).toBeDefined();
    });

    it('reads the queue depth and the heartbeat in the background about once a second, however many clips arrive', async () => {
      const depthReads = vi.spyOn((recognizeQueue as unknown as { queue: Queue }).queue, 'getWaitingCount');
      const heartbeatReads = vi.spyOn(testApplication.application.get(KEY_VALUE_STORE) as Redis, 'exists');
      try {
        const startedAt = Date.now();
        for (let check = 0; check < 1_000; check += 1) recognizeQueue.admissionState();
        const { installToken } = await newInstall();
        expect(await Promise.all(Array.from({ length: 4 }, () => recognize(client, { installToken }).then((response) => response.status)))).toEqual([200, 200, 200, 200]);
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        const mostReads = Math.ceil((Date.now() - startedAt) / 1_000) + 1;
        expect(depthReads.mock.calls.length).toBeGreaterThanOrEqual(1);
        expect(depthReads.mock.calls.length).toBeLessThanOrEqual(mostReads);
        expect(heartbeatReads.mock.calls.length).toBeLessThanOrEqual(mostReads);
      } finally {
        depthReads.mockRestore();
        heartbeatReads.mockRestore();
      }
    });

    it('with too many clips waiting: 503 RECOGNITION_BUSY at once', async () => {
      await worker.pause();
      const queue = new Queue(RECOGNIZE_QUEUE_NAME, { connection: new Redis(keyValueStoreUrl(), { maxRetriesPerRequest: null }), prefix: queuePrefix() });
      try {
        // More than the limit of 3.
        for (let waiting = 0; waiting < 5; waiting += 1) await queue.add(RECOGNIZE_QUEUE_NAME, { filler: true }, { removeOnComplete: true, removeOnFail: true });
        await recognizeQueue.refreshAdmission();
        const { installToken } = await newInstall();
        const jobsBefore = await recognizeJobCount(keyValueStoreUrl(), queuePrefix());
        const startedAt = Date.now();
        const response = await recognize(client, { installToken });
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect(response.status).toBe(503);
        expect(assertErrorEnvelope(response.body).error).toMatchObject({ code: 'RECOGNITION_BUSY', request_id: response.headers['x-request-id'] });
        expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
        expect(JSON.stringify(response.body)).not.toMatch(/queue|worker|heartbeat|breaker|valkey|redis/i);
        expect(await recognizeJobCount(keyValueStoreUrl(), queuePrefix())).toBe(jobsBefore);
        await waitForLogWrites();
        expect(testApplication.logs.find((line) => line.requestId === response.headers['x-request-id'] && line.cause === 'queue_too_deep')).toBeDefined();
      } finally {
        await queue.obliterate({ force: true });
        await queue.close();
        worker.resume();
      }
    });

    it('when no worker answers in time: 503 RECOGNITION_TIMEOUT after 2.5 seconds (plus at most 1 second), recorded as TIMEOUT, and the clip is not left in Valkey', async () => {
      // No worker takes the job, so it is still waiting when the API stops waiting for it. (A worker that
      // took it and never answered ends the same way: the API's wait is the same timer.)
      await worker.pause();
      const { installToken } = await newInstall();
      const startedAt = Date.now();
      const response = await recognize(client, { installToken });
      const tookMilliseconds = Date.now() - startedAt;
      expect(response.status).toBe(503);
      expect(assertErrorEnvelope(response.body).error).toMatchObject({ code: 'RECOGNITION_TIMEOUT', request_id: response.headers['x-request-id'] });
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      expect(tookMilliseconds).toBeGreaterThanOrEqual(2_500);
      expect(tookMilliseconds).toBeLessThan(3_500);
      const row = (await setupClient.query('SELECT outcome FROM app.recognition_events WHERE request_id = $1', [response.headers['x-request-id']])).rows[0];
      expect(row.outcome).toBe('TIMEOUT');
      // The API removed its job on giving up: no job, and so no copy of the clip, is left for a worker to find.
      expect(await recognizeJobCount(keyValueStoreUrl(), queuePrefix())).toBe(0);
    });

    it('a worker failure is answered with a code of ours: unreadable audio is 400 INVALID_AUDIO, anything else never shows the worker’s words', async () => {
      const { installToken } = await newInstall();
      worker.answer = () => ({ fail: 'INVALID_AUDIO' });
      const unreadable = await recognize(client, { installToken });
      expect(unreadable.status).toBe(400);
      expect(unreadable.body.error.code).toBe('INVALID_AUDIO');

      worker.answer = () => ({ fail: 'Traceback (most recent call last):\n  File "/app/workers/recognize.py", line 9, in handle\nValueError: boom' });
      const broken = await recognize(client, { installToken });
      expect(broken.status).toBe(500);
      expect(broken.body.error.code).toBe('INTERNAL');
      assertNoInternalDetails(broken.body);
      expect(JSON.stringify(broken.body)).not.toMatch(/Traceback|recognize\.py|ValueError|ENGINE_FAILED/);
      await waitForLogWrites();
      const logLine = testApplication.logs.find((line) => line.requestId === broken.headers['x-request-id'] && line.level === 50);
      expect(logLine, 'the full failure is in the private log under the same request id').toBeDefined();
    });

  });

  // ---- the same clip sent again ---------------------------------------------------------------------
  describe('the idempotency key', () => {
    it('a finished recognition sent again is answered the same, with the same id, and the worker is not asked twice', async () => {
      const ad = await airingAds.create();
      worker.answer = () => match(ad.audioAssetNumber);
      const { installToken, rowId } = await newInstall();
      const fields = defaultRecognizeFields();
      const first = await recognize(client, { installToken, fields });
      const again = await recognize(client, { installToken, fields });
      expect(again.status).toBe(200);
      expect(again.body.recognition_id).toBe(first.body.recognition_id);
      expect(again.body.result).toEqual(first.body.result);
      expect(worker.receivedJobs).toHaveLength(1);
      const stored = await setupClient.query('SELECT count(*)::integer AS rows FROM app.recognition_events WHERE listener_install_id = $1 AND idempotency_key = $2', [rowId, fields.idempotency_key]);
      expect(stored.rows[0].rows).toBe(1);
    });

    it('a repeat while the first is still being worked on gets 409 RECOGNITION_IN_PROGRESS', async () => {
      worker.answer = () => ({ delayMilliseconds: 1_200, answer: noMatch() });
      const { installToken } = await newInstall();
      const fields = defaultRecognizeFields();
      const first = recognize(client, { installToken, fields }).then((response) => response);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const second = await recognize(client, { installToken, fields });
      expect(second.status).toBe(409);
      expect(second.body.error).toMatchObject({ code: 'RECOGNITION_IN_PROGRESS', request_id: second.headers['x-request-id'] });
      expect((await first).status).toBe(200);
      expect(worker.receivedJobs).toHaveLength(1);
    });

    it('a repeat after a timeout tries again on the same recognition', async () => {
      worker.answer = () => ({ hang: true });
      const { installToken } = await newInstall();
      const fields = defaultRecognizeFields();
      const timedOut = await recognize(client, { installToken, fields });
      expect(timedOut.status).toBe(503);
      worker.answer = () => noMatch();
      const retried = await recognize(client, { installToken, fields });
      expect(retried.body).toMatchObject({ status: 'NO_MATCH' });
      expect(retried.status).toBe(200);
      const row = await eventRow(retried.body.recognition_id);
      expect(row).toMatchObject({ outcome: 'NO_MATCH', attempt_count: 2, request_id: retried.headers['x-request-id'] });
    });
  });

  it('an attempt that fails after it was claimed is recorded as ERROR, never left PENDING, and the same key can be tried again at once', async () => {
    // A stored card the response contract refuses (no buttons): the answer cannot be built.
    const ad = await airingAds.create({ card: { schema_version: 1, layout: 'VERTICAL_STACK', actions: [] } });
    worker.answer = () => match(ad.audioAssetNumber);
    const { installToken } = await newInstall();
    const fields = defaultRecognizeFields();
    const failed = await recognize(client, { installToken, fields });
    expect(failed.status).toBe(500);
    assertNoInternalDetails(failed.body);
    const row = (await setupClient.query('SELECT id, outcome, completed_at FROM app.recognition_events WHERE request_id = $1', [failed.headers['x-request-id']])).rows[0];
    expect(row.outcome).toBe('ERROR');
    expect(row.completed_at).toBeInstanceOf(Date);
    const again = await recognize(client, { installToken, fields });
    expect(again.status).not.toBe(409);
    expect((await eventRow(row.id))?.attempt_count).toBe(2);
  });

  // ---- logs -----------------------------------------------------------------------------------------
  it('never logs the install token, the raw install id or the audio', async () => {
    const ad = await airingAds.create();
    worker.answer = () => match(ad.audioAssetNumber);
    const install = await newInstall();
    const clip = aacClipBytes(5_000);
    await recognize(client, { installToken: install.installToken, audio: clip });
    await recognize(client, { installToken: `${install.installToken}x`, audio: clip });
    await waitForLogWrites();
    const logged = JSON.stringify(testApplication.logs.lines);
    expect(logged).not.toContain(install.installToken);
    expect(logged).not.toContain(install.installId);
    expect(logged).not.toContain(clip.toString('base64').slice(0, 64));
    expect(testApplication.logs.lines.every((line) => JSON.stringify(line).length < 16_384)).toBe(true);
  });

  // Last: an open breaker's failure figures stay in its 10-second window, which would trip later tests.
  describe('the circuit breaker', () => {
    it('after repeated failures the breaker opens and clips are refused at once as busy', async () => {
      worker.answer = () => ({ fail: 'ENGINE_FAILED' });
      const breaker = testApplication.application.get(RecognitionService).circuitBreaker;
      // Earlier tests' successes are in the same 10-second window, so fail until the share passes half.
      for (let attempt = 0; attempt < 40 && !breaker.opened; attempt += 1) {
        const { installToken } = await newInstall();
        await recognize(client, { installToken });
      }
      expect(breaker.opened).toBe(true);
      worker.answer = () => noMatch();
      const third = await newInstall();
      const jobsBefore = worker.receivedJobs.length;
      const startedAt = Date.now();
      const refused = await recognize(client, { installToken: third.installToken });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(refused.status).toBe(503);
      expect(assertErrorEnvelope(refused.body).error).toMatchObject({ code: 'RECOGNITION_BUSY', request_id: refused.headers['x-request-id'] });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(JSON.stringify(refused.body)).not.toMatch(/queue|worker|heartbeat|breaker|valkey|redis/i);
      expect(worker.receivedJobs.length).toBe(jobsBefore);
      expect(await recognizeJobCount(keyValueStoreUrl(), queuePrefix())).toBe(0);
      await waitForLogWrites();
      expect(testApplication.logs.find((line) => line.requestId === refused.headers['x-request-id'] && line.cause === 'breaker_open')).toBeDefined();
    });
  });

  afterEach(async () => {
    worker.releaseHungJobs();
    worker.resume();
  });
});
