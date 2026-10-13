import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ListenerStationList } from '@lookup/contracts';
import type pg from 'pg';
import supertest from 'supertest';
import { QueryFailedError } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { uuidVersion7 } from '../src/common/identifiers/uuid-version-7.js';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { ListenerStationsService } from '../src/features/listener-stations/listener-stations.service.js';
import { RecognitionService } from '../src/features/recognition/recognition.service.js';
import { RecognizeQueue } from '../src/infrastructure/job-queues/recognize-queue.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { FakeRecognizeWorker, match, noMatch, randomClientAddress, recognize, registerInstall } from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, PortalTestUsers } from './support/portal-test-users.js';
import { StationResolutionTestData } from './support/station-resolution-test-data.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/** This file's station-list allowance per install and hour, low so it is reached quickly (20 in production). */
const STATION_LIST_REQUESTS_PER_HOUR = 8;
const CACHED_FOR_A_DAY = 'private, max-age=86400';

/**
 * GET /api/v1/stations (P4 design §5.6, §6.4; contract §1.4): the "My station" list, against the real API and the
 * development database. Other stations exist there, so each test looks only at the stations it made, in the order
 * the whole list gives them.
 */
describe('GET /api/v1/stations', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testData: StationResolutionTestData;
  let testUsers: PortalTestUsers;
  let worker: FakeRecognizeWorker;
  const installRows: string[] = [];
  const client = () => supertest(testApplication.application.getHttpServer());

  /** Notes an install's row, so it is removed afterwards with what it made. */
  async function rememberInstallRow(installId: string) {
    const hash = testApplication.application.get(InstallTokens).hashInstallId(installId);
    installRows.push((await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash])).rows[0].id as string);
  }
  async function newInstall() {
    const install = await registerInstall(client);
    await rememberInstallRow(install.installId);
    return install;
  }
  const listStations = (installToken: string | null, headers: Record<string, string> = {}) => {
    let request = client().get('/api/v1/stations').set('X-Forwarded-For', randomClientAddress());
    if (installToken !== null) request = request.set('Authorization', `Bearer ${installToken}`);
    for (const [name, value] of Object.entries(headers)) request = request.set(name, value);
    return request;
  };
  /** The stations of this test, as the answer lists them. */
  const onlyThese = (response: supertest.Response, stationIds: readonly string[]) =>
    (response.body.stations as Array<{ id: string }>).filter((station) => stationIds.includes(station.id));
  const expectRefusal = (response: supertest.Response, httpStatus: number, code: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(httpStatus);
    expect(assertErrorEnvelope(response.body).error).toMatchObject({ code, request_id: response.headers['x-request-id'] });
  };
  /** The design's strong ETag of a body: the first 27 characters of its base64url SHA-256, in quotes. */
  const entityTagOf = (body: string) => `"${createHash('sha256').update(body, 'utf8').digest('base64url').slice(0, 27)}"`;

  beforeAll(async () => {
    const config = { ...loadAppConfig(), STATION_LIST_REQUESTS_PER_INSTALL_PER_HOUR: STATION_LIST_REQUESTS_PER_HOUR };
    testApplication = await createTestApplication({ overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config) });
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testData = new StationResolutionTestData(setupClient);
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
    worker = new FakeRecognizeWorker(process.env.KEY_VALUE_STORE_URL as string, process.env.QUEUE_KEY_PREFIX as string);
    await worker.startHeartbeat();
    await testApplication.application.get(RecognizeQueue).refreshAdmission();
  });
  beforeEach(() => {
    worker.answer = () => noMatch();
    testApplication.application.get(RecognitionService).circuitBreaker.close();
  });
  afterAll(async () => {
    await worker.close();
    await setupClient.query('DELETE FROM app.recognition_candidates WHERE recognition_id IN (SELECT id FROM app.recognition_events WHERE listener_install_id = ANY($1))', [installRows]);
    await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRows]);
    await testUsers.cleanUp();
    await testData.removeAll();
    await setupClient.end();
    await testApplication.close();
  });

  it('P6-MYSTATION-03, P6-MYSTATION-02 (server half): of four stations — active and listed, active and unlisted, suspended, pending — only the first is listed, with its public facts only', async () => {
    const tag = randomBytes(4).toString('hex');
    const listed = await testData.createStation({ name: `Station list ${tag} listed`, frequencyLabel: '104.3 FM', city: 'Kitwe' });
    const hidden = [
      await testData.createStation({ name: `Station list ${tag} unlisted`, isListedInApp: false }),
      await testData.createStation({ name: `Station list ${tag} suspended`, status: 'SUSPENDED' }),
      await testData.createStation({ name: `Station list ${tag} pending`, status: 'PENDING_REVIEW' }),
    ];
    const { installToken } = await newInstall();
    const response = await listStations(installToken);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    // The whole answer is the shared contract's list: no status, no "listed" flag, nothing a station keeps to itself.
    expect(ListenerStationList.safeParse(response.body).success, JSON.stringify(response.body).slice(0, 300)).toBe(true);
    expect(Object.keys(response.body)).toEqual(['stations']);
    expect(onlyThese(response, [listed, ...hidden])).toEqual([{ id: listed, name: `Station list ${tag} listed`, frequency_label: '104.3 FM', city: 'Kitwe', logo: null }]);
    const listedIds = (response.body.stations as Array<{ id: string }>).map((station) => station.id);
    expect(new Set(listedIds).size).toBe(listedIds.length);
  });

  it('lists by lower-case name in byte order, then frequency, then id, each station with its city or null', async () => {
    const tag = randomBytes(4).toString('hex');
    const station = (name: string, options: Parameters<StationResolutionTestData['createStation']>[0]) => testData.createStation({ name: `Station list ${tag} ${name}`, ...options });
    const zulu = await station('zulu', { frequencyLabel: '90.0 FM' });
    const alphaLater = await station('Alpha', { frequencyLabel: '98.1 FM', city: 'Kitwe' });
    const alphaFirst = await station('alpha', { frequencyLabel: '104.3 FM', city: null });
    const beta = await station('Beta', { frequencyLabel: '90.0 FM' });
    const { installToken } = await newInstall();
    const response = await listStations(installToken);
    const mine = onlyThese(response, [zulu, alphaLater, alphaFirst, beta]);
    expect(mine.map((listedStation) => listedStation.id)).toEqual([alphaFirst, alphaLater, beta, zulu]);
    expect(mine[0]).toEqual({ id: alphaFirst, name: `Station list ${tag} alpha`, frequency_label: '104.3 FM', city: null, logo: null });
  });

  it('an empty list is a valid answer, with its own ETag', async () => {
    const { installToken } = await newInstall();
    const spy = vi.spyOn(testApplication.application.get(ListenerStationsService), 'readListedStations').mockResolvedValueOnce([]);
    try {
      const response = await listStations(installToken);
      expect(response.status).toBe(200);
      expect(response.text).toBe('{"stations":[]}');
      expect(response.headers.etag).toBe(entityTagOf('{"stations":[]}'));
      expect(response.headers['cache-control']).toBe(CACHED_FOR_A_DAY);
    } finally {
      spy.mockRestore();
    }
  });

  it('P4-STATIONLIST-01: a strong ETag that is the hash of the body sent, kept for a day in private caches only; the same ETag back gets 304 with no body and the same headers', async () => {
    await testData.createStation({ name: `Station list ${randomBytes(4).toString('hex')} cached` });
    const { installToken } = await newInstall();
    const first = await listStations(installToken);
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe(CACHED_FOR_A_DAY);
    expect(first.headers.etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
    expect(first.headers.etag).toBe(entityTagOf(first.text));
    const entityTag = first.headers.etag as string;

    for (const ifNoneMatch of [entityTag, `"some-other-tag", ${entityTag}`]) {
      const notModified = await listStations(installToken, { 'If-None-Match': ifNoneMatch });
      expect(notModified.status, ifNoneMatch).toBe(304);
      expect(notModified.text).toBe('');
      expect(notModified.headers['content-length'] ?? '0').toBe('0');
      expect(notModified.headers.etag).toBe(entityTag);
      expect(notModified.headers['cache-control']).toBe(CACHED_FOR_A_DAY);
    }
    // Only that exact tag: a weak copy of it, another tag or "*" gets the list.
    for (const ifNoneMatch of [`W/${entityTag}`, '"some-other-tag"', '*', entityTag.slice(1, -1)]) {
      const listed = await listStations(installToken, { 'If-None-Match': ifNoneMatch });
      expect(listed.status, ifNoneMatch).toBe(200);
      expect(listed.text).toBe(first.text);
      expect(listed.headers.etag).toBe(entityTag);
    }
  });

  it('a change to the list changes its ETag, so a phone holding the old one gets the new list', async () => {
    const { installToken } = await newInstall();
    const before = await listStations(installToken);
    const added = await testData.createStation({ name: `Station list ${randomBytes(4).toString('hex')} added later` });
    const after = await listStations(installToken, { 'If-None-Match': before.headers.etag as string });
    expect(after.status).toBe(200);
    expect(after.headers.etag).not.toBe(before.headers.etag);
    expect(after.headers.etag).toBe(entityTagOf(after.text));
    expect(onlyThese(after, [added])).toHaveLength(1);
  });

  it('every other listener route still says Cache-Control: no-store, and so does every refusal of this one', async () => {
    const recording = await testData.createRecording();
    const stationA = await testData.airAd({ recording, station: { name: `Station list ${randomBytes(4).toString('hex')} A` } });
    await testData.airAd({ recording, station: { name: `Station list ${randomBytes(4).toString('hex')} B` } });
    const installId = randomUUID();
    const registration = await client()
      .post('/api/v1/installs')
      .set('X-Forwarded-For', randomClientAddress())
      .send({ install_id: installId, platform: 'ANDROID', app_version: '1.0.0' });
    expect(registration.status).toBe(200);
    const installToken = registration.body.install_token as string;
    await rememberInstallRow(installId);
    worker.answer = () => match(recording.assetNumber);
    const chooser = await recognize(client, { installToken });
    expect(chooser.body.status).toBe('CHOOSE_STATION');
    const choice = await client()
      .post(`/api/v1/recognitions/${chooser.body.recognition_id}/choice`)
      .set('X-Forwarded-For', randomClientAddress())
      .set('Authorization', `Bearer ${installToken}`)
      .send({ station_id: stationA.stationId });
    expect(choice.status).toBe(204);
    // Routes still to come answer whatever they answer today; that answer must not be cacheable either.
    const notBuiltYet = [
      await client().post('/api/v1/engagements').set('X-Forwarded-For', randomClientAddress()).set('Authorization', `Bearer ${installToken}`).send({}),
      await client().post(`/api/v1/recognitions/${uuidVersion7()}/report`).set('X-Forwarded-For', randomClientAddress()).set('Authorization', `Bearer ${installToken}`).send({}),
    ];
    const answers = {
      'POST /installs': registration,
      'POST /recognize': chooser,
      'POST /recognitions/{id}/choice': choice,
      'POST /engagements (not built yet)': notBuiltYet[0],
      'POST /recognitions/{id}/report (not built yet)': notBuiltYet[1],
      'GET /stations without a token': await listStations(null),
      'GET /stations with a token that is not valid': await listStations('not-a-token'),
    };
    for (const [route, response] of Object.entries(answers)) expect(response?.headers['cache-control'], route).toBe('no-store');
  });

  it('needs a valid install token: none, or one that is not valid, gets 401; a portal cookie opens nothing, and the portal’s own station page is a different route', async () => {
    expectRefusal(await listStations(null), 401, 'INSTALL_TOKEN_INVALID');
    expectRefusal(await listStations('not-a-token'), 401, 'INSTALL_TOKEN_INVALID');
    const owner = await testUsers.create();
    const signedIn = await client().post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', randomClientAddress()).send({ email: owner.email, password: owner.password }).expect(200);
    const cookie = cookieHeader(cookiesSetBy(signedIn));
    expectRefusal(await listStations(null, { Cookie: cookie, Origin: PORTAL_ORIGIN }), 401, 'INSTALL_TOKEN_INVALID');
    const portalPage = await client().get(`/api/v1/stations/${owner.stationId}`).set('X-Forwarded-For', randomClientAddress()).set('Cookie', cookie).set('Origin', PORTAL_ORIGIN);
    expect(portalPage.status).toBe(200);
    expect(portalPage.body).toMatchObject({ id: owner.stationId });
    expect(portalPage.headers['cache-control']).toBe('no-store');
  });

  it('past STATION_LIST_REQUESTS_PER_INSTALL_PER_HOUR an install gets 429 RATE_LIMITED with Retry-After, and another install is unaffected', async () => {
    const { installToken } = await newInstall();
    for (let request = 0; request < STATION_LIST_REQUESTS_PER_HOUR; request += 1) expect((await listStations(installToken)).status).toBe(200);
    const limited = await listStations(installToken);
    expectRefusal(limited, 429, 'RATE_LIMITED');
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(3_600);
    expect(limited.headers['cache-control']).toBe('no-store');
    expect((await listStations((await newInstall()).installToken)).status).toBe(200);
  });

  it('ALL-ERRORS-02 to -04: a database failure or a programming error underneath is a generic 500 that is never cached, with the stack in the log under the request id', async () => {
    const { installToken } = await newInstall();
    const service = testApplication.application.get(ListenerStationsService);
    const driverError = Object.assign(new Error('duplicate key value violates unique constraint "stations_primary_key"'), { code: '23505', severity: 'ERROR' });
    const failures = [
      new QueryFailedError('SELECT * FROM recognition.list_stations_for_listeners($1)', [1000], driverError),
      new TypeError("Cannot read properties of undefined (reading 'station_id')"),
    ];
    for (const failure of failures) {
      const spy = vi.spyOn(service, 'readListedStations').mockRejectedValueOnce(failure);
      try {
        const response = await listStations(installToken);
        expectRefusal(response, 500, 'INTERNAL');
        expect(response.headers['cache-control']).toBe('no-store');
        await waitForLogWrites();
        const logLine = testApplication.logs.find((line) => line.requestId === response.headers['x-request-id'] && line.level === 50);
        expect((logLine?.err as { stack?: string } | undefined)?.stack, failure.name).toContain(failure.name);
      } finally {
        spy.mockRestore();
      }
    }
  });
});
