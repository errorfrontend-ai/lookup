import type pg from 'pg';
import supertest from 'supertest';
import { QueryFailedError } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/common/errors/app-error.js';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { DerivedKeys } from '../src/common/security/derived-keys.js';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { RecognitionReports } from '../src/features/recognition-reports/recognition-reports.js';
import { RecognizeQueue } from '../src/infrastructure/job-queues/recognize-queue.js';
import { serializeErrorForLog } from '../src/infrastructure/logging/serialize-error-for-log.js';
import { FailureRoutesModule, PERSONAL_VALUES_SENT_TO_THE_DATABASE } from './support/failure-routes.module.js';
import { databaseSetupClient } from './support/database-clients.js';
import { FakeRecognizeWorker, match, randomClientAddress, recognize, registerInstall } from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, PortalTestUsers } from './support/portal-test-users.js';
import { StationResolutionTestData } from './support/station-resolution-test-data.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const { email, phoneNumber, passwordHash } = PERSONAL_VALUES_SENT_TO_THE_DATABASE;
/** The distinctive middle of the hash: its salt and digest. */
const passwordHashBody = passwordHash.split('$').slice(-2).join('$');

/**
 * The private log keeps what diagnoses a failure, never the values a query carried. Database errors
 * are the dangerous case: TypeORM keeps the bound parameters on the error, and Postgres repeats
 * values in `detail` and sometimes in the message.
 */
describe('logged errors never carry personal values', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  const client = () => supertest(testApplication.application.getHttpServer());

  beforeAll(async () => {
    testApplication = await createTestApplication({ extraModules: [FailureRoutesModule] });
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
  });
  afterAll(async () => {
    await testUsers.cleanUp();
    await setupClient.end();
    await testApplication.close();
  });

  async function logLinesFor(path: string, expectedStatus: number) {
    const response = await client().get(path);
    expect(response.status).toBe(expectedStatus);
    await waitForLogWrites();
    const requestId = response.body.error.request_id as string;
    return testApplication.logs.lines.filter((line) => JSON.stringify(line).includes(requestId));
  }

  function expectNoPersonalValues(lines: unknown[]) {
    expect(lines.length).toBeGreaterThan(0);
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain(email);
    expect(logged).not.toContain(phoneNumber);
    expect(logged).not.toContain('$argon2id$');
    expect(logged).not.toContain(passwordHashBody);
    expect(logged).not.toContain('Failing row contains');
    expect(logged).not.toContain('"parameters"');
  }

  it('a failed query keeps its SQLSTATE, SQL text and stack, but not its parameters or the quoted value', async () => {
    const lines = await logLinesFor('/api/v1/test-only/database-error-with-personal-values', 500);
    expectNoPersonalValues(lines);

    const errorLine = lines.find((line) => line.level === 50);
    const loggedError = errorLine?.err as Record<string, unknown>;
    expect(loggedError).toMatchObject({ type: 'QueryFailedError', code: '22P02' });
    expect(loggedError.message).toBe('invalid input syntax for type uuid: [value removed]');
    expect(loggedError.query).toContain('$3::uuid');
    expect(String(loggedError.stack)).toMatch(/^QueryFailedError: invalid input syntax for type uuid: \[value removed\]\n\s+at /);
  });

  it('a check violation keeps the constraint and table, but not the failing row', async () => {
    const lines = await logLinesFor('/api/v1/test-only/failing-row-with-personal-values', 500);
    expectNoPersonalValues(lines);
    expect(lines.find((line) => line.level === 50)?.err).toMatchObject({
      code: '23514',
      // The row breaks two checks (platform and app version); Postgres reports the app version's first.
      constraint: 'listener_installs_app_version_check',
      table: 'listener_installs',
      schema: 'app',
    });
  });

  it('a refusal caused by a database error logs the cause, without its values', async () => {
    const lines = await logLinesFor('/api/v1/test-only/conflict-caused-by-database-error', 409);
    expectNoPersonalValues(lines);
    const rejectedLine = lines.find((line) => line.msg === 'request rejected');
    expect(rejectedLine?.level).toBe(30);
    expect(rejectedLine?.err).toMatchObject({
      type: 'AppError',
      cause: { type: 'QueryFailedError', code: '23505', constraint: 'listener_installs_install_id_hash_unique' },
    });
  });

  it('S1-LOGGING-17: a plain caller mistake is logged at info level, without a stack', async () => {
    const lines = await logLinesFor('/api/v1/auth/me', 401);
    const rejectedLine = lines.find((line) => line.msg === 'request rejected');
    expect(rejectedLine?.level).toBe(30);
    expect(rejectedLine).not.toHaveProperty('err');
    expect(lines.every((line) => Number(line.level) < 50)).toBe(true);
    // A stack in a JSON line shows as an escaped newline followed by "at …".
    expect(JSON.stringify(lines)).not.toMatch(/\\n\s+at /);
  });

  it('S1-LOGGING-15: by default a request line holds only id, method and path: no headers, no query string', async () => {
    const response = await client().get('/api/v1/auth/me?email=chanda.mwale%40example.test').set('Cookie', 'session=secret-cookie-value');
    await waitForLogWrites();
    const requestLine = testApplication.logs.find(
      (line) => 'res' in line && (line.req as { id?: string } | undefined)?.id === response.headers['x-request-id'],
    );
    expect(requestLine?.req).toEqual({ id: response.headers['x-request-id'], method: 'GET', path: '/api/v1/auth/me' });
    expect(requestLine?.res).toEqual({ statusCode: 401 });
    const logged = JSON.stringify(testApplication.logs.lines);
    expect(logged).not.toContain('secret-cookie-value');
    expect(logged).not.toContain('chanda.mwale%40example.test');
  });

  it('every line of a signed-in request names the actor by a keyed hash, never by id or email', async () => {
    const user = await testUsers.create();
    const signIn = await client().post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).send({ email: user.email, password: user.password });
    expect(signIn.status).toBe(200);
    const cookies = cookieHeader(cookiesSetBy(signIn));
    const expectedActor = testApplication.application.get(DerivedKeys).hashIdentifier(user.userId);

    const succeeded = await client().get('/api/v1/auth/me').set('Origin', PORTAL_ORIGIN).set('Cookie', cookies);
    const failed = await client().get('/api/v1/test-only/signed-in/programming-error').set('Origin', PORTAL_ORIGIN).set('Cookie', cookies);
    expect(succeeded.status).toBe(200);
    expect(failed.status).toBe(500);
    await waitForLogWrites();

    const completedLine = testApplication.logs.find(
      (line) => line.msg === 'request completed' && (line.req as { id?: string } | undefined)?.id === succeeded.headers['x-request-id'],
    );
    const errorLine = testApplication.logs.find((line) => line.level === 50 && line.requestId === failed.body.error.request_id);
    expect(completedLine?.actor).toBe(expectedActor);
    expect(errorLine?.actor).toBe(expectedActor);
    const loggedForThisUser = JSON.stringify(testApplication.logs.lines.filter((line) => line.actor === expectedActor));
    expect(loggedForThisUser).not.toContain(user.userId);
    expect(loggedForThisUser).not.toContain(user.email);
  });

  it('ALL-LOGGING-01, -03, P4 design §5.13: every line of a listener request, its error lines included, carries the keyed hash of the install as actor, and none holds the install, its token, the hint, a card or a body', async () => {
    const testData = new StationResolutionTestData(setupClient);
    const worker = new FakeRecognizeWorker(process.env.KEY_VALUE_STORE_URL as string, process.env.QUEUE_KEY_PREFIX as string);
    const installRows: string[] = [];
    try {
      await worker.startHeartbeat();
      await testApplication.application.get(RecognizeQueue).refreshAdmission();
      const recording = await testData.createRecording();
      const stationA = await testData.airAd({ recording, gracePeriodMinutes: 0, station: { name: 'Log privacy A', timeZone: 'UTC' } });
      const stationB = await testData.airAd({ recording, gracePeriodMinutes: 0, station: { name: 'Log privacy B', timeZone: 'UTC' } });
      const install = await registerInstall(client);
      const hash = testApplication.application.get(InstallTokens).hashInstallId(install.installId);
      const rowId = (await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash])).rows[0].id as string;
      installRows.push(rowId);
      const expectedActor = testApplication.application.get(DerivedKeys).hashIdentifier(rowId);
      const bearer = (request: supertest.Test) => request.set('X-Forwarded-For', randomClientAddress()).set('Authorization', `Bearer ${install.installToken}`);

      // A hint for a station that is not on air: ignored, never logged. Then a chooser, a choice, a report, the list, and a failure.
      worker.answer = () => match(recording.assetNumber);
      const unknownHint = '0192a6c4-5555-4000-8000-00000000abcd';
      const chooser = await recognize(client, { installToken: install.installToken, fields: { station_hint: unknownHint } });
      expect(chooser.body.status).toBe('CHOOSE_STATION');
      const recognitionId = chooser.body.recognition_id as string;
      const choice = await bearer(client().post(`/api/v1/recognitions/${recognitionId}/choice`)).send({ station_id: stationB.stationId });
      const report = await bearer(client().post(`/api/v1/recognitions/${recognitionId}/report`)).send({ station_id: stationB.stationId, reason: 'LOOKS_LIKE_A_SCAM' });
      const stations = await bearer(client().get('/api/v1/stations'));
      const refused = await bearer(client().post(`/api/v1/recognitions/${recognitionId}/choice`)).send({ station_id: stationA.stationId });
      const failure = vi.spyOn(testApplication.application.get(RecognitionReports), 'record').mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'answer')"));
      const failed = await bearer(client().post(`/api/v1/recognitions/${recognitionId}/report`)).send({ station_id: stationB.stationId, reason: 'SOMETHING_ELSE' });
      failure.mockRestore();
      expect([chooser.status, choice.status, report.status, stations.status, refused.status, failed.status]).toEqual([200, 204, 204, 200, 422, 500]);
      await waitForLogWrites();

      const responses = { chooser, choice, report, stations, refused, failed };
      const requestIds = new Set(Object.values(responses).map((response) => response.headers['x-request-id'] as string));
      const lines = testApplication.logs.lines.filter(
        (line) => requestIds.has(line.requestId as string) || requestIds.has((line.req as { id?: string } | undefined)?.id as string),
      );
      for (const [name, response] of Object.entries(responses)) {
        const ofThisRequest = lines.filter((line) => line.requestId === response.headers['x-request-id'] || (line.req as { id?: string } | undefined)?.id === response.headers['x-request-id']);
        expect(ofThisRequest.length, name).toBeGreaterThan(0);
        for (const line of ofThisRequest) expect(line.actor, `${name}: ${String(line.msg)}`).toBe(expectedActor);
      }
      const errorLine = lines.find((line) => line.level === 50 && line.requestId === failed.headers['x-request-id']);
      expect((errorLine?.err as { stack?: string } | undefined)?.stack).toContain('TypeError');

      const written = JSON.stringify(lines);
      const card = stationB.campaignCard?.actions ?? [];
      for (const secret of [install.installId, rowId, install.installToken, unknownHint, '+447700900', 'LOOKS_LIKE_A_SCAM', 'Hi, I heard your ad', 'example.com/offer', ...card.map((action) => action.label)]) {
        expect(written, secret).not.toContain(secret);
      }
    } finally {
      await worker.close();
      const ofTheseInstalls = 'SELECT id FROM app.recognition_events WHERE listener_install_id = ANY($1)';
      await setupClient.query(`DELETE FROM app.recognition_reports WHERE recognition_id IN (${ofTheseInstalls})`, [installRows]);
      await setupClient.query(`DELETE FROM app.recognition_candidates WHERE recognition_id IN (${ofTheseInstalls})`, [installRows]);
      await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installRows]);
      await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1)', [installRows]);
      await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRows]);
      await testData.removeAll();
    }
  });
});

describe('serializeErrorForLog', () => {
  it('drops the parameters and detail TypeORM and the driver attach', () => {
    const driverError = Object.assign(new Error('duplicate key value violates unique constraint "portal_users_email_unique"'), {
      code: '23505',
      detail: `Key (email)=(${email}) already exists.`,
      constraint: 'portal_users_email_unique',
      table: 'portal_users',
      severity: 'ERROR',
    });
    const error = new QueryFailedError('INSERT INTO app.portal_users (email) VALUES ($1)', [email], driverError);

    const logged = serializeErrorForLog(error);

    expect(JSON.stringify(logged)).not.toContain(email);
    expect(logged).toMatchObject({ type: 'QueryFailedError', code: '23505', constraint: 'portal_users_email_unique', table: 'portal_users' });
    expect(logged.message).toContain('portal_users_email_unique');
  });

  it('masks personal values in messages that are not database errors', () => {
    const logged = serializeErrorForLog(new TypeError(`Cannot send to ${email} or ${phoneNumber}`));
    expect(logged.message).toBe('Cannot send to [email] or [number]');
    expect(logged.stack).not.toContain(email);
  });

  it('follows the cause chain, but only so far', () => {
    let error: Error = new Error('root cause');
    for (let level = 0; level < 6; level += 1) error = new AppError('INTERNAL', { internalDetail: `level ${level}`, cause: error });
    let depth = 0;
    for (let logged = serializeErrorForLog(error); logged.cause; logged = logged.cause) depth += 1;
    expect(depth).toBe(3);
  });

  it('handles thrown values that are not errors', () => {
    expect(serializeErrorForLog(`failed for ${email}`)).toEqual({ type: 'string', message: 'failed for [email]' });
    expect(serializeErrorForLog(undefined)).toEqual({ type: 'undefined', message: 'undefined' });
  });
});
