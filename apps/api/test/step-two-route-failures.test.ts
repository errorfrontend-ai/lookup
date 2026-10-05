import { randomInt, randomUUID } from 'node:crypto';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ClsService } from 'nestjs-cls';
import type pg from 'pg';
import supertest from 'supertest';
import { type DataSource, QueryFailedError } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { StationScopedTransaction } from '../src/infrastructure/database/station-scoped-transaction.js';
import { ObjectStorage } from '../src/infrastructure/object-storage/object-storage.js';
import { mp3Bytes } from './support/audio-fixtures.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { waitForLogWrites } from './support/log-capture.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

type FailureKind = 'database' | 'programming' | 'storage';

/** What the next request should run into. Database failures can be aimed at one SQL function. */
const failureSwitch = {
  kind: null as FailureKind | null,
  /** Station-scoped transactions allowed to succeed first (the station guard's membership check is one). */
  successfulTransactionsLeft: 0,
  /** For routes that query directly rather than in a station transaction: the SQL to fail. */
  sqlToFail: null as RegExp | null,
};

/** Failures carrying exactly what must never reach a response: SQL, a table name, a bucket path, a value. */
function injectedFailure(kind: FailureKind): Error {
  if (kind === 'database') {
    const driverError = Object.assign(new Error('relation "app.ads_internal" does not exist'), { code: '42P01', severity: 'ERROR' });
    return new QueryFailedError('SELECT * FROM app.ads_internal WHERE owner_email = $1', ['chanda.mwale@example.test'], driverError);
  }
  if (kind === 'storage') return new Error('AccessDenied: http://127.0.0.1:59000/lookup-ad-uploads/ad-uploads/station/ad/key');
  return new TypeError("Cannot read properties of undefined (reading 'station_id')");
}

/**
 * S2-TESTS-09: every Step 2 route, made to fail inside its own work (not only in a guard) by a
 * database error, a programming error or a storage error, answers with the generic envelope and a
 * request id, and the real failure is in the private log under that id.
 */
describe('Step 2 routes when something underneath fails', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  let owner: PortalTestUser;
  let ownerCookies: Record<string, string>;
  let stationPath: string;
  let adPath: string;
  /** An ad whose audio was never sent, so upload and completion still reach storage. */
  let pendingAdPath: string;
  const client = () => supertest(testApplication.application.getHttpServer());
  const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

  beforeAll(async () => {
    testApplication = await createTestApplication({
      overrideProviders: (builder) =>
        builder.overrideProvider(StationScopedTransaction).useFactory({
          inject: [getDataSourceToken(), ClsService],
          factory: (dataSource: DataSource, requestContext: ClsService) => {
            const realTransaction = new StationScopedTransaction(dataSource, requestContext);
            return {
              run: (work: Parameters<StationScopedTransaction['run']>[0], scope?: Parameters<StationScopedTransaction['run']>[1]) => {
                const kind = failureSwitch.kind;
                if ((kind === 'database' || kind === 'programming') && !failureSwitch.sqlToFail) {
                  if (failureSwitch.successfulTransactionsLeft > 0) failureSwitch.successfulTransactionsLeft -= 1;
                  else return Promise.reject(injectedFailure(kind));
                }
                return realTransaction.run(work, scope);
              },
            };
          },
        }),
    });

    // Routes that query directly (sign-in, refresh, sign-out, password change) fail on their own SQL.
    const dataSource = testApplication.application.get<DataSource>(getDataSourceToken());
    const realQuery = dataSource.query.bind(dataSource);
    // Every argument passes through: a transaction's queries arrive here with their query runner third.
    dataSource.query = ((...queryArguments: Parameters<DataSource['query']>) => {
      if (failureSwitch.kind === 'database' && failureSwitch.sqlToFail?.test(queryArguments[0])) return Promise.reject(injectedFailure('database'));
      return realQuery(...queryArguments);
    }) as DataSource['query'];
    // Storage calls fail when asked to.
    const objectStorage = testApplication.application.get(ObjectStorage);
    for (const methodName of ['createUploadUrl', 'createPlaybackUrl', 'describeObject', 'readFirstBytes', 'deleteObject'] as const) {
      const realMethod = (objectStorage[methodName] as (...arguments_: unknown[]) => Promise<unknown>).bind(objectStorage);
      (objectStorage as unknown as Record<string, unknown>)[methodName] = (...arguments_: unknown[]) =>
        failureSwitch.kind === 'storage' ? Promise.reject(injectedFailure('storage')) : realMethod(...arguments_);
    }

    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
    owner = await testUsers.create();
    ownerCookies = await signIn(owner);
    stationPath = `/api/v1/stations/${owner.stationId}`;

    // One uploaded ad, so every ad route has something real to work on until a failure is switched on.
    const clientId = (await send('post', `${stationPath}/clients`, { name: 'Brand A' })).body.id as string;
    const bytes = mp3Bytes();
    const created = await send('post', `${stationPath}/ads`, {
      clientId,
      title: 'Failure drill',
      upload: { fileName: 'drill.mp3', contentType: 'audio/mpeg', sizeBytes: bytes.length },
    });
    expect(created.status).toBe(201);
    await fetch(created.body.upload.url, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'audio/mpeg' } });
    adPath = `${stationPath}/ads/${created.body.adId}`;
    expect((await send('post', `${adPath}/complete`)).status).toBe(200);
    const pending = await send('post', `${stationPath}/ads`, {
      clientId,
      title: 'Never uploaded',
      upload: { fileName: 'pending.mp3', contentType: 'audio/mpeg', sizeBytes: bytes.length },
    });
    pendingAdPath = `${stationPath}/ads/${pending.body.adId}`;
  });
  afterAll(async () => {
    failureSwitch.kind = null;
    await testUsers.cleanUp();
    await setupClient.end();
    await testApplication.close();
  });

  async function signIn(user: PortalTestUser): Promise<Record<string, string>> {
    const response = await client()
      .post('/api/v1/auth/sign-in')
      .set('Origin', PORTAL_ORIGIN)
      .set('X-Forwarded-For', newClientAddress())
      .send({ email: user.email, password: user.password });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return cookiesSetBy(response);
  }

  function send(method: 'get' | 'post' | 'put', path: string, body?: object, cookies = ownerCookies) {
    const request = client()[method](path).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookieHeader(cookies));
    if (method !== 'get') request.set('Origin', PORTAL_ORIGIN);
    return body ? request.send(body) : request;
  }

  async function expectGenericFailure(response: supertest.Response, kind: FailureKind) {
    expect(response.status, JSON.stringify(response.body)).toBe(500);
    const envelope = assertErrorEnvelope(response.body);
    expect(envelope.error.code).toBe('INTERNAL');
    expect(envelope.error.request_id).toBe(response.headers['x-request-id']);
    for (const secret of ['ads_internal', 'chanda.mwale', 'lookup-ad-uploads', '59000', 'station_id']) {
      expect(JSON.stringify(response.body)).not.toContain(secret);
    }
    await waitForLogWrites();
    const logLine = testApplication.logs.find((line) => line.requestId === envelope.error.request_id && line.level === 50);
    expect(logLine, 'the real failure is logged under the same request id').toBeDefined();
    expect(String((logLine?.err as { message?: string }).message)).toContain(
      kind === 'database' ? 'ads_internal' : kind === 'storage' ? 'AccessDenied' : "reading 'station_id'",
    );
  }

  const uploadRequest = { upload: { fileName: 'again.mp3', contentType: 'audio/mpeg', sizeBytes: 2048 } };
  const card = () => ({
    schema_version: 1,
    layout: 'VERTICAL_STACK',
    actions: [{ type: 'CALL', id: randomUUID(), label: 'Call us', style: 'PRIMARY', phone_number_e164: '+260977123456' }],
  });
  const schedule = { startsOn: '2026-11-02', endsOn: '2026-11-30', timeWindows: [{ daysOfWeek: [1], localStartTime: '07:00', localEndTime: '09:00' }], gracePeriodMinutes: 10 };

  const stationRoutes: Array<[name: string, method: 'get' | 'post' | 'put', path: () => string, body?: () => object]> = [
    ['station profile', 'get', () => stationPath],
    ['list clients', 'get', () => `${stationPath}/clients`],
    ['create a client', 'post', () => `${stationPath}/clients`, () => ({ name: `Brand ${randomUUID().slice(0, 6)}` })],
    ['list ads', 'get', () => `${stationPath}/ads`],
    ['create an ad', 'post', () => `${stationPath}/ads`, () => ({ clientId: randomUUID(), title: 'x', upload: uploadRequest.upload })],
    ['get an ad', 'get', () => adPath],
    ['request an upload URL', 'post', () => `${adPath}/upload-url`, () => uploadRequest],
    ['complete an upload', 'post', () => `${adPath}/complete`],
    ['save buttons', 'put', () => `${adPath}/card`, card],
    ['save a schedule', 'put', () => `${adPath}/schedule`, () => schedule],
    ['publish', 'post', () => `${adPath}/publish`],
    ['get a playback URL', 'get', () => `${adPath}/playback-url`],
  ];

  describe.each(['database', 'programming'] as const)('a %s error inside the route', (kind) => {
    it.each(stationRoutes)('%s', async (_name, method, path, body) => {
      failureSwitch.kind = kind;
      failureSwitch.successfulTransactionsLeft = 1;
      try {
        const response = await send(method, path(), body?.());
        await expectGenericFailure(response, kind);
      } finally {
        failureSwitch.kind = null;
      }
    });
  });

  it.each([
    ['request an upload URL', 'post', () => `${pendingAdPath}/upload-url`, () => uploadRequest],
    ['complete an upload', 'post', () => `${pendingAdPath}/complete`, undefined],
    ['get a playback URL', 'get', () => `${adPath}/playback-url`, undefined],
  ] as const)('a storage error: %s', async (_name, method, path, body) => {
    failureSwitch.kind = 'storage';
    try {
      await expectGenericFailure(await send(method, path(), body?.()), 'storage');
    } finally {
      failureSwitch.kind = null;
    }
  });

  it('a database error in who-am-I', async () => {
    failureSwitch.kind = 'database';
    failureSwitch.successfulTransactionsLeft = 0;
    try {
      await expectGenericFailure(await send('get', '/api/v1/auth/me'), 'database');
    } finally {
      failureSwitch.kind = null;
    }
  });

  it.each([
    ['sign in', /sign_in_portal_user/],
    ['refresh', /rotate_portal_refresh_token/],
    ['change password', /change_portal_user_password/],
  ] as const)('a database error in %s', async (name, sqlToFail) => {
    const user = await testUsers.create();
    const cookies = await signIn(user);
    failureSwitch.kind = 'database';
    failureSwitch.sqlToFail = sqlToFail;
    try {
      const response =
        name === 'sign in'
          ? await client().post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).send({ email: user.email, password: user.password })
          : name === 'refresh'
            ? await send('post', '/api/v1/auth/refresh', undefined, cookies)
            : await send('post', '/api/v1/auth/change-password', { currentPassword: user.password, newPassword: 'copper lantern quiet meadow' }, cookies);
      await expectGenericFailure(response, 'database');
    } finally {
      failureSwitch.kind = null;
      failureSwitch.sqlToFail = null;
    }
  });
});
