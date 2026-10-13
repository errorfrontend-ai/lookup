import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { DerivedKeys } from '../src/common/security/derived-keys.js';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { RecognitionService } from '../src/features/recognition/recognition.service.js';
import { RecognizeQueue } from '../src/infrastructure/job-queues/recognize-queue.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { FakeRecognizeWorker, match, noMatch, randomClientAddress, recognize } from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { type Recording, StationResolutionTestData } from './support/station-resolution-test-data.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/** This file's minimum app version: an install registered with 0.1.0 is below it, one with 0.2.0 or later is not. */
const MINIMUM_APP_VERSION = '0.2.0';
const FOLLOW_UPS_PER_MINUTE = 8;

/**
 * The update gate (P4 design §5.7, contract §1.0; P4-UPDATEGATE-01, P6-COMPATIBILITY-01): an install registered with an
 * app version below LISTENER_MINIMUM_APP_VERSION gets 426 APP_UPDATE_REQUIRED on every route the install token opens,
 * after the token and before anything else; registering again with a newer version clears it at once. /installs and
 * /client-errors never answer 426.
 */
describe('the listener app update gate', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testData: StationResolutionTestData;
  let worker: FakeRecognizeWorker;
  let recognizeQueue: RecognizeQueue;
  const installRows: string[] = [];
  const runTag = randomUUID().slice(0, 6);
  const client = () => supertest(testApplication.application.getHttpServer());

  /** Registers (or registers again) the install id with an app version; resolves to its token and row id. */
  async function register(installId: string, appVersion: string, installToken?: string) {
    let request = client().post('/api/v1/installs').set('X-Forwarded-For', randomClientAddress());
    if (installToken) request = request.set('Authorization', `Bearer ${installToken}`);
    const response = await request.send({ install_id: installId, platform: 'ANDROID', app_version: appVersion });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const hash = testApplication.application.get(InstallTokens).hashInstallId(installId);
    const rowId = (await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash])).rows[0].id as string;
    if (!installRows.includes(rowId)) installRows.push(rowId);
    return { installId, installToken: response.body.install_token as string, rowId };
  }

  /** A chooser answered while the install still ran a supported version, so the follow-up routes have something to name. */
  async function chooserFor(installToken: string) {
    const recording: Recording = await testData.createRecording();
    const stationA = await testData.airAd({ recording, gracePeriodMinutes: 0, station: { name: `Gate ${runTag} A`, timeZone: 'UTC' } });
    await testData.airAd({ recording, gracePeriodMinutes: 0, station: { name: `Gate ${runTag} B`, timeZone: 'UTC' } });
    worker.answer = () => match(recording.assetNumber);
    const answer = await recognize(client, { installToken });
    expect(answer.body.status).toBe('CHOOSE_STATION');
    return { stationId: stationA.stationId, recognitionId: answer.body.recognition_id as string };
  }

  const withToken = (request: supertest.Test, installToken: string) => request.set('X-Forwarded-For', randomClientAddress()).set('Authorization', `Bearer ${installToken}`);
  /** Every route the install token opens, as the app calls it. */
  const listenerRoutes = (installToken: string, chooser: { stationId: string; recognitionId: string }) => ({
    recognize: () => recognize(client, { installToken }),
    choice: () => withToken(client().post(`/api/v1/recognitions/${chooser.recognitionId}/choice`), installToken).send({ station_id: chooser.stationId }),
    report: () => withToken(client().post(`/api/v1/recognitions/${chooser.recognitionId}/report`), installToken).send({ station_id: chooser.stationId, reason: 'SOMETHING_ELSE' }),
    stations: () => withToken(client().get('/api/v1/stations'), installToken),
  });

  beforeAll(async () => {
    const config = { ...loadAppConfig(), LISTENER_MINIMUM_APP_VERSION: MINIMUM_APP_VERSION, RECOGNITION_FOLLOW_UPS_PER_INSTALL_PER_MINUTE: FOLLOW_UPS_PER_MINUTE };
    testApplication = await createTestApplication({ overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config) });
    setupClient = databaseSetupClient();
    await setupClient.connect();
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
  afterAll(async () => {
    await worker.close();
    const ofTheseInstalls = 'SELECT id FROM app.recognition_events WHERE listener_install_id = ANY($1)';
    await setupClient.query(`DELETE FROM app.recognition_reports WHERE recognition_id IN (${ofTheseInstalls})`, [installRows]);
    await setupClient.query(`DELETE FROM app.recognition_candidates WHERE recognition_id IN (${ofTheseInstalls})`, [installRows]);
    await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRows]);
    await testData.removeAll();
    await setupClient.end();
    await testApplication.close();
  });

  it('P4-UPDATEGATE-01, P6-COMPATIBILITY-01: an install below the minimum gets 426 APP_UPDATE_REQUIRED on recognize, a choice, a report and the station list, and nothing is done', async () => {
    const installId = randomUUID();
    const supported = await register(installId, MINIMUM_APP_VERSION);
    const chooser = await chooserFor(supported.installToken);
    // The phone goes back to an old build (a reinstall): it registers again with the old version.
    const old = await register(installId, '0.1.0');
    expect(old.rowId).toBe(supported.rowId);
    worker.receivedJobs.length = 0;
    for (const [name, send] of Object.entries(listenerRoutes(old.installToken, chooser))) {
      const response = await send();
      expect(response.status, name).toBe(426);
      expect(assertErrorEnvelope(response.body).error, name).toMatchObject({
        code: 'APP_UPDATE_REQUIRED',
        message: 'Please update the app.',
        request_id: response.headers['x-request-id'],
      });
    }
    expect(worker.receivedJobs).toHaveLength(0);
    expect((await setupClient.query('SELECT resolution FROM app.recognition_events WHERE id = $1', [chooser.recognitionId])).rows[0].resolution).toBe('UNRESOLVED');
    expect((await setupClient.query('SELECT count(*)::integer AS reports FROM app.recognition_reports WHERE recognition_id = $1', [chooser.recognitionId])).rows[0].reports).toBe(0);
  });

  it('P6-COMPATIBILITY-01: registering again with a new enough version clears the gate at once on every route', async () => {
    const installId = randomUUID();
    const supported = await register(installId, '1.0.0');
    const chooser = await chooserFor(supported.installToken);
    const old = await register(installId, '0.1.9+77');
    expect((await listenerRoutes(old.installToken, chooser).recognize()).status).toBe(426);

    const updated = await register(installId, '0.2.0+1', old.installToken);
    const routes = listenerRoutes(updated.installToken, chooser);
    expect((await routes.recognize()).status).toBe(200);
    expect((await routes.choice()).status).toBe(204);
    expect((await routes.report()).status).toBe(204);
    expect((await routes.stations()).status).toBe(200);
    // The token is not what the gate reads: the old token works too, now that the install is registered as updated.
    expect((await listenerRoutes(old.installToken, chooser).stations()).status).toBe(200);
  });

  it('/installs and /client-errors never answer 426: an old app can always register, and report its crashes', async () => {
    const old = await register(randomUUID(), '0.0.1');
    const again = await client()
      .post('/api/v1/installs')
      .set('X-Forwarded-For', randomClientAddress())
      .set('Authorization', `Bearer ${old.installToken}`)
      .send({ install_id: old.installId, platform: 'ANDROID', app_version: '0.0.1' });
    expect(again.status).toBe(200);
    const crash = await client()
      .post('/api/v1/client-errors')
      .set('X-Forwarded-For', randomClientAddress())
      .set('Authorization', `Bearer ${old.installToken}`)
      .send({ source: 'listener-app', kind: 'reported', message: 'Example failure', appVersion: '0.0.1' });
    expect(crash.status).toBe(202);
  });

  it('a version that cannot be compared is below a minimum that is set (and the token still comes first: a bad token is 401, not 426)', async () => {
    const odd = await register(randomUUID(), '1.0.0-beta');
    expect((await withToken(client().get('/api/v1/stations'), odd.installToken)).status).toBe(426);
    const tampered = `${odd.installToken.slice(0, -2)}${odd.installToken.endsWith('AA') ? 'BB' : 'AA'}`;
    const refused = await withToken(client().get('/api/v1/stations'), tampered);
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('INSTALL_TOKEN_INVALID');
  });

  it('a request refused at the gate counts against no allowance, and its log lines carry the hashed install as actor', async () => {
    const installId = randomUUID();
    const supported = await register(installId, '1.0.0');
    const chooser = await chooserFor(supported.installToken);
    const old = await register(installId, '0.1.0');
    const refusals = [];
    for (let sent = 0; sent < FOLLOW_UPS_PER_MINUTE + 2; sent += 1) refusals.push(await listenerRoutes(old.installToken, chooser).choice());
    expect(refusals.map((response) => response.status)).toEqual(Array(FOLLOW_UPS_PER_MINUTE + 2).fill(426));
    const updated = await register(installId, '1.0.0', old.installToken);
    expect((await listenerRoutes(updated.installToken, chooser).choice()).status).toBe(204);

    await waitForLogWrites();
    const requestId = refusals[0]?.headers['x-request-id'];
    const lines = testApplication.logs.lines.filter((line) => line.requestId === requestId || (line.req as { id?: string } | undefined)?.id === requestId);
    expect(lines.length).toBeGreaterThan(0);
    const expectedActor = testApplication.application.get(DerivedKeys).hashIdentifier(old.rowId);
    for (const line of lines) expect(line.actor, String(line.msg)).toBe(expectedActor);
    const written = JSON.stringify(lines);
    for (const secret of [old.rowId, installId, old.installToken]) expect(written).not.toContain(secret);
  });
});
