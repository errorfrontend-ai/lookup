import { randomBytes, randomUUID } from 'node:crypto';
import { LISTENER_CONSENT_TEXT_VERSION, RecognizeResponse } from '@lookup/contracts';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { APP_CONFIG, type AppConfig, loadAppConfig } from '../src/config/app-config.js';
import { EMAIL_SENDER, type EmailSender, type OutgoingEmail } from '../src/features/notifications/notification-senders.js';
import { RecognitionService } from '../src/features/recognition/recognition.service.js';
import { RecognizeQueue } from '../src/infrastructure/job-queues/recognize-queue.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { FakeRecognizeWorker, match, noMatch, randomClientAddress, recognize, registerInstall } from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { type Recording, StationResolutionTestData } from './support/station-resolution-test-data.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * The account gate (ADR-005; design §2, LA-GATE-01..08): with LISTENER_ACCOUNT_REQUIRED on, the result of an ad scan
 * from an install with no account is held back by the server, after the scan has been recognised and recorded as
 * usual. A stand-in worker answers "this recording"; the stations, ads and campaigns are made straight in the
 * database. The switch is flipped on the one running application's configuration, which the services read on each
 * request.
 */
class RecordingEmailSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];
  async send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
  }
}

describe('the account gate on POST /api/v1/recognize', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testData: StationResolutionTestData;
  let worker: FakeRecognizeWorker;
  let recognizeQueue: RecognizeQueue;
  let config: AppConfig;
  const emails = new RecordingEmailSender();
  const installRows: string[] = [];
  const accountIds: string[] = [];
  const runTag = randomBytes(3).toString('hex');
  const client = () => supertest(testApplication.application.getHttpServer());
  const bearer = (installToken: string) => ({ Authorization: `Bearer ${installToken}`, 'X-Forwarded-For': randomClientAddress() });

  async function newInstall() {
    const install = await registerInstall(client);
    const hash = testApplication.application.get(InstallTokens).hashInstallId(install.installId);
    const row = await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash]);
    const installRowId = row.rows[0].id as string;
    installRows.push(installRowId);
    return { ...install, installRowId };
  }

  /** Gives the install an account straight in the database: the gate only asks whether one is linked. */
  async function giveAccount(installRowId: string): Promise<string> {
    const accountId = randomUUID();
    await setupClient.query(
      `INSERT INTO app.listener_accounts (id, email_hash, email_sealed, gender, birth_year, consent_text_version) VALUES ($1, $2, $3, 'FEMALE', 1996, $4)`,
      [accountId, randomBytes(32), randomBytes(40), LISTENER_CONSENT_TEXT_VERSION],
    );
    accountIds.push(accountId);
    await setupClient.query('UPDATE app.listener_installs SET listener_account_id = $2 WHERE id = $1', [installRowId, accountId]);
    return accountId;
  }

  const air = (recording: Recording, name: string, options: Omit<Parameters<StationResolutionTestData['airAd']>[0], 'recording' | 'station'> = {}) =>
    testData.airAd({ recording, gracePeriodMinutes: 0, ...options, station: { name: `Gate ${runTag} ${name}`, timeZone: 'UTC' } });

  async function identify(installToken: string, recording: Recording | null, fields: Record<string, string | undefined> = {}) {
    worker.answer = () => (recording ? match(recording.assetNumber) : noMatch());
    return recognize(client, { installToken, fields });
  }

  const eventRow = async (recognitionId: string) =>
    (await setupClient.query('SELECT outcome, resolution, station_id, campaign_id, action_card_id FROM app.recognition_events WHERE id = $1', [recognitionId])).rows[0] as Record<string, unknown>;

  beforeAll(async () => {
    config = { ...loadAppConfig(), LISTENER_ACCOUNT_REQUIRED: true, NOTIFICATION_SENDING_ENABLED: true, NOTIFICATION_RETRY_DELAY_MILLISECONDS: 20 };
    testApplication = await createTestApplication({ overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config).overrideProvider(EMAIL_SENDER).useValue(emails) });
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testData = new StationResolutionTestData(setupClient);
    recognizeQueue = testApplication.application.get(RecognizeQueue);
    worker = new FakeRecognizeWorker(process.env.KEY_VALUE_STORE_URL as string, process.env.QUEUE_KEY_PREFIX as string);
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();
  });
  beforeEach(async () => {
    config.LISTENER_ACCOUNT_REQUIRED = true;
    worker.answer = () => noMatch();
    testApplication.application.get(RecognitionService).circuitBreaker.close();
    await worker.startHeartbeat();
    await recognizeQueue.refreshAdmission();
  });
  afterAll(async () => {
    await worker.close();
    await setupClient.query(`DELETE FROM app.recognition_reports WHERE recognition_id IN (SELECT id FROM app.recognition_events WHERE listener_install_id = ANY($1))`, [installRows]);
    await setupClient.query(`DELETE FROM app.recognition_candidates WHERE recognition_id IN (SELECT id FROM app.recognition_events WHERE listener_install_id = ANY($1))`, [installRows]);
    await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.listener_accounts WHERE id = ANY($1)', [accountIds]);
    await testData.removeAll();
    await setupClient.end();
    await testApplication.close();
  });

  it('LA-GATE-01, -03: an ad scan from an install with no account is answered ACCOUNT_REQUIRED with five fields and nothing about the ad, and is recorded as the match it was', async () => {
    const recording = await testData.createRecording();
    const airing = await air(recording, 'withheld');
    const { installToken } = await newInstall();
    const response = await identify(installToken, recording);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(RecognizeResponse.safeParse(response.body).success).toBe(true);
    expect(Object.keys(response.body).sort()).toEqual(['captured_at', 'is_deferred', 'recognition_id', 'request_id', 'status']);
    expect(response.body.status).toBe('ACCOUNT_REQUIRED');
    // Nothing about the ad, the station, the advertiser or the buttons left the server.
    const text = JSON.stringify(response.body);
    for (const secret of [airing.stationId, airing.clientId, airing.adId, airing.campaignId, 'Summer service offer', `Gate ${runTag}`, '+447700900', 'example.com', 'actions', 'station']) {
      expect(text, secret).not.toContain(secret);
    }
    // The scan was recognised and recorded exactly as an ungated one: the station still counts it.
    expect(await eventRow(response.body.recognition_id)).toMatchObject({ outcome: 'MATCH', station_id: airing.stationId, campaign_id: airing.campaignId, action_card_id: airing.campaignCardId });
  });

  it('LA-GATE-01, -03: a "Which station?" chooser is withheld too, and its candidates are still recorded', async () => {
    const recording = await testData.createRecording();
    const stationA = await air(recording, 'A');
    const stationB = await air(recording, 'B');
    const { installToken } = await newInstall();
    const response = await identify(installToken, recording);
    expect(response.body.status).toBe('ACCOUNT_REQUIRED');
    expect(Object.keys(response.body).sort()).toEqual(['captured_at', 'is_deferred', 'recognition_id', 'request_id', 'status']);
    expect(await eventRow(response.body.recognition_id)).toMatchObject({ outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED' });
    const candidates = (await setupClient.query('SELECT station_id FROM app.recognition_candidates WHERE recognition_id = $1 ORDER BY display_position', [response.body.recognition_id])).rows;
    expect(candidates.map((row) => row.station_id).sort()).toEqual([stationA.stationId, stationB.stationId].sort());
  });

  it('LA-GATE-02: no match and an unusable clip are answered as they always were', async () => {
    const { installToken } = await newInstall();
    const nothing = await identify(installToken, null);
    expect(nothing.status).toBe(200);
    expect(nothing.body.status).toBe('NO_MATCH');
    const notAudio = await recognize(client, { installToken, audio: Buffer.from('this is not an audio clip at all, only text'), fields: {} });
    expect(notAudio.status).toBeGreaterThanOrEqual(400);
    expect(assertErrorEnvelope(notAudio.body).error.code).not.toBe('ACCOUNT_REQUIRED');
  });

  it('LA-GATE-05: with the switch off the same scan gets the station’s buttons, as before this change', async () => {
    config.LISTENER_ACCOUNT_REQUIRED = false;
    const recording = await testData.createRecording();
    const airing = await air(recording, 'open');
    const { installToken } = await newInstall();
    const response = await identify(installToken, recording);
    expect(response.body).toMatchObject({ status: 'MATCH', result: { kind: 'CAMPAIGN', station: { id: airing.stationId }, title: 'Summer service offer' } });
    expect(RecognizeResponse.safeParse(response.body).success).toBe(true);
  });

  it('LA-GATE-05: an install with an account gets the station’s buttons with the switch on', async () => {
    const recording = await testData.createRecording();
    const airing = await air(recording, 'member');
    const { installToken, installRowId } = await newInstall();
    await giveAccount(installRowId);
    const response = await identify(installToken, recording);
    expect(response.body).toMatchObject({ status: 'MATCH', result: { station: { id: airing.stationId } } });
  });

  it('LA-GATE-04: sending the same clip again (a replay of the finished key) is held back too, until the install has an account', async () => {
    const recording = await testData.createRecording();
    const airing = await air(recording, 'replayed');
    const { installToken, installRowId } = await newInstall();
    const key = randomUUID();
    const first = await identify(installToken, recording, { idempotency_key: key });
    const second = await identify(installToken, recording, { idempotency_key: key });
    expect(first.body.status).toBe('ACCOUNT_REQUIRED');
    // The same recognition and the same five fields; only the request id of this request is new.
    expect(second.body).toEqual({ ...first.body, request_id: second.body.request_id });

    await giveAccount(installRowId);
    const third = await identify(installToken, recording, { idempotency_key: key });
    expect(third.body).toMatchObject({ status: 'MATCH', recognition_id: first.body.recognition_id, result: { station: { id: airing.stationId } } });
  });

  it('LA-GATE-07: a clip sent later from the outbox is held back the same way, keeping its deferred flag and capture time', async () => {
    const recording = await testData.createRecording();
    await air(recording, 'deferred');
    const { installToken } = await newInstall();
    const heardAt = new Date(Date.now() - 3 * 3_600_000);
    const response = await identify(installToken, recording, { captured_at: heardAt.toISOString(), sent_at: new Date().toISOString(), is_deferred: 'true' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ACCOUNT_REQUIRED', is_deferred: true });
    // The capture time is corrected for the phone's clock, which moves it by milliseconds at most here.
    expect(Math.abs(new Date(response.body.captured_at).getTime() - heardAt.getTime())).toBeLessThan(2_000);
  });

  describe('reveal: GET /api/v1/recognitions/{id}', () => {
    it('LA-GATE-06: before the install has an account it is ACCOUNT_REQUIRED again; after, the full answer the scan would have had', async () => {
      const recording = await testData.createRecording();
      const airing = await air(recording, 'revealed');
      const { installToken, installRowId } = await newInstall();
      const scanned = await identify(installToken, recording);
      const recognitionId = scanned.body.recognition_id as string;

      const stillWithheld = await client().get(`/api/v1/recognitions/${recognitionId}`).set(bearer(installToken));
      expect(stillWithheld.status).toBe(200);
      expect(stillWithheld.body).toMatchObject({ status: 'ACCOUNT_REQUIRED', recognition_id: recognitionId, captured_at: scanned.body.captured_at });
      expect(Object.keys(stillWithheld.body).sort()).toEqual(['captured_at', 'is_deferred', 'recognition_id', 'request_id', 'status']);

      await giveAccount(installRowId);
      const revealed = await client().get(`/api/v1/recognitions/${recognitionId}`).set(bearer(installToken));
      expect(revealed.status, JSON.stringify(revealed.body)).toBe(200);
      expect(RecognizeResponse.safeParse(revealed.body).success).toBe(true);
      expect(revealed.body).toMatchObject({
        status: 'MATCH',
        recognition_id: recognitionId,
        is_deferred: false,
        captured_at: scanned.body.captured_at,
        result: { kind: 'CAMPAIGN', station: { id: airing.stationId }, card: { actions: airing.campaignCard?.actions } },
      });
      // The same card an ungated scan of the same recording gets.
      const ungated = await newInstall();
      await giveAccount(ungated.installRowId);
      const direct = await identify(ungated.installToken, recording);
      expect(revealed.body.result).toEqual(direct.body.result);
    });

    it('LA-GATE-06: a chooser is revealed with every candidate in the order the scan had, and the listener can then choose', async () => {
      const recording = await testData.createRecording();
      const stationA = await air(recording, 'chooser A');
      const stationB = await air(recording, 'chooser B');
      const { installToken, installRowId } = await newInstall();
      const scanned = await identify(installToken, recording);
      expect(scanned.body.status).toBe('ACCOUNT_REQUIRED');

      // Without an account the choice is refused like an unknown recognition (LA-GATE-08).
      const early = await client().post(`/api/v1/recognitions/${scanned.body.recognition_id}/choice`).set(bearer(installToken)).send({ station_id: stationA.stationId });
      expect(early.status).toBe(404);
      expect(assertErrorEnvelope(early.body).error.code).toBe('NOT_FOUND');

      await giveAccount(installRowId);
      const revealed = await client().get(`/api/v1/recognitions/${scanned.body.recognition_id}`).set(bearer(installToken));
      expect(revealed.body.status).toBe('CHOOSE_STATION');
      expect(revealed.body.candidates.map((candidate: { station: { id: string } }) => candidate.station.id).sort()).toEqual([stationA.stationId, stationB.stationId].sort());
      const chosen = await client().post(`/api/v1/recognitions/${scanned.body.recognition_id}/choice`).set(bearer(installToken)).send({ station_id: stationB.stationId });
      expect(chosen.status).toBe(204);
      expect(await eventRow(scanned.body.recognition_id)).toMatchObject({ resolution: 'LISTENER_CHOICE', station_id: stationB.stationId });
    });

    it('LA-GATE-06: another install’s recognition and an invented id answer the same 404, and a malformed id names the field and not the value', async () => {
      const recording = await testData.createRecording();
      await air(recording, 'private');
      const owner = await newInstall();
      const scanned = await identify(owner.installToken, recording);
      await giveAccount(owner.installRowId);
      const stranger = await newInstall();
      await giveAccount(stranger.installRowId);

      const another = await client().get(`/api/v1/recognitions/${scanned.body.recognition_id}`).set(bearer(stranger.installToken));
      const invented = await client().get(`/api/v1/recognitions/0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70`).set(bearer(stranger.installToken));
      expect(another.status).toBe(404);
      expect(invented.status).toBe(404);
      expect(assertErrorEnvelope(another.body).error.code).toBe('NOT_FOUND');
      expect({ ...another.body, error: { ...another.body.error, request_id: '' } }).toEqual({ ...invented.body, error: { ...invented.body.error, request_id: '' } });

      const malformed = await client().get('/api/v1/recognitions/not-an-id-secret-marker').set(bearer(stranger.installToken));
      expect(malformed.status).toBe(400);
      expect(assertErrorEnvelope(malformed.body).error).toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ path: 'recognition_id', code: 'invalid_format' }] });
      expect(JSON.stringify(malformed.body)).not.toContain('secret-marker');
    });

    it('LA-GATE-06: a recognition that was not an ad’s result (no match) cannot be revealed', async () => {
      const { installToken, installRowId } = await newInstall();
      const scanned = await identify(installToken, null);
      expect(scanned.body.status).toBe('NO_MATCH');
      await giveAccount(installRowId);
      const response = await client().get(`/api/v1/recognitions/${scanned.body.recognition_id}`).set(bearer(installToken));
      expect(response.status).toBe(404);
    });

    it('LA-GATE-06: needs the install token, and a station’s sign-in cookie does not stand in for it', async () => {
      const response = await client().get('/api/v1/recognitions/0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70').set('X-Forwarded-For', randomClientAddress());
      expect(response.status).toBe(401);
      expect(assertErrorEnvelope(response.body).error.code).toBe('INSTALL_TOKEN_INVALID');
    });
  });

  describe('LA-GATE-08: the routes that would tell an install with no account which stations own the recording', () => {
    it('answers a station choice and a report like an unknown recognition, and as before once the install has an account', async () => {
      const recording = await testData.createRecording();
      const stationA = await air(recording, 'follow-up A');
      await air(recording, 'follow-up B');
      const { installToken, installRowId } = await newInstall();
      const scanned = await identify(installToken, recording);
      const recognitionId = scanned.body.recognition_id as string;

      const choice = await client().post(`/api/v1/recognitions/${recognitionId}/choice`).set(bearer(installToken)).send({ station_id: stationA.stationId });
      const report = await client().post(`/api/v1/recognitions/${recognitionId}/report`).set(bearer(installToken)).send({ station_id: stationA.stationId, reason: 'LOOKS_LIKE_A_SCAM' });
      const invented = await client().post('/api/v1/recognitions/0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70/choice').set(bearer(installToken)).send({ station_id: stationA.stationId });
      for (const refused of [choice, report, invented]) {
        expect(refused.status).toBe(404);
        expect(assertErrorEnvelope(refused.body).error.code).toBe('NOT_FOUND');
      }

      // With an account, and with the switch off, both work as they did.
      await giveAccount(installRowId);
      const afterSignUp = await client().post(`/api/v1/recognitions/${recognitionId}/report`).set(bearer(installToken)).send({ station_id: stationA.stationId, reason: 'LOOKS_LIKE_A_SCAM' });
      expect(afterSignUp.status).toBe(204);
    });

    it('answers them as before while the switch is off', async () => {
      config.LISTENER_ACCOUNT_REQUIRED = false;
      const recording = await testData.createRecording();
      const stationA = await air(recording, 'open A');
      await air(recording, 'open B');
      const { installToken } = await newInstall();
      const scanned = await identify(installToken, recording);
      expect(scanned.body.status).toBe('CHOOSE_STATION');
      const choice = await client().post(`/api/v1/recognitions/${scanned.body.recognition_id}/choice`).set(bearer(installToken)).send({ station_id: stationA.stationId });
      expect(choice.status).toBe(204);
    });
  });

  describe('the whole journey over HTTP', () => {
    it('LA-GATE-06, LA-ACCOUNT-03: scan, held back, email code, details, then the same scan’s result', async () => {
      const recording = await testData.createRecording();
      const airing = await air(recording, 'journey');
      const { installToken } = await newInstall();
      const scanned = await identify(installToken, recording);
      expect(scanned.body.status).toBe('ACCOUNT_REQUIRED');

      const email = `journey.${runTag}.${randomUUID().slice(0, 6)}@example.com`;
      expect((await client().post('/api/v1/listener-account/code').set(bearer(installToken)).send({ email })).status).toBe(202);
      const deadline = Date.now() + 10_000;
      while (!emails.sent.some((sent) => sent.to === email) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      const code = /Your Look Up code is (\d{6})/.exec(emails.sent.find((sent) => sent.to === email)?.text ?? '')?.[1] as string;
      const checked = await client().post('/api/v1/listener-account/verify').set(bearer(installToken)).send({ email, code });
      expect(checked.body.status).toBe('DETAILS_NEEDED');
      const created = await client()
        .post('/api/v1/listener-account')
        .set(bearer(installToken))
        .send({ email, ticket: checked.body.ticket, gender: 'MALE', age: 35, consent_text_version: LISTENER_CONSENT_TEXT_VERSION });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const accountRow = await setupClient.query(
        `SELECT account.id FROM app.listener_installs AS listener_install JOIN app.listener_accounts AS account ON account.id = listener_install.listener_account_id WHERE listener_install.id = ANY($1)`,
        [installRows],
      );
      for (const row of accountRow.rows) accountIds.push(row.id as string);

      const revealed = await client().get(`/api/v1/recognitions/${scanned.body.recognition_id}`).set(bearer(installToken));
      expect(revealed.body).toMatchObject({ status: 'MATCH', recognition_id: scanned.body.recognition_id, result: { station: { id: airing.stationId } } });
      // Every later scan is answered normally.
      const next = await identify(installToken, recording);
      expect(next.body.status).toBe('MATCH');
    });
  });

  it('LA-GATE-01: the log says a result was held back, naming the recognition and nothing about the ad or the listener', async () => {
    const recording = await testData.createRecording();
    await air(recording, 'logged');
    const { installToken, installId } = await newInstall();
    const response = await identify(installToken, recording);
    await waitForLogWrites();
    const line = testApplication.logs.find((entry) => entry.msg === 'ad result held back until the listener has an account' && entry.recognitionId === response.body.recognition_id);
    expect(line).toBeDefined();
    const text = JSON.stringify(line);
    for (const secret of ['Summer service offer', `Gate ${runTag}`, installId, installToken]) expect(text, secret).not.toContain(secret);
  });
});
