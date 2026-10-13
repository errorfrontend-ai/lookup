import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type pg from 'pg';
import supertest from 'supertest';
import { QueryFailedError } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidVersion7 } from '../src/common/identifiers/uuid-version-7.js';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { RecognitionRecords } from '../src/features/recognition/recognition-records.js';
import { RecognitionService } from '../src/features/recognition/recognition.service.js';
import { RecognizeQueue } from '../src/infrastructure/job-queues/recognize-queue.js';
import { databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { FakeRecognizeWorker, match, noMatch, randomClientAddress, recognize, registerInstall } from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, PortalTestUsers } from './support/portal-test-users.js';
import { type Recording, type StationAiring, StationResolutionTestData, type TimeWindowSpecification } from './support/station-resolution-test-data.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/** This file's follow-up allowance per install and minute, low so the allowance is reached quickly (60 in production). */
const FOLLOW_UPS_PER_MINUTE = 8;
const CHOICE_FIXTURES = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'contracts', 'fixtures', 'recognition', 'station-choice-input');

interface ChoiceFixture {
  description: string;
  body: unknown;
  expected_issues?: Array<{ path: string; code: string }>;
}

function readChoiceFixtures(folder: 'valid' | 'invalid'): Array<[string, ChoiceFixture]> {
  return readdirSync(resolve(CHOICE_FIXTURES, folder))
    .filter((fileName) => fileName.endsWith('.json'))
    .sort()
    .map((fileName) => [fileName.replace(/\.json$/, ''), JSON.parse(readFileSync(resolve(CHOICE_FIXTURES, folder, fileName), 'utf8')) as ChoiceFixture]);
}

/**
 * POST /api/v1/recognitions/{recognition_id}/choice (P4 design §5.5, §6.4; contract §1.3): the station a listener
 * picked in the "Which station?" sheet, against the real API and database, after a real chooser answered by
 * POST /api/v1/recognize with a stand-in worker. Stations keep UTC time here, so a slot can be placed a few hours
 * around now on any day.
 */
describe('POST /api/v1/recognitions/{recognition_id}/choice', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  let testData: StationResolutionTestData;
  let testUsers: PortalTestUsers;
  let worker: FakeRecognizeWorker;
  let recognizeQueue: RecognizeQueue;
  const installRows: string[] = [];
  const runTag = randomUUID().slice(0, 6);
  const client = () => supertest(testApplication.application.getHttpServer());

  const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
  const utcClock = (moment: Date) => moment.toISOString().slice(11, 16);
  /** One slot every day, two to three hours from now (UTC): never on air while a test runs. */
  const OFF_AIR: TimeWindowSpecification[] = [{ days: EVERY_DAY, from: utcClock(new Date(Date.now() + 2 * 3_600_000)), to: utcClock(new Date(Date.now() + 3 * 3_600_000)) }];

  /** A station of this run airing the recording: on air all day unless windows are given; UTC; no grace. */
  const air = (recording: Recording, name: string, options: Omit<Parameters<StationResolutionTestData['airAd']>[0], 'recording'> = {}) =>
    testData.airAd({ recording, gracePeriodMinutes: 0, ...options, station: { name: `Choice ${runTag} ${name}`, timeZone: 'UTC', ...options.station } });

  /** A new listener install: its token, its own install id (what the phone made) and the row id the database knows it by. */
  async function newInstall() {
    const install = await registerInstall(client);
    const hash = testApplication.application.get(InstallTokens).hashInstallId(install.installId);
    const rowId = (await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash])).rows[0].id as string;
    installRows.push(rowId);
    return { ...install, rowId };
  }

  /** A listener's clip of the recording; every answer must be a 200. */
  async function identify(recording: Recording, installToken: string, fields: Record<string, string | undefined> = {}) {
    worker.answer = () => match(recording.assetNumber);
    const response = await recognize(client, { installToken, fields });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response;
  }

  /**
   * A real chooser: Stations A and B have the recording on air (A listed first, by name); Station C owns it too, off
   * air with its client's usual card, so it is weighed but not shown.
   */
  async function answeredChooser() {
    const recording = await testData.createRecording();
    const stationA = await air(recording, 'A');
    const stationB = await air(recording, 'B');
    const offAir = await air(recording, 'C', { windows: OFF_AIR, hasDefaultCard: true });
    const install = await newInstall();
    const answer = await identify(recording, install.installToken);
    expect(answer.body.status).toBe('CHOOSE_STATION');
    expect(answer.body.candidates.map((candidate: { station: { id: string } }) => candidate.station.id)).toEqual([stationA.stationId, stationB.stationId]);
    return { recording, stationA, stationB, offAir, install, recognitionId: answer.body.recognition_id as string, answer };
  }

  const choose = (installToken: string | null, recognitionId: string, body: unknown, headers: Record<string, string> = {}) => {
    let request = client().post(`/api/v1/recognitions/${recognitionId}/choice`).set('X-Forwarded-For', randomClientAddress());
    if (installToken !== null) request = request.set('Authorization', `Bearer ${installToken}`);
    for (const [name, value] of Object.entries(headers)) request = request.set(name, value);
    return request.send(body as object);
  };
  const expectRefusal = (response: supertest.Response, httpStatus: number, code: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(httpStatus);
    expect(assertErrorEnvelope(response.body).error).toMatchObject({ code, request_id: response.headers['x-request-id'] });
  };

  const eventRow = async (recognitionId: string) =>
    (await setupClient.query('SELECT outcome, resolution, station_id, campaign_id, action_card_id FROM app.recognition_events WHERE id = $1', [recognitionId]))
      .rows[0] as Record<string, unknown>;
  const candidateRows = async (recognitionId: string) =>
    (
      await setupClient.query(
        `SELECT station_id, campaign_id, action_card_id, card_kind, is_in_window, display_position, is_chosen, chosen_at
           FROM app.recognition_candidates WHERE recognition_id = $1 ORDER BY display_position NULLS LAST, station_id`,
        [recognitionId],
      )
    ).rows as Array<Record<string, unknown>>;
  const chosenStations = async (recognitionId: string) => (await candidateRows(recognitionId)).filter((row) => row.is_chosen).map((row) => row.station_id);
  const countersOf = async (...airings: StationAiring[]) =>
    (await setupClient.query('SELECT campaign_id, counted_engagement_count FROM app.campaign_counters WHERE campaign_id = ANY($1)', [airings.map((airing) => airing.campaignId)]))
      .rows;

  beforeAll(async () => {
    const config = { ...loadAppConfig(), RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE: FOLLOW_UPS_PER_MINUTE };
    testApplication = await createTestApplication({ overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config) });
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await Promise.all([setupClient.connect(), apiClient.connect()]);
    testData = new StationResolutionTestData(setupClient);
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
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
    // Taps recorded straight through the database (the A4 test) go first, then everything else of these installs.
    const ofTheseInstalls = 'SELECT id FROM app.recognition_events WHERE listener_install_id = ANY($1)';
    await setupClient.query(`DELETE FROM app.engagement_deduplication_keys WHERE recognition_id IN (${ofTheseInstalls})`, [installRows]);
    await setupClient.query(`DELETE FROM app.engagement_events WHERE recognition_id IN (${ofTheseInstalls})`, [installRows]);
    await setupClient.query(`DELETE FROM app.recognition_candidates WHERE recognition_id IN (${ofTheseInstalls})`, [installRows]);
    await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRows]);
    await testUsers.cleanUp();
    await testData.removeAll();
    await Promise.all([setupClient.end(), apiClient.end()]);
    await testApplication.close();
  });

  it('P4-CHOICE-01, -04 to -06, P6-TESTS-07 (part 2): a shown station’s id is accepted with 204 and no body, and the recognition takes the listener’s choice with that station’s campaign and card', async () => {
    const { stationA, stationB, offAir, install, recognitionId, answer } = await answeredChooser();
    // The id the app posts is the one the chooser showed for that station.
    const response = await choose(install.installToken, recognitionId, { station_id: answer.body.candidates[1].station.id });
    expect(response.status, JSON.stringify(response.body)).toBe(204);
    expect(response.text).toBe('');

    expect(await eventRow(recognitionId)).toEqual({
      outcome: 'CHOOSE_STATION',
      resolution: 'LISTENER_CHOICE',
      station_id: stationB.stationId,
      campaign_id: stationB.campaignId,
      action_card_id: stationB.campaignCardId,
    });
    const rows = await candidateRows(recognitionId);
    expect(rows.map((row) => [row.station_id, row.display_position, row.is_chosen])).toEqual([
      [stationA.stationId, 1, false],
      [stationB.stationId, 2, true],
      [offAir.stationId, null, false],
    ]);
    expect(rows.find((row) => row.is_chosen)?.chosen_at).toEqual(expect.any(Date));
    expect(rows.filter((row) => !row.is_chosen).map((row) => row.chosen_at)).toEqual([null, null]);
  });

  it('P4-CHOICE-02, P6-OUTBOX-05 (a choice): the same choice sent three times answers 204 each time, keeps one chosen row and moves no counter', async () => {
    const { stationA, stationB, install, recognitionId } = await answeredChooser();
    expect((await choose(install.installToken, recognitionId, { station_id: stationA.stationId })).status).toBe(204);
    const afterTheFirst = await candidateRows(recognitionId);
    for (let resend = 0; resend < 2; resend += 1) {
      const repeated = await choose(install.installToken, recognitionId, { station_id: stationA.stationId });
      expect(repeated.status).toBe(204);
      expect(repeated.text).toBe('');
    }
    expect(await candidateRows(recognitionId)).toEqual(afterTheFirst);
    expect(await chosenStations(recognitionId)).toEqual([stationA.stationId]);
    expect((await eventRow(recognitionId)).station_id).toBe(stationA.stationId);
    expect(await countersOf(stationA, stationB)).toEqual([]);
  });

  it('P4-CHOICE-03: a station that was not shown is refused with 422 STATION_NOT_A_CANDIDATE, and nothing changes', async () => {
    const { offAir, install, recognitionId } = await answeredChooser();
    const elsewhere = await air(await testData.createRecording(), 'elsewhere');
    const before = { event: await eventRow(recognitionId), candidates: await candidateRows(recognitionId) };
    // Weighed but not shown (off air), a station of another recording, and an id that is no station at all.
    for (const stationId of [offAir.stationId, elsewhere.stationId, randomUUID()]) {
      const refused = await choose(install.installToken, recognitionId, { station_id: stationId });
      expectRefusal(refused, 422, 'STATION_NOT_A_CANDIDATE');
      expect(refused.body.error.message).toBe("That station isn't one shown for this recording.");
    }
    expect({ event: await eventRow(recognitionId), candidates: await candidateRows(recognitionId) }).toEqual(before);
    expect(before.event.resolution).toBe('UNRESOLVED');
  });

  it('the first choice wins: another station chosen later is refused with 422 STATION_ALREADY_CHOSEN, and the first stays', async () => {
    const { stationA, stationB, install, recognitionId } = await answeredChooser();
    expect((await choose(install.installToken, recognitionId, { station_id: stationB.stationId })).status).toBe(204);
    const refused = await choose(install.installToken, recognitionId, { station_id: stationA.stationId });
    expectRefusal(refused, 422, 'STATION_ALREADY_CHOSEN');
    expect(refused.body.error.message).toBe('A station was already chosen for this recording.');
    expect(await chosenStations(recognitionId)).toEqual([stationB.stationId]);
    expect(await eventRow(recognitionId)).toMatchObject({ resolution: 'LISTENER_CHOICE', station_id: stationB.stationId });
    // The first choice sent again is still fine.
    expect((await choose(install.installToken, recognitionId, { station_id: stationB.stationId })).status).toBe(204);
  });

  it('A4, P4-ENGAGEMENTS-13 (choice half): after a tap on Station A of a chooser nobody answered, a choice of Station B gets 422 STATION_ALREADY_CHOSEN', async () => {
    const { stationA, stationB, install, recognitionId } = await answeredChooser();
    // The tap as the engagements route (piece 5) will record it: through recognition.record_engagement, as the API role.
    const callButton = (stationA.campaignCard?.actions[0] as { id: string }).id;
    const tapped = await apiClient.query('SELECT recognition.record_engagement($1, $2, $3, $4, $5, now(), now(), 0, now(), $6, NULL) AS answer', [
      uuidVersion7(), recognitionId, install.rowId, stationA.stationId, callButton, `request-${randomUUID()}`,
    ]);
    expect(tapped.rows[0].answer).toBe('RECORDED');

    expectRefusal(await choose(install.installToken, recognitionId, { station_id: stationB.stationId }), 422, 'STATION_ALREADY_CHOSEN');
    expect((await choose(install.installToken, recognitionId, { station_id: stationA.stationId })).status).toBe(204);
    expect(await chosenStations(recognitionId)).toEqual([stationA.stationId]);
    expect(await eventRow(recognitionId)).toMatchObject({ resolution: 'LISTENER_CHOICE', station_id: stationA.stationId });
  });

  it('P4-CHOICE-07: without a valid install token the answer is 401 INSTALL_TOKEN_INVALID, and nothing changes', async () => {
    const { stationA, install, recognitionId } = await answeredChooser();
    // A token whose signature no longer matches: its first character changed (the last one may only carry padding bits).
    const [header, payload, signature = ''] = install.installToken.split('.');
    const tampered = `${header}.${payload}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    for (const response of [
      await choose(null, recognitionId, { station_id: stationA.stationId }),
      await choose('not-a-token', recognitionId, { station_id: stationA.stationId }),
      await choose(tampered, recognitionId, { station_id: stationA.stationId }),
      await choose(null, recognitionId, { station_id: stationA.stationId }, { Authorization: `Basic ${install.installToken}` }),
    ]) {
      expectRefusal(response, 401, 'INSTALL_TOKEN_INVALID');
    }
    expect(await eventRow(recognitionId)).toMatchObject({ resolution: 'UNRESOLVED', station_id: null });
    expect(await chosenStations(recognitionId)).toEqual([]);
  });

  it('another install’s chooser, an unknown recognition id and a recognition that is not a chooser all answer the same 404 NOT_FOUND', async () => {
    const { stationA, recognitionId } = await answeredChooser();
    const otherInstall = await newInstall();
    const singleOwner = await testData.createRecording();
    const onlyStation = await air(singleOwner, 'only');
    const matched = await identify(singleOwner, otherInstall.installToken);
    expect(matched.body.status).toBe('MATCH');

    const refusals = [
      await choose(otherInstall.installToken, recognitionId, { station_id: stationA.stationId }),
      await choose(otherInstall.installToken, uuidVersion7(), { station_id: stationA.stationId }),
      await choose(otherInstall.installToken, matched.body.recognition_id, { station_id: onlyStation.stationId }),
    ];
    for (const refused of refusals) expectRefusal(refused, 404, 'NOT_FOUND');
    // Nothing tells them apart: the same code and words for each.
    expect(new Set(refusals.map((refused) => JSON.stringify({ ...refused.body.error, request_id: undefined }))).size).toBe(1);
    expect(await eventRow(recognitionId)).toMatchObject({ resolution: 'UNRESOLVED', station_id: null });
  });

  it('a recognition id in the path that is not a lower-case UUID version 7 is refused with 400, naming recognition_id and never the value', async () => {
    const { stationA, install, recognitionId } = await answeredChooser();
    for (const malformed of [recognitionId.toUpperCase(), randomUUID(), 'not-a-recognition', `${recognitionId}0`, recognitionId.replaceAll('-', '')]) {
      const refused = await choose(install.installToken, malformed, { station_id: stationA.stationId });
      expectRefusal(refused, 400, 'VALIDATION_FAILED');
      expect(refused.body.error.fields).toEqual([{ path: 'recognition_id', code: 'invalid_format' }]);
      expect(JSON.stringify(refused.body)).not.toContain(malformed);
    }
    expect(await chosenStations(recognitionId)).toEqual([]);
  });

  it('the body is checked against the shared contract: each invalid fixture is refused with exactly its issues, and the valid one gets through to the work', async () => {
    const { install, recognitionId } = await answeredChooser();
    const invalid = readChoiceFixtures('invalid');
    expect(invalid.length).toBeGreaterThanOrEqual(4);
    for (const [name, fixture] of invalid) {
      const refused = await choose(install.installToken, recognitionId, fixture.body);
      expectRefusal(refused, 400, 'VALIDATION_FAILED');
      expect(refused.body.error.fields, name).toEqual(fixture.expected_issues);
    }
    // The valid fixture names the contract's Station B, which this chooser did not show: past the body, to the work.
    for (const [, fixture] of readChoiceFixtures('valid')) expectRefusal(await choose(install.installToken, recognitionId, fixture.body), 422, 'STATION_NOT_A_CANDIDATE');
    // No body, or a body that is not JSON, is refused the same way, never read as something else.
    expectRefusal(await choose(install.installToken, recognitionId, undefined), 400, 'VALIDATION_FAILED');
    const asText = await client()
      .post(`/api/v1/recognitions/${recognitionId}/choice`)
      .set('X-Forwarded-For', randomClientAddress())
      .set('Authorization', `Bearer ${install.installToken}`)
      .set('Content-Type', 'text/plain')
      .send('station_id=0192a6c4-1111-4000-8000-000000000002');
    expectRefusal(asText, 400, 'VALIDATION_FAILED');
    expect(await chosenStations(recognitionId)).toEqual([]);
  });

  it('P4-CHOICE-08 (choice half): past the follow-up allowance an install gets 429 RATE_LIMITED with Retry-After, counted per install and before the path and the body', async () => {
    const { stationA, install, recognitionId } = await answeredChooser();
    for (let followUp = 0; followUp < FOLLOW_UPS_PER_MINUTE; followUp += 1) {
      expectRefusal(await choose(install.installToken, uuidVersion7(), { station_id: stationA.stationId }), 404, 'NOT_FOUND');
    }
    const limited = await choose(install.installToken, recognitionId, { station_id: stationA.stationId });
    expectRefusal(limited, 429, 'RATE_LIMITED');
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // The allowance comes before the path and the body: neither is looked at once it is used up.
    expectRefusal(await choose(install.installToken, 'not-a-recognition', { unknown: 'field' }), 429, 'RATE_LIMITED');
    expect(await chosenStations(recognitionId)).toEqual([]);
    // Another install, from the same address or not, has its own allowance.
    const otherInstall = await newInstall();
    expectRefusal(await choose(otherInstall.installToken, recognitionId, { station_id: stationA.stationId }), 404, 'NOT_FOUND');
  });

  it('checks run in the contract’s order: the JSON parser, then the token, then the path, then the body', async () => {
    const { install, recognitionId } = await answeredChooser();
    // Broken JSON is refused by the body parser, which runs before any guard (Correction 1).
    const brokenJson = await client()
      .post(`/api/v1/recognitions/${recognitionId}/choice`)
      .set('X-Forwarded-For', randomClientAddress())
      .set('Content-Type', 'application/json')
      .send('{"station_id": ');
    expectRefusal(brokenJson, 400, 'INVALID_JSON');
    // The token before the path and the body.
    expectRefusal(await choose(null, 'not-a-recognition', { unknown: 'field' }), 401, 'INSTALL_TOKEN_INVALID');
    // The path before the body: only the path is named.
    const both = await choose(install.installToken, 'not-a-recognition', { unknown: 'field' });
    expectRefusal(both, 400, 'VALIDATION_FAILED');
    expect(both.body.error.fields).toEqual([{ path: 'recognition_id', code: 'invalid_format' }]);
  });

  it('ALL-SECURITY-09: a cookie request from another site is refused 403 before anything else, and a portal cookie opens nothing', async () => {
    const { stationA, install, recognitionId } = await answeredChooser();
    const crossSite = await choose(install.installToken, recognitionId, { station_id: stationA.stationId }, { Cookie: 'session=example', Origin: 'https://elsewhere.example.com' });
    expectRefusal(crossSite, 403, 'FORBIDDEN');

    const owner = await testUsers.create();
    const signedIn = await client()
      .post('/api/v1/auth/sign-in')
      .set('Origin', PORTAL_ORIGIN)
      .set('X-Forwarded-For', randomClientAddress())
      .send({ email: owner.email, password: owner.password })
      .expect(200);
    const withPortalCookie = await choose(null, recognitionId, { station_id: stationA.stationId }, { Cookie: cookieHeader(cookiesSetBy(signedIn)), Origin: PORTAL_ORIGIN });
    expectRefusal(withPortalCookie, 401, 'INSTALL_TOKEN_INVALID');
    expect(await chosenStations(recognitionId)).toEqual([]);
  });

  it('P6-CHOOSER-14 (server half): a chooser nobody answers stays UNRESOLVED, and there is no request that cancels one', async () => {
    const { install, recognitionId } = await answeredChooser();
    expect(await eventRow(recognitionId)).toEqual({ outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED', station_id: null, campaign_id: null, action_card_id: null });
    const withToken = (request: supertest.Test) => request.set('X-Forwarded-For', randomClientAddress()).set('Authorization', `Bearer ${install.installToken}`);
    expectRefusal(await withToken(client().delete(`/api/v1/recognitions/${recognitionId}/choice`)), 404, 'NOT_FOUND');
    expectRefusal(await withToken(client().post(`/api/v1/recognitions/${recognitionId}/cancel`)).send({}), 404, 'NOT_FOUND');
    expect(await eventRow(recognitionId)).toMatchObject({ resolution: 'UNRESOLVED', station_id: null });
    expect(await chosenStations(recognitionId)).toEqual([]);
  });

  it('there is no time limit: a chooser answered hours ago is still answered, as a clip sent later can be', async () => {
    const recording = await testData.createRecording();
    const stationA = await air(recording, 'A');
    const stationB = await air(recording, 'B');
    const install = await newInstall();
    // Received five hours ago (its id carries that time, as the API makes it), and answered with a chooser of A and B.
    const claimed = await testData.claim(apiClient, install.rowId, { receivedAt: new Date(Date.now() - 5 * 3_600_000) });
    await testData.finish(apiClient, claimed, {
      outcome: 'CHOOSE_STATION',
      resolution: 'UNRESOLVED',
      recording,
      candidates: [StationResolutionTestData.candidate(stationA, { displayPosition: 1 }), StationResolutionTestData.candidate(stationB, { displayPosition: 2 })],
    });
    expect((await choose(install.installToken, claimed.recognition_id, { station_id: stationB.stationId })).status).toBe(204);
    expect(await eventRow(claimed.recognition_id)).toMatchObject({ resolution: 'LISTENER_CHOICE', station_id: stationB.stationId });
  });

  it('P6-CHOOSER-07, -15 (server half): the chosen station, sent as the hint on the next identify, skips the chooser: a MATCH of that station decided by HINT', async () => {
    const { recording, stationB, install, recognitionId } = await answeredChooser();
    expect((await choose(install.installToken, recognitionId, { station_id: stationB.stationId })).status).toBe(204);
    const next = await identify(recording, install.installToken, { station_hint: stationB.stationId });
    expect(next.body).toMatchObject({ status: 'MATCH', result: { station: { id: stationB.stationId } } });
    const nextRow = (await setupClient.query('SELECT outcome, resolution, station_id, hinted_station_id FROM app.recognition_events WHERE id = $1', [next.body.recognition_id])).rows[0];
    expect(nextRow).toEqual({ outcome: 'MATCH', resolution: 'HINT', station_id: stationB.stationId, hinted_station_id: stationB.stationId });
  });

  it('logs one line per choice with its outcome, and never the install, its token or the station chosen', async () => {
    const { stationB, install, recognitionId } = await answeredChooser();
    const chosen = await choose(install.installToken, recognitionId, { station_id: stationB.stationId });
    const repeated = await choose(install.installToken, recognitionId, { station_id: stationB.stationId });
    await waitForLogWrites();
    for (const [response, outcome] of [[chosen, 'CHOSEN'], [repeated, 'ALREADY_CHOSEN']] as const) {
      const requestId = response.headers['x-request-id'];
      const lines = testApplication.logs.lines.filter((line) => line.requestId === requestId || (line.req as { id?: string } | undefined)?.id === requestId);
      expect(lines.filter((line) => line.msg === `choice ${outcome}`)).toEqual([expect.objectContaining({ level: 30, recognitionId, outcome })]);
      const written = JSON.stringify(lines);
      for (const secret of [install.installId, install.rowId, install.installToken, stationB.stationId]) expect(written).not.toContain(secret);
    }
  });

  it('ALL-ERRORS-02 to -04: a database failure or a programming error underneath is a generic 500, with the stack in the log under the request id', async () => {
    const { stationA, install, recognitionId } = await answeredChooser();
    const records = testApplication.application.get(RecognitionRecords);
    const driverError = Object.assign(new Error('duplicate key value violates unique constraint "recognition_candidates_one_chosen_unique_index"'), { code: '23505', severity: 'ERROR' });
    const failures = [
      new QueryFailedError('SELECT recognition.record_station_choice($1, $2, $3) AS answer', [recognitionId, install.rowId, stationA.stationId], driverError),
      new TypeError("Cannot read properties of undefined (reading 'answer')"),
    ];
    for (const failure of failures) {
      const spy = vi.spyOn(records, 'recordStationChoice').mockRejectedValueOnce(failure);
      try {
        const response = await choose(install.installToken, recognitionId, { station_id: stationA.stationId });
        expectRefusal(response, 500, 'INTERNAL');
        expect(response.headers['cache-control']).toBe('no-store');
        await waitForLogWrites();
        const logLine = testApplication.logs.find((line) => line.requestId === response.headers['x-request-id'] && line.level === 50);
        expect((logLine?.err as { stack?: string } | undefined)?.stack, failure.name).toContain(failure.name);
      } finally {
        spy.mockRestore();
      }
    }
    expect(await chosenStations(recognitionId)).toEqual([]);
  });
});
