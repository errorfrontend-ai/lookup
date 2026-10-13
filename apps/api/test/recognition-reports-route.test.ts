import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type pg from 'pg';
import supertest from 'supertest';
import { QueryFailedError } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { DerivedKeys } from '../src/common/security/derived-keys.js';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { RecognitionReports } from '../src/features/recognition-reports/recognition-reports.js';
import { RecognitionService } from '../src/features/recognition/recognition.service.js';
import { RecognizeQueue } from '../src/infrastructure/job-queues/recognize-queue.js';
import { databaseSetupClient, lookupApiClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { FakeRecognizeWorker, match, noMatch, randomClientAddress, recognize, registerInstall } from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { type Recording, StationResolutionTestData } from './support/station-resolution-test-data.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/** This file's follow-up allowance per install and minute, low so the allowance is reached quickly (60 in production). */
const FOLLOW_UPS_PER_MINUTE = 8;
const REPORT_FIXTURES = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'contracts', 'fixtures', 'recognition', 'recognition-report-input');

interface ReportFixture {
  description: string;
  body: Record<string, unknown>;
  expected_issues?: Array<{ path: string; code: string }>;
}

function readReportFixtures(folder: 'valid' | 'invalid'): Array<[string, ReportFixture]> {
  return readdirSync(resolve(REPORT_FIXTURES, folder))
    .filter((fileName) => fileName.endsWith('.json'))
    .sort()
    .map((fileName) => [fileName.replace(/\.json$/, ''), JSON.parse(readFileSync(resolve(REPORT_FIXTURES, folder, fileName), 'utf8')) as ReportFixture]);
}

/**
 * POST /api/v1/recognitions/{recognition_id}/report (P4 design §5.9, §6.4; contract §1.6; P4-REPORTS-01): "Report
 * this", against the real API and database, after real answers from POST /api/v1/recognize with a stand-in worker.
 * Stations keep UTC time here.
 */
describe('POST /api/v1/recognitions/{recognition_id}/report', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  let testData: StationResolutionTestData;
  let worker: FakeRecognizeWorker;
  let recognizeQueue: RecognizeQueue;
  const installRows: string[] = [];
  const runTag = randomUUID().slice(0, 6);
  const client = () => supertest(testApplication.application.getHttpServer());

  const air = (recording: Recording, name: string) =>
    testData.airAd({ recording, gracePeriodMinutes: 0, station: { name: `Report ${runTag} ${name}`, timeZone: 'UTC' } });

  async function newInstall() {
    const install = await registerInstall(client);
    const hash = testApplication.application.get(InstallTokens).hashInstallId(install.installId);
    const rowId = (await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash])).rows[0].id as string;
    installRows.push(rowId);
    return { ...install, rowId };
  }

  async function identify(recording: Recording | null, installToken: string) {
    worker.answer = () => (recording ? match(recording.assetNumber) : noMatch());
    const response = await recognize(client, { installToken });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response;
  }

  /** One station airing a recording, and a listener whose identify of it was answered MATCH. */
  async function answeredMatch() {
    const recording = await testData.createRecording();
    const station = await air(recording, 'A');
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

  const sendReport = (installToken: string | null, recognitionId: string, body: unknown, headers: Record<string, string> = {}) => {
    let request = client().post(`/api/v1/recognitions/${recognitionId}/report`).set('X-Forwarded-For', randomClientAddress());
    if (installToken !== null) request = request.set('Authorization', `Bearer ${installToken}`);
    for (const [name, value] of Object.entries(headers)) request = request.set(name, value);
    return request.send(body as object);
  };
  const choose = (installToken: string, recognitionId: string, stationId: string) =>
    client()
      .post(`/api/v1/recognitions/${recognitionId}/choice`)
      .set('X-Forwarded-For', randomClientAddress())
      .set('Authorization', `Bearer ${installToken}`)
      .send({ station_id: stationId });
  const expectRefusal = (response: supertest.Response, httpStatus: number, code: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(httpStatus);
    expect(assertErrorEnvelope(response.body).error).toMatchObject({ code, request_id: response.headers['x-request-id'] });
  };
  const reportRows = async (recognitionId: string) =>
    (await setupClient.query('SELECT station_id, reason, listener_install_hash, request_id FROM app.recognition_reports WHERE recognition_id = $1', [recognitionId]))
      .rows as Array<Record<string, unknown>>;
  const linesOf = (response: supertest.Response) => {
    const requestId = response.headers['x-request-id'];
    return testApplication.logs.lines.filter((line) => line.requestId === requestId || (line.req as { id?: string } | undefined)?.id === requestId);
  };

  beforeAll(async () => {
    const config = { ...loadAppConfig(), RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE: FOLLOW_UPS_PER_MINUTE };
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
    await setupClient.query(`DELETE FROM app.recognition_reports WHERE recognition_id IN (${ofTheseInstalls})`, [installRows]);
    await setupClient.query(`DELETE FROM app.recognition_candidates WHERE recognition_id IN (${ofTheseInstalls})`, [installRows]);
    await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRows]);
    await testData.removeAll();
    await Promise.all([setupClient.end(), apiClient.end()]);
    await testApplication.close();
  });

  it('P4-REPORTS-01: a report on the station shown is stored once with its reason, its station and the keyed hash of the install, which is the request’s logged actor and never the install id', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    const response = await sendReport(install.installToken, recognitionId, { station_id: station.stationId, reason: 'LOOKS_LIKE_A_SCAM' });
    expect(response.status, JSON.stringify(response.body)).toBe(204);
    expect(response.text).toBe('');

    const expectedHash = testApplication.application.get(DerivedKeys).hashIdentifier(install.rowId);
    expect(await reportRows(recognitionId)).toEqual([
      { station_id: station.stationId, reason: 'LOOKS_LIKE_A_SCAM', listener_install_hash: expectedHash, request_id: response.headers['x-request-id'] },
    ]);
    expect(expectedHash).not.toContain(install.rowId);
    expect(expectedHash).not.toContain(install.installId);

    await waitForLogWrites();
    const actors = new Set(linesOf(response).map((line) => line.actor).filter((actor) => actor !== undefined));
    expect([...actors]).toEqual([expectedHash]);
  });

  it('P4-REPORTS-01: one report per recognition: a repeat, even with another reason, answers 204 and changes nothing', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    expect((await sendReport(install.installToken, recognitionId, { station_id: station.stationId, reason: 'NUMBER_OR_LINK_DOES_NOT_WORK' })).status).toBe(204);
    const first = await reportRows(recognitionId);
    for (const reason of ['NUMBER_OR_LINK_DOES_NOT_WORK', 'SOMETHING_ELSE', 'LOOKS_LIKE_A_SCAM']) {
      expect((await sendReport(install.installToken, recognitionId, { station_id: station.stationId, reason })).status).toBe(204);
    }
    expect(await reportRows(recognitionId)).toEqual(first);
    expect(first).toHaveLength(1);
  });

  it('P4-REPORTS-01: the body is checked against the shared contract: no free text, one of the four reasons, and the valid fixture gets through', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    for (const [name, fixture] of readReportFixtures('invalid')) {
      const response = await sendReport(install.installToken, recognitionId, { ...fixture.body, station_id: station.stationId });
      expectRefusal(response, 400, 'VALIDATION_FAILED');
      expect(response.body.error.fields, name).toEqual(fixture.expected_issues);
      expect(JSON.stringify(response.body), name).not.toContain('did not answer');
    }
    expect(await reportRows(recognitionId)).toEqual([]);
    const [[, valid]] = readReportFixtures('valid') as [[string, ReportFixture]];
    expect((await sendReport(install.installToken, recognitionId, { ...valid.body, station_id: station.stationId })).status).toBe(204);
    expect(await reportRows(recognitionId)).toHaveLength(1);
  });

  it('is valid where a tap is: another station than the one shown 422, a NO_MATCH 422, another install’s recognition and an unknown id 404, and nothing is stored', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    const elsewhere = await air(await testData.createRecording(), 'Elsewhere');
    expectRefusal(await sendReport(install.installToken, recognitionId, { station_id: elsewhere.stationId, reason: 'SOMETHING_ELSE' }), 422, 'STATION_NOT_A_CANDIDATE');

    const nothingMatched = await identify(null, install.installToken);
    expectRefusal(await sendReport(install.installToken, nothingMatched.body.recognition_id, { station_id: station.stationId, reason: 'SOMETHING_ELSE' }), 422, 'STATION_NOT_A_CANDIDATE');

    const stranger = await newInstall();
    expectRefusal(await sendReport(stranger.installToken, recognitionId, { station_id: station.stationId, reason: 'SOMETHING_ELSE' }), 404, 'NOT_FOUND');
    const unknownId = `${recognitionId.slice(0, 24)}${'0'.repeat(12)}`;
    expectRefusal(await sendReport(install.installToken, unknownId, { station_id: station.stationId, reason: 'SOMETHING_ELSE' }), 404, 'NOT_FOUND');
    expect(await reportRows(recognitionId)).toEqual([]);
    expect(await reportRows(nothingMatched.body.recognition_id)).toEqual([]);
  });

  it('on a chooser: a shown station may be reported without recording a choice; once a station is chosen, a report naming another gets 422 STATION_ALREADY_CHOSEN', async () => {
    const unanswered = await answeredChooser();
    expect((await sendReport(unanswered.install.installToken, unanswered.recognitionId, { station_id: unanswered.stationB.stationId, reason: 'SOMETHING_ELSE' })).status).toBe(204);
    const stillOpen = (await setupClient.query('SELECT resolution, station_id FROM app.recognition_events WHERE id = $1', [unanswered.recognitionId])).rows[0];
    expect(stillOpen).toEqual({ resolution: 'UNRESOLVED', station_id: null });
    expect((await setupClient.query('SELECT count(*)::integer AS chosen FROM app.recognition_candidates WHERE recognition_id = $1 AND is_chosen', [unanswered.recognitionId])).rows[0].chosen).toBe(0);

    const answered = await answeredChooser();
    expect((await choose(answered.install.installToken, answered.recognitionId, answered.stationA.stationId)).status).toBe(204);
    expectRefusal(await sendReport(answered.install.installToken, answered.recognitionId, { station_id: answered.stationB.stationId, reason: 'SOMETHING_ELSE' }), 422, 'STATION_ALREADY_CHOSEN');
    expect(await reportRows(answered.recognitionId)).toEqual([]);
    expect((await sendReport(answered.install.installToken, answered.recognitionId, { station_id: answered.stationA.stationId, reason: 'SOMETHING_ELSE' })).status).toBe(204);
  });

  it('checks run in the follow-ups’ order: the token (401), then the allowance shared with choices (429), then the path (400), then the body (400)', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    expectRefusal(await sendReport(null, recognitionId, { station_id: station.stationId, reason: 'SOMETHING_ELSE' }), 401, 'INSTALL_TOKEN_INVALID');
    const badPath = await sendReport(install.installToken, 'not-a-recognition', { unknown: 'field' });
    expectRefusal(badPath, 400, 'VALIDATION_FAILED');
    expect(badPath.body.error.fields).toEqual([{ path: 'recognition_id', code: 'invalid_format' }]);

    // The rest of this install's minute: choices and reports share one allowance.
    for (let sent = 1; sent < FOLLOW_UPS_PER_MINUTE - 1; sent += 1) await choose(install.installToken, recognitionId, station.stationId);
    expect((await sendReport(install.installToken, recognitionId, { station_id: station.stationId, reason: 'SOMETHING_ELSE' })).status).toBe(204);
    const limited = await sendReport(install.installToken, 'not-a-recognition', { unknown: 'field' });
    expectRefusal(limited, 429, 'RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('ALL-SECURITY-09: a cookie request from another site is refused 403 before anything else', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    const crossSite = await sendReport(install.installToken, recognitionId, { station_id: station.stationId, reason: 'LOOKS_LIKE_A_SCAM' }, {
      Cookie: 'session=example',
      Origin: 'https://elsewhere.example.com',
    });
    expectRefusal(crossSite, 403, 'FORBIDDEN');
    expect(await reportRows(recognitionId)).toEqual([]);
  });

  it('only super admins read reports: the API role may not read the table, even in a station’s context', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    expect((await sendReport(install.installToken, recognitionId, { station_id: station.stationId, reason: 'LOOKS_LIKE_A_SCAM' })).status).toBe(204);
    await apiClient.query('BEGIN');
    try {
      await apiClient.query(`SELECT set_config('app.station_id', $1, true)`, [station.stationId]);
      await expect(apiClient.query('SELECT reason FROM app.recognition_reports WHERE recognition_id = $1', [recognitionId])).rejects.toThrow(/permission denied/);
    } finally {
      await apiClient.query('ROLLBACK');
    }
  });

  it('logs one line per report with its outcome, and never the install, its token, the station or the reason', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    const recorded = await sendReport(install.installToken, recognitionId, { station_id: station.stationId, reason: 'LOOKS_LIKE_A_SCAM' });
    const repeated = await sendReport(install.installToken, recognitionId, { station_id: station.stationId, reason: 'SOMETHING_ELSE' });
    await waitForLogWrites();
    for (const [response, outcome] of [[recorded, 'RECORDED'], [repeated, 'ALREADY_RECORDED']] as const) {
      const lines = linesOf(response);
      expect(lines.filter((line) => line.msg === `report ${outcome}`)).toEqual([expect.objectContaining({ level: 30, recognitionId, outcome })]);
      const written = JSON.stringify(lines);
      for (const secret of [install.installId, install.rowId, install.installToken, station.stationId, 'LOOKS_LIKE_A_SCAM', 'SOMETHING_ELSE']) expect(written).not.toContain(secret);
    }
  });

  it('ALL-ERRORS-02 to -04: a database failure or a programming error underneath is a generic 500, with the stack in the log under the request id', async () => {
    const { station, install, recognitionId } = await answeredMatch();
    const reports = testApplication.application.get(RecognitionReports);
    const driverError = Object.assign(new Error('duplicate key value violates unique constraint "recognition_reports_recognition_id_unique"'), { code: '23505', severity: 'ERROR' });
    const failures = [
      new QueryFailedError('SELECT recognition.record_recognition_report($1, $2, $3, $4, $5, $6, $7) AS answer', [recognitionId], driverError),
      new TypeError("Cannot read properties of undefined (reading 'answer')"),
    ];
    for (const failure of failures) {
      const spy = vi.spyOn(reports, 'record').mockRejectedValueOnce(failure);
      try {
        const response = await sendReport(install.installToken, recognitionId, { station_id: station.stationId, reason: 'SOMETHING_ELSE' });
        expectRefusal(response, 500, 'INTERNAL');
        expect(JSON.stringify(response.body)).not.toMatch(/duplicate key|recognition_reports|TypeError|SQLSTATE|23505/);
        await waitForLogWrites();
        const logLine = testApplication.logs.find((line) => line.requestId === response.headers['x-request-id'] && line.level === 50);
        expect((logLine?.err as { stack?: string } | undefined)?.stack, failure.name).toContain(failure.name);
      } finally {
        spy.mockRestore();
      }
    }
    expect(await reportRows(recognitionId)).toEqual([]);
  });
});
