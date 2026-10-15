import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type pg from 'pg';
import supertest from 'supertest';
import { QueryFailedError } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { correctTapTime, Engagements } from '../src/features/engagements/engagements.js';
import { RecognitionService } from '../src/features/recognition/recognition.service.js';
import { RecognizeQueue } from '../src/infrastructure/job-queues/recognize-queue.js';
import { databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { FakeRecognizeWorker, match, noMatch, randomClientAddress, recognize, registerInstall } from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { type Recording, type StationAiring, StationResolutionTestData } from './support/station-resolution-test-data.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/** This file's follow-up allowance per install and minute, low so the allowance is reached quickly (60 in production). */
const FOLLOW_UPS_PER_MINUTE = 12;
/** This file's per-install cap (5 in production): low, so the cap is reached with one card's three buttons. */
const COUNTED_TAPS_PER_INSTALL = 2;
const ENGAGEMENT_FIXTURES = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'contracts', 'fixtures', 'recognition', 'engagement-input');

interface EngagementFixture {
  description: string;
  body: Record<string, unknown>;
  expected_issues?: Array<{ path: string; code: string }>;
}

function readEngagementFixtures(folder: 'valid' | 'invalid'): Array<[string, EngagementFixture]> {
  return readdirSync(resolve(ENGAGEMENT_FIXTURES, folder))
    .filter((fileName) => fileName.endsWith('.json'))
    .sort()
    .map((fileName) => [fileName.replace(/\.json$/, ''), JSON.parse(readFileSync(resolve(ENGAGEMENT_FIXTURES, folder, fileName), 'utf8')) as EngagementFixture]);
}

describe('correctTapTime (P4-ENGAGEMENTS-03)', () => {
  it('moves the tap by how far the phone’s "sent at" is from the receipt: a phone 3 hours slow', () => {
    const receivedAt = new Date('2026-10-14T09:00:00Z');
    const corrected = correctTapTime({ occurredAt: new Date('2026-10-14T05:59:50Z'), sentAt: new Date('2026-10-14T06:00:00Z'), receivedAt });
    expect(corrected).toEqual({ correctedOccurredAt: new Date('2026-10-14T08:59:50Z'), clockSkewMilliseconds: 3 * 3_600_000 });
  });

  it('a time beyond what a date can hold is the receipt, which the database’s clamp would choose anyway', () => {
    const receivedAt = new Date('2026-10-14T09:00:00Z');
    const corrected = correctTapTime({ occurredAt: new Date(8.64e15), sentAt: new Date(-8.64e15), receivedAt });
    expect(corrected.correctedOccurredAt).toEqual(receivedAt);
  });
});

/**
 * POST /api/v1/engagements (P4 design §5.8; contract §1.5; P4-ENGAGEMENTS-01 to -10, P4-LIMITS-02, -04 to -06,
 * P4-TIMERULE-04, P4-IDEMPOTENCY-20, A4): button taps against the real API and database, after real answers from
 * POST /api/v1/recognize with a stand-in worker. Stations keep UTC time here.
 */
describe('POST /api/v1/engagements', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  let testData: StationResolutionTestData;
  let worker: FakeRecognizeWorker;
  let recognizeQueue: RecognizeQueue;
  const installRows: string[] = [];
  const runTag = randomUUID().slice(0, 6);
  const client = () => supertest(testApplication.application.getHttpServer());

  const air = (recording: Recording, name: string, options: Omit<Parameters<StationResolutionTestData['airAd']>[0], 'recording' | 'station'> = {}) =>
    testData.airAd({ recording, gracePeriodMinutes: 0, ...options, station: { name: `Taps ${runTag} ${name}`, timeZone: 'UTC' } });

  async function newInstall() {
    const install = await registerInstall(client);
    const hash = testApplication.application.get(InstallTokens).hashInstallId(install.installId);
    const rowId = (await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash])).rows[0].id as string;
    installRows.push(rowId);
    return { ...install, rowId };
  }

  async function identify(recording: Recording | null, installToken: string, fields: Record<string, string> = {}) {
    worker.answer = () => (recording ? match(recording.assetNumber) : noMatch());
    const response = await recognize(client, { installToken, fields });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response;
  }

  /** One station airing a recording, and a listener whose identify of it was answered MATCH. */
  async function answeredMatch(options: Omit<Parameters<StationResolutionTestData['airAd']>[0], 'recording' | 'station'> = {}) {
    const recording = await testData.createRecording();
    const station = await air(recording, 'A', options);
    const install = await newInstall();
    const answer = await identify(recording, install.installToken);
    expect(answer.body.status).toBe('MATCH');
    return { recording, station, install, recognitionId: answer.body.recognition_id as string };
  }

  /** Two stations airing a recording, and a listener whose identify was answered with the chooser. */
  async function answeredChooser() {
    const recording = await testData.createRecording();
    const stationA = await air(recording, 'A');
    const stationB = await air(recording, 'B');
    const install = await newInstall();
    const answer = await identify(recording, install.installToken);
    expect(answer.body.status).toBe('CHOOSE_STATION');
    return { stationA, stationB, install, recognitionId: answer.body.recognition_id as string };
  }

  const actionOf = (station: StationAiring, position = 0) => (station.campaignCard?.actions[position] as { id: string; type: string }).id;
  const tapBody = (recognitionId: string, stationId: string, actionId: string, times: { occurredAt?: Date; sentAt?: Date } = {}) => ({
    recognition_id: recognitionId,
    station_id: stationId,
    action_id: actionId,
    occurred_at: (times.occurredAt ?? new Date(Date.now() - 2_000)).toISOString(),
    sent_at: (times.sentAt ?? new Date(Date.now() - 500)).toISOString(),
  });
  const sendTap = (installToken: string | null, body: unknown, headers: Record<string, string> = {}, agent = client()) => {
    let request = agent.post('/api/v1/engagements').set('X-Forwarded-For', randomClientAddress());
    if (installToken !== null) request = request.set('Authorization', `Bearer ${installToken}`);
    for (const [name, value] of Object.entries(headers)) request = request.set(name, value);
    return request.send(body as object);
  };
  const expectRefusal = (response: supertest.Response, httpStatus: number, code: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(httpStatus);
    expect(assertErrorEnvelope(response.body).error).toMatchObject({ code, request_id: response.headers['x-request-id'] });
  };
  const tapRows = async (recognitionId: string) =>
    (
      await setupClient.query(
        `SELECT station_id, recognition_id, action_id, action_type, card_kind, is_counted, occurred_at, client_occurred_at, clock_skew_milliseconds,
                received_at, recognition_received_at, request_id
           FROM app.engagement_events WHERE recognition_id = $1 ORDER BY received_at, id`,
        [recognitionId],
      )
    ).rows as Array<Record<string, unknown>>;
  const countedTaps = async (campaignId: string) =>
    ((await setupClient.query('SELECT counted_engagement_count FROM app.campaign_counters WHERE campaign_id = $1', [campaignId])).rows[0]
      ?.counted_engagement_count as number | undefined) ?? 0;
  const recognitionRow = async (recognitionId: string) =>
    (await setupClient.query('SELECT resolution, station_id, received_at, fallback_reason FROM app.recognition_events WHERE id = $1', [recognitionId]))
      .rows[0] as { resolution: string; station_id: string | null; received_at: Date; fallback_reason: string | null };
  const linesOf = (response: supertest.Response) => {
    const requestId = response.headers['x-request-id'];
    return testApplication.logs.lines.filter((line) => line.requestId === requestId || (line.req as { id?: string } | undefined)?.id === requestId);
  };

  beforeAll(async () => {
    const config = {
      ...loadAppConfig(),
      RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE: FOLLOW_UPS_PER_MINUTE,
      ENGAGEMENTS_COUNTED_PER_INSTALL_PER_CAMPAIGN_PER_DAY: COUNTED_TAPS_PER_INSTALL,
      LISTENER_REQUESTS_PER_CLIENT_ADDRESS_PER_MINUTE: 100_000,
    };
    testApplication = await createTestApplication({ overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config) });
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await Promise.all([setupClient.connect(), apiClient.connect()]);
    testData = new StationResolutionTestData(setupClient);
    recognizeQueue = testApplication.application.get(RecognizeQueue);
    worker = new FakeRecognizeWorker(process.env.KEY_VALUE_STORE_URL as string, process.env.QUEUE_KEY_PREFIX as string);
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();
  });
  beforeEach(async () => {
    worker.answer = () => noMatch();
    testApplication.application.get(RecognitionService).circuitBreaker.close();
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();
  });
  afterAll(async () => {
    await worker.close();
    const ofTheseInstalls = 'SELECT id FROM app.recognition_events WHERE listener_install_id = ANY($1)';
    await setupClient.query(`DELETE FROM app.engagement_events WHERE recognition_id IN (${ofTheseInstalls})`, [installRows]);
    await setupClient.query(`DELETE FROM app.engagement_deduplication_keys WHERE recognition_id IN (${ofTheseInstalls})`, [installRows]);
    await setupClient.query(`DELETE FROM app.recognition_candidates WHERE recognition_id IN (${ofTheseInstalls})`, [installRows]);
    await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRows]);
    await testData.removeAll();
    await Promise.all([setupClient.end(), apiClient.end()]);
    await testApplication.close();
  });

  it('P4-ENGAGEMENTS-01, -09, -10: a tap on a button of the card shown answers 204 and is stored once with the station, the recognition, the button’s id, its type from the card and its time', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    const callId = actionOf(station, 0);
    const response = await sendTap(install.installToken, tapBody(recognitionId, station.stationId, callId));
    expect(response.status, JSON.stringify(response.body)).toBe(204);
    expect(response.text).toBe('');
    const [row] = await tapRows(recognitionId);
    expect(row).toMatchObject({
      station_id: station.stationId,
      recognition_id: recognitionId,
      action_id: callId,
      action_type: 'CALL',
      card_kind: 'CAMPAIGN',
      is_counted: true,
      request_id: response.headers['x-request-id'],
    });
    expect(row?.occurred_at).toBeInstanceOf(Date);
    expect(await countedTaps(station.campaignId)).toBe(1);
  });

  it('P4-ENGAGEMENTS-02, P4-LIMITS-02: the same tap posted three times answers 204 each time, stores one row and moves the counter once', async () => {
    const { station, install, recognitionId } = await answeredMatch({ engagementLimit: 10 });
    const body = tapBody(recognitionId, station.stationId, actionOf(station, 1));
    for (let sent = 0; sent < 3; sent += 1) expect((await sendTap(install.installToken, body)).status).toBe(204);
    expect(await tapRows(recognitionId)).toHaveLength(1);
    expect(await countedTaps(station.campaignId)).toBe(1);
  });

  it('P4-ENGAGEMENTS-03: the phone’s clock is corrected, and a tap dated before the recognition is stored at the recognition’s receipt', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    // A phone 3 hours slow: its tap, by its own clock, 3 hours and a minute before it sent it.
    const slowSentAt = new Date(Date.now() - 3 * 3_600_000);
    const response = await sendTap(install.installToken, tapBody(recognitionId, station.stationId, actionOf(station, 0), {
      occurredAt: new Date(slowSentAt.getTime() - 60_000),
      sentAt: slowSentAt,
    }));
    expect(response.status).toBe(204);
    const [row] = await tapRows(recognitionId);
    const recognition = await recognitionRow(recognitionId);
    // Corrected to a minute before the tap arrived, which is before the recognition: clamped to its receipt.
    expect((row?.occurred_at as Date).getTime()).toBe(recognition.received_at.getTime());
    expect(Number(row?.clock_skew_milliseconds)).toBeGreaterThan(3 * 3_600_000 - 60_000);
    expect((row?.client_occurred_at as Date).getTime()).toBe(slowSentAt.getTime() - 60_000);
  });

  it('P4-ENGAGEMENTS-04: a tap dated a day in the future is stored at the server’s time of receipt', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    const dayAhead = new Date(Date.now() + 86_400_000);
    const before = Date.now();
    expect((await sendTap(install.installToken, tapBody(recognitionId, station.stationId, actionOf(station, 0), { occurredAt: dayAhead, sentAt: new Date() }))).status).toBe(204);
    const [row] = await tapRows(recognitionId);
    expect((row?.occurred_at as Date).getTime()).toBe((row?.received_at as Date).getTime());
    expect((row?.occurred_at as Date).getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect((row?.occurred_at as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('P4-ENGAGEMENTS-05: a tap naming a station not shown, or on a "No match", is refused 422 and stores nothing; P4-ENGAGEMENTS-10: a button not on the card is 422 ACTION_NOT_ON_CARD', async () => {
    const { station, install, recognitionId } = await answeredMatch({ engagementLimit: 5 });
    const elsewhere = await air(await testData.createRecording(), 'Elsewhere');
    expectRefusal(await sendTap(install.installToken, tapBody(recognitionId, elsewhere.stationId, actionOf(elsewhere, 0))), 422, 'STATION_NOT_A_CANDIDATE');
    const nothingMatched = await identify(null, install.installToken);
    expectRefusal(await sendTap(install.installToken, tapBody(nothingMatched.body.recognition_id, station.stationId, actionOf(station, 0))), 422, 'STATION_NOT_A_CANDIDATE');
    expectRefusal(await sendTap(install.installToken, tapBody(recognitionId, station.stationId, randomUUID())), 422, 'ACTION_NOT_ON_CARD');
    expectRefusal(await sendTap(install.installToken, tapBody(recognitionId, station.stationId, actionOf(elsewhere, 0))), 422, 'ACTION_NOT_ON_CARD');
    expect(await tapRows(recognitionId)).toEqual([]);
    expect(await tapRows(nothingMatched.body.recognition_id)).toEqual([]);
    expect(await countedTaps(station.campaignId)).toBe(0);
  });

  it('P4-ENGAGEMENTS-06, -07: a tap for a recognition still pending, for an unknown id or for another install’s recognition answers 404 and stores nothing', async () => {
    const { station, install, recognitionId } = await answeredMatch({ engagementLimit: 5 });
    const pending = await testData.claim(apiClient, install.rowId);
    expectRefusal(await sendTap(install.installToken, tapBody(pending.recognition_id, station.stationId, actionOf(station, 0))), 404, 'NOT_FOUND');
    const unknownId = `${recognitionId.slice(0, 24)}${'0'.repeat(12)}`;
    expectRefusal(await sendTap(install.installToken, tapBody(unknownId, station.stationId, actionOf(station, 0))), 404, 'NOT_FOUND');
    const stranger = await newInstall();
    expectRefusal(await sendTap(stranger.installToken, tapBody(recognitionId, station.stationId, actionOf(station, 0))), 404, 'NOT_FOUND');
    expect(await tapRows(recognitionId)).toEqual([]);
    expect(await tapRows(pending.recognition_id)).toEqual([]);
    expect(await countedTaps(station.campaignId)).toBe(0);
  });

  it('A4: a tap on an unanswered chooser records that station as the listener’s choice and counts; a tap naming another station afterwards is 422 STATION_ALREADY_CHOSEN', async () => {
    const { stationA, stationB, install, recognitionId } = await answeredChooser();
    expect((await sendTap(install.installToken, tapBody(recognitionId, stationB.stationId, actionOf(stationB, 0)))).status).toBe(204);
    expect(await recognitionRow(recognitionId)).toMatchObject({ resolution: 'LISTENER_CHOICE', station_id: stationB.stationId });
    expect(await countedTaps(stationB.campaignId)).toBe(1);
    expectRefusal(await sendTap(install.installToken, tapBody(recognitionId, stationA.stationId, actionOf(stationA, 0))), 422, 'STATION_ALREADY_CHOSEN');
    expect((await tapRows(recognitionId)).map((row) => row.station_id)).toEqual([stationB.stationId]);
    expect(await countedTaps(stationA.campaignId)).toBe(0);
  });

  it('P4-LIMITS-05: taps count only on the campaign’s own card; once the limit is reached, a clip is answered with the client’s usual card, and a tap on it is stored and never counted', async () => {
    const { station, install, recognitionId, recording } = await answeredMatch({ engagementLimit: 1, hasDefaultCard: true });
    expect((await sendTap(install.installToken, tapBody(recognitionId, station.stationId, actionOf(station, 0)))).status).toBe(204);
    expect(await countedTaps(station.campaignId)).toBe(1);

    const atLimit = await identify(recording, install.installToken);
    expect(atLimit.body).toMatchObject({ status: 'MATCH', result: { kind: 'CLIENT_DEFAULT' } });
    expect((await recognitionRow(atLimit.body.recognition_id)).fallback_reason).toBe('campaign_at_tap_limit');
    const usualCallId = (station.defaultCard?.actions[0] as { id: string }).id;
    expect((await sendTap(install.installToken, tapBody(atLimit.body.recognition_id, station.stationId, usualCallId))).status).toBe(204);
    expect(await tapRows(atLimit.body.recognition_id)).toEqual([expect.objectContaining({ card_kind: 'CLIENT_DEFAULT', is_counted: false })]);
    expect(await countedTaps(station.campaignId)).toBe(1);
  });

  it('P4-TIMERULE-04: a clip heard before the limit was reached but received after it gets the client’s usual card', async () => {
    const { station, install, recognitionId, recording } = await answeredMatch({ engagementLimit: 1, hasDefaultCard: true });
    const heardBeforeTheTap = new Date(Date.now() - 60_000);
    expect((await sendTap(install.installToken, tapBody(recognitionId, station.stationId, actionOf(station, 0)))).status).toBe(204);
    const deferred = await identify(recording, install.installToken, {
      captured_at: heardBeforeTheTap.toISOString(),
      sent_at: new Date().toISOString(),
      is_deferred: 'true',
    });
    expect(deferred.body).toMatchObject({ status: 'MATCH', is_deferred: true, result: { kind: 'CLIENT_DEFAULT' } });
    expect((await recognitionRow(deferred.body.recognition_id)).fallback_reason).toBe('campaign_at_tap_limit');
  });

  it('P4-LIMITS-02, Q12: one install counts at most its daily cap of taps on one campaign; more are stored, not counted', async () => {
    const { station, install, recognitionId } = await answeredMatch({ engagementLimit: 100 });
    for (let position = 0; position < 3; position += 1) {
      expect((await sendTap(install.installToken, tapBody(recognitionId, station.stationId, actionOf(station, position)))).status).toBe(204);
    }
    expect((await tapRows(recognitionId)).map((row) => row.is_counted)).toEqual([true, true, false]);
    expect(await countedTaps(station.campaignId)).toBe(COUNTED_TAPS_PER_INSTALL);
  });

  it('P4-LIMITS-04, -06: 100 taps at once against a limit of 10 count exactly 10, and every one is stored', async () => {
    const recording = await testData.createRecording();
    const station = await air(recording, 'Race', { engagementLimit: 10 });
    const taps: Array<{ installToken: string; body: ReturnType<typeof tapBody> }> = [];
    const recognitionIds: string[] = [];
    while (taps.length < 100) {
      const install = await newInstall();
      const answer = await identify(recording, install.installToken);
      recognitionIds.push(answer.body.recognition_id);
      for (let position = 0; position < 3 && taps.length < 100; position += 1) {
        taps.push({ installToken: install.installToken, body: tapBody(answer.body.recognition_id, station.stationId, actionOf(station, position)) });
      }
    }
    // One agent for all of them, so the 100 requests share one listening server.
    const agent = client();
    const responses = await Promise.all(taps.map((tap) => sendTap(tap.installToken, tap.body, {}, agent)));
    expect(responses.map((response) => response.status)).toEqual(Array(100).fill(204));
    expect(await countedTaps(station.campaignId)).toBe(10);
    const stored = await setupClient.query('SELECT count(*)::integer AS taps, count(*) FILTER (WHERE is_counted)::integer AS counted FROM app.engagement_events WHERE campaign_id = $1', [
      station.campaignId,
    ]);
    expect(stored.rows[0]).toEqual({ taps: 100, counted: 10 });
  }, 120_000);

  it('P4-IDEMPOTENCY-20: a key, a tap and the key again: the same recognition id, one recognition row, and the counter at 1, moved by the tap alone', async () => {
    const recording = await testData.createRecording();
    const station = await air(recording, 'Replay', { engagementLimit: 10 });
    const install = await newInstall();
    const key = randomUUID();
    const first = await identify(recording, install.installToken, { idempotency_key: key });
    expect(await countedTaps(station.campaignId)).toBe(0);
    expect((await sendTap(install.installToken, tapBody(first.body.recognition_id, station.stationId, actionOf(station, 0)))).status).toBe(204);
    const replay = await identify(recording, install.installToken, { idempotency_key: key });
    expect(replay.body.recognition_id).toBe(first.body.recognition_id);
    expect((await setupClient.query('SELECT count(*)::integer AS rows FROM app.recognition_events WHERE id = $1', [first.body.recognition_id])).rows[0].rows).toBe(1);
    expect(await countedTaps(station.campaignId)).toBe(1);
  });

  it('the body is checked against the shared contract: the invalid fixtures are refused 400 naming each field, and the valid ones get through', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    for (const [name, fixture] of readEngagementFixtures('invalid')) {
      const response = await sendTap(install.installToken, fixture.body);
      expectRefusal(response, 400, 'VALIDATION_FAILED');
      expect(response.body.error.fields, name).toEqual(fixture.expected_issues);
      expect(JSON.stringify(response.body), name).not.toMatch(/\+447700900|\+260/);
    }
    expect(await tapRows(recognitionId)).toEqual([]);
    for (const [name, fixture] of readEngagementFixtures('valid')) {
      const body = { ...fixture.body, recognition_id: recognitionId, station_id: station.stationId, action_id: actionOf(station, name.startsWith('call') ? 0 : 1) };
      expect((await sendTap(install.installToken, body)).status, name).toBe(204);
    }
  });

  it('P4-ENGAGEMENTS-08 and the follow-ups’ order: the token (401), then the allowance shared with choices and reports (429), then the body (400)', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    expectRefusal(await sendTap(null, tapBody(recognitionId, station.stationId, actionOf(station, 0))), 401, 'INSTALL_TOKEN_INVALID');
    expectRefusal(await sendTap('made.up.token', tapBody(recognitionId, station.stationId, actionOf(station, 0))), 401, 'INSTALL_TOKEN_INVALID');
    const badBody = await sendTap(install.installToken, { recognition_id: recognitionId });
    expectRefusal(badBody, 400, 'VALIDATION_FAILED');
    for (let sent = 1; sent < FOLLOW_UPS_PER_MINUTE; sent += 1) await sendTap(install.installToken, tapBody(recognitionId, station.stationId, actionOf(station, 0)));
    const limited = await sendTap(install.installToken, { recognition_id: recognitionId });
    expectRefusal(limited, 429, 'RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(await tapRows(recognitionId)).toHaveLength(1);
  });

  it('P4-CHOICE-08 (tap half): taps share one allowance with choices and reports: once choices and a report have used the minute, a tap is refused 429 and not stored', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    const followUp = (path: string, body: object) =>
      client().post(path).set('X-Forwarded-For', randomClientAddress()).set('Authorization', `Bearer ${install.installToken}`).send(body);
    // A choice on an answer that was not a chooser is refused, but it is counted all the same.
    for (let sent = 0; sent < FOLLOW_UPS_PER_MINUTE - 1; sent += 1) {
      expect((await followUp(`/api/v1/recognitions/${recognitionId}/choice`, { station_id: station.stationId })).status).not.toBe(429);
    }
    expect((await followUp(`/api/v1/recognitions/${recognitionId}/report`, { station_id: station.stationId, reason: 'SOMETHING_ELSE' })).status).toBe(204);
    const limited = await sendTap(install.installToken, tapBody(recognitionId, station.stationId, actionOf(station, 0)));
    expectRefusal(limited, 429, 'RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(await tapRows(recognitionId)).toEqual([]);
    // Another install still taps.
    const other = await answeredMatch();
    expect((await sendTap(other.install.installToken, tapBody(other.recognitionId, other.station.stationId, actionOf(other.station, 0)))).status).toBe(204);
  });

  it('ALL-SECURITY-09: a cookie request from another site is refused 403 before anything else', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    const crossSite = await sendTap(install.installToken, tapBody(recognitionId, station.stationId, actionOf(station, 0)), {
      Cookie: 'session=example',
      Origin: 'https://elsewhere.example.com',
    });
    expectRefusal(crossSite, 403, 'FORBIDDEN');
    expect(await tapRows(recognitionId)).toEqual([]);
  });

  it('logs one line per tap with its outcome, and never the install, its token, the station or the button', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    const callId = actionOf(station, 0);
    const recorded = await sendTap(install.installToken, tapBody(recognitionId, station.stationId, callId));
    const repeated = await sendTap(install.installToken, tapBody(recognitionId, station.stationId, callId));
    await waitForLogWrites();
    for (const [response, outcome] of [[recorded, 'RECORDED'], [repeated, 'ALREADY_RECORDED']] as const) {
      const lines = linesOf(response);
      expect(lines.filter((line) => line.msg === `tap ${outcome}`)).toEqual([expect.objectContaining({ level: 30, recognitionId, outcome })]);
      const written = JSON.stringify(lines);
      for (const secret of [install.installId, install.rowId, install.installToken, station.stationId, callId]) expect(written).not.toContain(secret);
    }
  });

  it('ALL-ERRORS-02 to -04: a database failure or a programming error underneath is a generic 500, with the stack in the log under the request id', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    const engagements = testApplication.application.get(Engagements);
    const driverError = Object.assign(new Error('duplicate key value violates unique constraint "engagement_deduplication_keys_primary_key"'), { code: '23505', severity: 'ERROR' });
    const failures = [
      new QueryFailedError('SELECT recognition.record_engagement($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS answer', [recognitionId], driverError),
      new TypeError("Cannot read properties of undefined (reading 'answer')"),
    ];
    for (const failure of failures) {
      const spy = vi.spyOn(engagements, 'record').mockRejectedValueOnce(failure);
      try {
        const response = await sendTap(install.installToken, tapBody(recognitionId, station.stationId, actionOf(station, 0)));
        expectRefusal(response, 500, 'INTERNAL');
        expect(JSON.stringify(response.body)).not.toMatch(/duplicate key|engagement_deduplication|TypeError|SQLSTATE|23505/);
        await waitForLogWrites();
        const logLine = testApplication.logs.find((line) => line.requestId === response.headers['x-request-id'] && line.level === 50);
        expect((logLine?.err as { stack?: string } | undefined)?.stack, failure.name).toContain(failure.name);
      } finally {
        spy.mockRestore();
      }
    }
    expect(await tapRows(recognitionId)).toEqual([]);
  });
});
