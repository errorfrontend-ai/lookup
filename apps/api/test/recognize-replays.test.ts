import { randomUUID } from 'node:crypto';
import { RecognizeResponse } from '@lookup/contracts';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { RecognitionService } from '../src/features/recognition/recognition.service.js';
import { RecognizeQueue } from '../src/infrastructure/job-queues/recognize-queue.js';
import { databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { defaultRecognizeFields, type FakeWorkerAnswer, FakeRecognizeWorker, match, noMatch, recognize, registerInstall } from './support/listener-test-kit.js';
import { type Recording, type StationAiring, StationResolutionTestData, type TimeWindowSpecification } from './support/station-resolution-test-data.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * The same clip sent again (P4 design §5.4, P4-D13): a finished recognition is answered from what was stored, with
 * the same id, status, card versions and chooser order, minus any station no longer ACTIVE; no job, no row and no
 * counter changes. A recognition that was not finished is tried again on the same row, at the first capture time.
 */
describe('POST /api/v1/recognize: replays and retries of one key', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  let testData: StationResolutionTestData;
  let worker: FakeRecognizeWorker;
  let recognizeQueue: RecognizeQueue;
  const installRows: string[] = [];
  const runTag = randomUUID().slice(0, 6);
  const client = () => supertest(testApplication.application.getHttpServer());

  const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
  const utcClock = (moment: Date) => moment.toISOString().slice(11, 16);
  const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000);
  const slot = (fromHours: number, toHours: number): TimeWindowSpecification[] => [{ days: EVERY_DAY, from: utcClock(hoursFromNow(fromHours)), to: utcClock(hoursFromNow(toHours)) }];
  const air = (recording: Recording, name: string, options: Omit<Parameters<StationResolutionTestData['airAd']>[0], 'recording'> = {}) =>
    testData.airAd({ recording, gracePeriodMinutes: 0, ...options, station: { name: `Replay ${runTag} ${name}`, timeZone: 'UTC', ...options.station } });

  async function newInstall() {
    const install = await registerInstall(client);
    const hash = testApplication.application.get(InstallTokens).hashInstallId(install.installId);
    const row = await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash]);
    installRows.push(row.rows[0].id as string);
    return { ...install, rowId: row.rows[0].id as string };
  }

  const eventRow = async (recognitionId: string) => (await setupClient.query('SELECT * FROM app.recognition_events WHERE id = $1', [recognitionId])).rows[0] as Record<string, unknown>;
  const candidateRows = async (recognitionId: string) =>
    (await setupClient.query('SELECT * FROM app.recognition_candidates WHERE recognition_id = $1 ORDER BY station_id', [recognitionId])).rows as Array<Record<string, unknown>>;
  /** Everything stored about a recognition, to show a replay changes none of it. */
  const storedState = async (recognitionId: string) => ({ event: await eventRow(recognitionId), candidates: await candidateRows(recognitionId) });
  /** An answer without the per-request id, which is new on every send. */
  const withoutRequestId = (body: Record<string, unknown>) => ({ ...body, request_id: undefined });
  const setStationStatus = (airing: StationAiring, status: string) => setupClient.query('UPDATE app.stations SET status = $2 WHERE id = $1', [airing.stationId, status]);

  /** Sends a key, then sends the same key again; returns both answers, and the stored rows and job count around the replay. */
  async function sendTwice(answer: () => FakeWorkerAnswer, fields: Record<string, string> = defaultRecognizeFields()) {
    worker.answer = answer;
    const { installToken } = await newInstall();
    const first = await recognize(client, { installToken, fields });
    const jobsAfterFirst = worker.receivedJobs.length;
    const recognitionId = first.body.recognition_id ?? (await setupClient.query('SELECT id FROM app.recognition_events WHERE request_id = $1', [first.headers['x-request-id']])).rows[0]?.id;
    const before = await storedState(recognitionId);
    const again = await recognize(client, { installToken, fields });
    return { first, again, recognitionId: recognitionId as string, before, after: await storedState(recognitionId), newJobs: worker.receivedJobs.length - jobsAfterFirst, installToken };
  }

  beforeAll(async () => {
    testApplication = await createTestApplication();
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
    worker.receivedJobs.length = 0;
    testApplication.application.get(RecognitionService).circuitBreaker.close();
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();
  });
  afterEach(() => {
    worker.releaseHungJobs();
    worker.resume();
  });
  afterAll(async () => {
    await worker.close();
    await setupClient.query(`DELETE FROM app.recognition_candidates WHERE recognition_id IN (SELECT id FROM app.recognition_events WHERE listener_install_id = ANY($1))`, [installRows]);
    await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRows]);
    await testData.removeAll();
    await Promise.all([setupClient.end(), apiClient.end()]);
    await testApplication.close();
  });

  it.each<[string, () => Promise<() => FakeWorkerAnswer>, string]>([
    ['MATCH', async () => {
      const recording = await testData.createRecording();
      await air(recording, 'match');
      return () => match(recording.assetNumber);
    }, 'MATCH'],
    ['MATCH_DEFAULT', async () => {
      const recording = await testData.createRecording();
      await air(recording, 'usual card', { windows: slot(2, 3), hasDefaultCard: true });
      return () => match(recording.assetNumber);
    }, 'MATCH'],
    ['NO_MATCH', async () => () => noMatch(), 'NO_MATCH'],
    ['AMBIGUOUS', async () => {
      const recording = await testData.createRecording();
      await air(recording, 'ambiguous');
      return () => match(recording.assetNumber, { status: 'AMBIGUOUS', match_margin: 1.1 });
    }, 'NO_MATCH'],
    ['CHOOSE_STATION', async () => {
      const recording = await testData.createRecording();
      await air(recording, 'A');
      await air(recording, 'B');
      return () => match(recording.assetNumber);
    }, 'CHOOSE_STATION'],
  ])('P4-IDEMPOTENCY-06, -07, -08, -11: a finished %s is answered again the same way, with no job and no stored change', async (storedOutcome, prepare, answeredStatus) => {
    const answer = await prepare();
    const { first, again, recognitionId, before, after, newJobs } = await sendTwice(answer);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(RecognizeResponse.safeParse(again.body).success).toBe(true);
    expect(again.body.status).toBe(answeredStatus);
    expect(withoutRequestId(again.body)).toEqual(withoutRequestId(first.body));
    expect(again.body.request_id).toBe(again.headers['x-request-id']);
    expect(before.event.outcome).toBe(storedOutcome);
    expect(newJobs).toBe(0);
    expect(after).toEqual(before);
    expect(recognitionId).toBe(first.body.recognition_id);
  });

  it('P4-IDEMPOTENCY-11: a clip the worker could not use is answered 400 INVALID_AUDIO again, with no job', async () => {
    const { first, again, before, after, newJobs } = await sendTwice(() => ({ fail: 'INVALID_AUDIO' }));
    expect(first.status).toBe(400);
    expect(again.status).toBe(400);
    expect(again.body.error).toMatchObject({ code: 'INVALID_AUDIO', request_id: again.headers['x-request-id'] });
    expect(before.event.outcome).toBe('INVALID_AUDIO');
    expect(newJobs).toBe(0);
    expect(after).toEqual(before);
  });

  it('a chooser is answered again with the same stations, cards and order after the listener chose one', async () => {
    const recording = await testData.createRecording();
    const stationA = await air(recording, 'A');
    await air(recording, 'B');
    worker.answer = () => match(recording.assetNumber);
    const { installToken, rowId } = await newInstall();
    const fields = defaultRecognizeFields();
    const first = await recognize(client, { installToken, fields });
    expect(first.body.status).toBe('CHOOSE_STATION');
    const chosen = await apiClient.query('SELECT recognition.record_station_choice($1, $2, $3) AS answer', [first.body.recognition_id, rowId, stationA.stationId]);
    expect(chosen.rows[0].answer).toBe('CHOSEN');
    const before = await storedState(first.body.recognition_id);
    const again = await recognize(client, { installToken, fields });
    expect(withoutRequestId(again.body)).toEqual(withoutRequestId(first.body));
    expect(await storedState(first.body.recognition_id)).toEqual(before);
    expect(before.event).toMatchObject({ resolution: 'LISTENER_CHOICE', station_id: stationA.stationId });
  });

  it('P4-IDEMPOTENCY-10: a card edited between the send and the replay: the replay shows the version first shown', async () => {
    const recording = await testData.createRecording();
    const airing = await air(recording, 'A');
    worker.answer = () => match(recording.assetNumber);
    const { installToken } = await newInstall();
    const fields = defaultRecognizeFields();
    const first = await recognize(client, { installToken, fields });
    const edited = await testData.createCard(airing.stationId, airing.clientId);
    await setupClient.query('UPDATE app.campaigns SET action_card_id = $2 WHERE id = $1', [airing.campaignId, edited.cardId]);
    const again = await recognize(client, { installToken, fields });
    expect(again.body.result.card.actions).toEqual(airing.campaignCard?.actions);
    expect(again.body.result.card.actions).not.toEqual(edited.content.actions);
    expect(again.body.result).toEqual(first.body.result);
  });

  it('P4-IDEMPOTENCY-09: a recognition and its replay leave the campaign’s tap counter as it was', async () => {
    const recording = await testData.createRecording();
    const airing = await air(recording, 'A', { engagementLimit: 10 });
    await setupClient.query('INSERT INTO app.campaign_counters (campaign_id, station_id, counted_engagement_count) VALUES ($1, $2, 3)', [airing.campaignId, airing.stationId]);
    const counter = async () => (await setupClient.query('SELECT counted_engagement_count FROM app.campaign_counters WHERE campaign_id = $1', [airing.campaignId])).rows[0].counted_engagement_count;
    const { first, again } = await sendTwice(() => match(recording.assetNumber));
    expect(first.body.status).toBe('MATCH');
    expect(again.body.recognition_id).toBe(first.body.recognition_id);
    expect(await counter()).toBe(3);
  });

  it('P4-D13, P4-RESOLUTION-14: a station suspended since is left out of a replay: a match becomes NO_MATCH with the same id', async () => {
    const recording = await testData.createRecording();
    const airing = await air(recording, 'A');
    worker.answer = () => match(recording.assetNumber);
    const { installToken } = await newInstall();
    const fields = defaultRecognizeFields();
    const first = await recognize(client, { installToken, fields });
    await setStationStatus(airing, 'SUSPENDED');
    const replayed = await recognize(client, { installToken, fields });
    expect(replayed.body).toEqual({ status: 'NO_MATCH', recognition_id: first.body.recognition_id, request_id: replayed.headers['x-request-id'], is_deferred: false, captured_at: first.body.captured_at });
    // Active again: the stored answer comes back unchanged.
    await setStationStatus(airing, 'ACTIVE');
    expect(withoutRequestId((await recognize(client, { installToken, fields })).body)).toEqual(withoutRequestId(first.body));
  });

  it('P4-D13: a chooser replay drops a suspended station and keeps the order; one left is a MATCH with its stored card; none left is NO_MATCH', async () => {
    const recording = await testData.createRecording();
    const stationA = await air(recording, 'A');
    const stationB = await air(recording, 'B', { hasDefaultCard: true, engagementLimit: 1 });
    const stationC = await air(recording, 'C');
    // Station B is at its tap limit, so it is offered with its client's usual card.
    await setupClient.query('INSERT INTO app.campaign_counters (campaign_id, station_id, counted_engagement_count) VALUES ($1, $2, 1)', [stationB.campaignId, stationB.stationId]);
    worker.answer = () => match(recording.assetNumber);
    const { installToken } = await newInstall();
    const fields = defaultRecognizeFields();
    const first = await recognize(client, { installToken, fields });
    expect(first.body.candidates.map((candidate: { station: { id: string }; kind: string }) => [candidate.station.id, candidate.kind])).toEqual([
      [stationA.stationId, 'CAMPAIGN'],
      [stationB.stationId, 'CLIENT_DEFAULT'],
      [stationC.stationId, 'CAMPAIGN'],
    ]);

    await setStationStatus(stationA, 'SUSPENDED');
    const twoLeft = await recognize(client, { installToken, fields });
    expect(twoLeft.body.candidates).toEqual([first.body.candidates[1], first.body.candidates[2]]);

    await setStationStatus(stationC, 'SUSPENDED');
    const oneLeft = await recognize(client, { installToken, fields });
    expect(oneLeft.body).toMatchObject({ status: 'MATCH', recognition_id: first.body.recognition_id, result: first.body.candidates[1] });
    expect(oneLeft.body.result.kind).toBe('CLIENT_DEFAULT');

    await setStationStatus(stationB, 'SUSPENDED');
    expect((await recognize(client, { installToken, fields })).body).toMatchObject({ status: 'NO_MATCH', recognition_id: first.body.recognition_id });
  });

  it('a replay answers the stored deferred flag and capture time, not the ones sent again', async () => {
    const recording = await testData.createRecording();
    await air(recording, 'A');
    worker.answer = () => match(recording.assetNumber);
    const { installToken } = await newInstall();
    const key = randomUUID();
    const now = Date.now();
    const first = await recognize(client, {
      installToken,
      fields: { ...defaultRecognizeFields(), idempotency_key: key, captured_at: new Date(now - 3 * 3_600_000).toISOString(), sent_at: new Date(now).toISOString(), is_deferred: 'true' },
    });
    expect(first.body).toMatchObject({ status: 'MATCH', is_deferred: true });
    const again = await recognize(client, { installToken, fields: { ...defaultRecognizeFields(), idempotency_key: key } });
    expect(again.body).toMatchObject({ is_deferred: true, captured_at: first.body.captured_at, recognition_id: first.body.recognition_id });
  });

  it('P4-IDEMPOTENCY-11, -13: a key refused as busy is tried again on the same recognition, then answered like any other', async () => {
    const recording = await testData.createRecording();
    await air(recording, 'A');
    worker.answer = () => match(recording.assetNumber);
    const { installToken } = await newInstall();
    const fields = defaultRecognizeFields();
    await worker.stopHeartbeat();
    await recognizeQueue.refreshAdmission();
    const busy = await recognize(client, { installToken, fields });
    expect(busy.status).toBe(503);
    const busyRow = (await setupClient.query('SELECT id, outcome FROM app.recognition_events WHERE request_id = $1', [busy.headers['x-request-id']])).rows[0];
    expect(busyRow.outcome).toBe('BUSY');
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();

    const retried = await recognize(client, { installToken, fields });
    expect(retried.body).toMatchObject({ status: 'MATCH', recognition_id: busyRow.id });
    expect(await eventRow(busyRow.id)).toMatchObject({ outcome: 'MATCH', attempt_count: 2, resolution: 'SINGLE_OWNER' });
    expect(withoutRequestId((await recognize(client, { installToken, fields })).body)).toEqual(withoutRequestId(retried.body));
  });

  it('P4-IDEMPOTENCY-22: a retry is resolved at the moment the clip was first heard, and answered with that moment', async () => {
    // On air from 4 to 2 hours ago: a clip heard 3 hours ago was on air; one heard now is not, and has no usual card.
    const recording = await testData.createRecording();
    const airing = await air(recording, 'A', { windows: slot(-4, -2) });
    worker.answer = () => ({ hang: true });
    const { installToken } = await newInstall();
    const key = randomUUID();
    const now = Date.now();
    const heardThreeHoursAgo = { ...defaultRecognizeFields(), idempotency_key: key, captured_at: new Date(now - 3 * 3_600_000).toISOString(), sent_at: new Date(now).toISOString(), is_deferred: 'true' };
    const timedOut = await recognize(client, { installToken, fields: heardThreeHoursAgo });
    expect(timedOut.status).toBe(503);
    worker.releaseHungJobs();

    // The retry says it was heard just now; the server keeps the first moment, when the ad was on air.
    worker.answer = () => match(recording.assetNumber);
    const retried = await recognize(client, { installToken, fields: { ...defaultRecognizeFields(), idempotency_key: key } });
    expect(retried.body).toMatchObject({ status: 'MATCH', is_deferred: true, result: { kind: 'CAMPAIGN', station: { id: airing.stationId } } });
    const stored = await eventRow(retried.body.recognition_id);
    expect((stored.captured_at as Date).toISOString()).toBe(retried.body.captured_at);
    expect(Math.abs(new Date(retried.body.captured_at).getTime() - (now - 3 * 3_600_000))).toBeLessThan(5_000);
    expect(stored).toMatchObject({ attempt_count: 2, is_deferred: true });
  });

  it('P4-DEFERRED-01, P4-IDEMPOTENCY-22: a clip refused as busy when sent live and then sent from the phone’s saved clips is stored and answered as deferred', async () => {
    const recording = await testData.createRecording();
    await air(recording, 'A');
    worker.answer = () => match(recording.assetNumber);
    const { installToken } = await newInstall();
    const live = defaultRecognizeFields();
    await worker.stopHeartbeat();
    await recognizeQueue.refreshAdmission();
    const busy = await recognize(client, { installToken, fields: live });
    expect(busy.status).toBe(503);
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();
    const fromTheOutbox = await recognize(client, { installToken, fields: { ...live, sent_at: new Date().toISOString(), is_deferred: 'true' } });
    expect(fromTheOutbox.body).toMatchObject({ status: 'MATCH', is_deferred: true });
    expect((await eventRow(fromTheOutbox.body.recognition_id)).is_deferred).toBe(true);
    // Sent once more as live, it stays deferred: true is never turned back to false.
    const replayed = await recognize(client, { installToken, fields: live });
    expect(replayed.body.is_deferred).toBe(true);
  });
});
