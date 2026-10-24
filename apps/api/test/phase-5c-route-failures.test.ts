import { randomInt, randomUUID } from 'node:crypto';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ClsService } from 'nestjs-cls';
import type pg from 'pg';
import supertest from 'supertest';
import { type DataSource, QueryFailedError } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { StationScopedTransaction } from '../src/infrastructure/database/station-scoped-transaction.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { waitForLogWrites } from './support/log-capture.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

type FailureKind = 'database' | 'programming';

/** What the next request runs into, and where: a station transaction (after the guard's), or one SQL call. */
const failureSwitch = {
  kind: null as FailureKind | null,
  successfulTransactionsLeft: 0,
  sqlToFail: null as RegExp | null,
};

/** Failures carrying exactly what must never reach a response: SQL, a table name, a value. */
function injectedFailure(kind: FailureKind): Error {
  if (kind === 'database') {
    const driverError = Object.assign(new Error('relation "app.client_viewers_internal" does not exist'), { code: '42P01', severity: 'ERROR' });
    return new QueryFailedError('SELECT * FROM app.client_viewers_internal WHERE email = $1', ['chipo.client@example.test'], driverError);
  }
  return new TypeError("Cannot read properties of undefined (reading 'endpoint_secret')");
}

/**
 * P5C-TESTS-04 (the leak suite on every Phase 5c route; ALL-ERRORS-02 to -04): each client route, each route a station
 * uses to give access, and the client side of the invitation, made to fail inside its own work by a database or a
 * programming error, answers the generic 500 with a request id, and the real failure is in the private log under that id.
 */
describe('phase 5c routes when something underneath fails', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  let owner: PortalTestUser;
  let ownerCookie = '';
  let clientCookie = '';
  const clientId = randomUUID();
  const adId = randomUUID();
  const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  const client = () => supertest(testApplication.application.getHttpServer());

  beforeAll(async () => {
    testApplication = await createTestApplication({
      overrideProviders: (builder) =>
        builder.overrideProvider(StationScopedTransaction).useFactory({
          inject: [getDataSourceToken(), ClsService],
          factory: (dataSource: DataSource, requestContext: ClsService) => {
            const real = new StationScopedTransaction(dataSource, requestContext);
            return {
              run: (work: Parameters<StationScopedTransaction['run']>[0], scope?: Parameters<StationScopedTransaction['run']>[1]) => {
                if (failureSwitch.kind && !failureSwitch.sqlToFail) {
                  if (failureSwitch.successfulTransactionsLeft > 0) failureSwitch.successfulTransactionsLeft -= 1;
                  else return Promise.reject(injectedFailure(failureSwitch.kind));
                }
                return real.run(work, scope);
              },
            };
          },
        }),
    });
    const dataSource = testApplication.application.get<DataSource>(getDataSourceToken());
    const realQuery = dataSource.query.bind(dataSource);
    dataSource.query = ((...queryArguments: Parameters<DataSource['query']>) => {
      if (failureSwitch.kind === 'database' && failureSwitch.sqlToFail?.test(queryArguments[0])) return Promise.reject(injectedFailure('database'));
      return realQuery(...queryArguments);
    }) as DataSource['query'];

    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
    owner = await testUsers.create();
    await setupClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, 'Drill Client')`, [clientId, owner.stationId]);
    await setupClient.query(`INSERT INTO app.ads (id, station_id, client_id, title) VALUES ($1, $2, $3, 'Drill advert')`, [adId, owner.stationId, clientId]);
    const viewer = await testUsers.createClientViewer(owner.stationId, clientId);
    ownerCookie = await signIn(owner.email, owner.password);
    clientCookie = await signIn(viewer.email, viewer.password);
  });
  afterAll(async () => {
    failureSwitch.kind = null;
    await testUsers.cleanUp();
    await setupClient.end();
    await testApplication.close();
  });

  async function signIn(email: string, password: string): Promise<string> {
    const response = await client().post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).send({ email, password });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return cookieHeader(cookiesSetBy(response));
  }

  function send(method: 'get' | 'post' | 'put' | 'delete', path: string, body: object | undefined, cookie: string | null) {
    const request = client()[method](`/api/v1${path}`).set('X-Forwarded-For', newClientAddress()).set('Origin', PORTAL_ORIGIN);
    if (cookie) request.set('Cookie', cookie);
    return body ? request.send(body) : request;
  }

  async function expectGenericFailure(response: supertest.Response, kind: FailureKind) {
    expect(response.status, JSON.stringify(response.body)).toBe(500);
    const envelope = assertErrorEnvelope(response.body);
    expect(envelope.error.code).toBe('INTERNAL');
    expect(envelope.error.request_id).toBe(response.headers['x-request-id']);
    for (const secret of ['client_viewers_internal', 'chipo.client', 'endpoint_secret']) expect(JSON.stringify(response.body)).not.toContain(secret);
    await waitForLogWrites();
    const logLine = testApplication.logs.find((line) => line.requestId === envelope.error.request_id && line.level === 50);
    expect(logLine, 'the real failure is logged under the same request id').toBeDefined();
    expect(String((logLine?.err as { message?: string }).message)).toContain(kind === 'database' ? 'client_viewers_internal' : "reading 'endpoint_secret'");
  }

  type Route = [name: string, method: 'get' | 'post' | 'put' | 'delete', path: () => string, body?: () => object];
  const viewersPath = () => `/stations/${owner.stationId}/clients/${clientId}/viewers`;
  /** A station's routes: the station check runs first in a transaction of its own, then the route's work fails. */
  const stationRoutes: Route[] = [
    ['the clients list', 'get', () => `/stations/${owner.stationId}/clients`],
    ['adding a client with an email', 'post', () => `/stations/${owner.stationId}/clients`, () => ({ name: `Drill ${randomUUID().slice(0, 8)}`, email: `x.${randomUUID().slice(0, 8)}@example.com` })],
    ['who can view a client', 'get', viewersPath],
    ['inviting a client', 'post', () => `${viewersPath()}/invitations`, () => ({ email: `x.${randomUUID().slice(0, 8)}@example.com` })],
    ['sending an invitation again', 'post', () => `${viewersPath()}/invitations/${randomUUID()}/resending`],
    ['cancelling an invitation', 'post', () => `${viewersPath()}/invitations/${randomUUID()}/revocation`],
    ['removing access', 'delete', () => `${viewersPath()}/${randomUUID()}`],
  ];
  /** A client's routes that name a station: the access check runs first, then the route's work fails. */
  const clientStationRoutes: Route[] = [
    ['an advert', 'get', () => `/client/stations/${owner.stationId}/ads/${adId}`],
    ["an advert's figures", 'get', () => `/client/stations/${owner.stationId}/ads/${adId}/figures?range=last7Days`],
    ['who is listening', 'get', () => `/client/stations/${owner.stationId}/ads/${adId}/listener-mix?range=last30Days`],
    ['the spreadsheet', 'get', () => `/client/stations/${owner.stationId}/export.csv`],
  ];
  /** A client's routes that name no station: their own work is the first transaction. */
  const clientOwnRoutes: Route[] = [
    ['the home', 'get', () => '/client/home'],
    ['the notification settings', 'get', () => '/client/notification-settings'],
    ['saving the notification settings', 'put', () => '/client/notification-settings', () => ({ isPushOn: true, isEmailOn: false, leadMinutes: 15, mutedAds: [] })],
  ];

  describe.each(['database', 'programming'] as const)('a %s error inside the route', (kind) => {
    it.each(stationRoutes)('station: %s', async (_name, method, path, body) => {
      Object.assign(failureSwitch, { kind, successfulTransactionsLeft: 1, sqlToFail: null });
      try {
        await expectGenericFailure(await send(method, path(), body?.(), ownerCookie), kind);
      } finally {
        failureSwitch.kind = null;
      }
    });

    it.each(clientStationRoutes)('client: %s', async (_name, method, path, body) => {
      Object.assign(failureSwitch, { kind, successfulTransactionsLeft: 1, sqlToFail: null });
      try {
        await expectGenericFailure(await send(method, path(), body?.(), clientCookie), kind);
      } finally {
        failureSwitch.kind = null;
      }
    });

    it.each(clientOwnRoutes)('client: %s', async (_name, method, path, body) => {
      Object.assign(failureSwitch, { kind, successfulTransactionsLeft: 0, sqlToFail: null });
      try {
        await expectGenericFailure(await send(method, path(), body?.(), clientCookie), kind);
      } finally {
        failureSwitch.kind = null;
      }
    });

    it("a client's access check itself", async () => {
      Object.assign(failureSwitch, { kind, successfulTransactionsLeft: 0, sqlToFail: null });
      try {
        await expectGenericFailure(await send('get', `/client/stations/${owner.stationId}/ads/${adId}`, undefined, clientCookie), kind);
      } finally {
        failureSwitch.kind = null;
      }
    });
  });

  // The invitee's side reads the link before anyone signs in: a station invitation first, then a client's.
  const directRoutes: Array<[name: string, sql: RegExp, path: string, body: () => object]> = [
    ['describing a client invitation', /describe_client_viewer_invitation/, '/invitations/description', () => ({ token: 'B'.repeat(43) })],
    ['accepting a client invitation with a new account', /describe_client_viewer_invitation/, '/invitations/acceptance-with-new-account', () => ({ token: 'B'.repeat(43), fullName: 'X', mobileNumber: null, password: 'long enough password here' })],
  ];

  it.each(directRoutes)('a database error in %s', async (_name, sql, path, body) => {
    Object.assign(failureSwitch, { kind: 'database', successfulTransactionsLeft: 0, sqlToFail: sql });
    try {
      await expectGenericFailure(await send('post', path, body(), null), 'database');
    } finally {
      failureSwitch.kind = null;
      failureSwitch.sqlToFail = null;
    }
  });

  it('P5C-TESTS-04: every phase 5c route the API has is in this suite', () => {
    const express = testApplication.application.getHttpAdapter().getInstance() as { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } };
    const phase5cRoutes = express.router.stack
      .flatMap((layer) => (layer.route ? Object.keys(layer.route.methods).map((method) => ({ method, path: layer.route?.path as string })) : []))
      .filter(({ path }) => /^\/api\/v1\/(client\/|stations\/:stationId\/clients\/:clientId\/viewers)/.test(path));
    expect(phase5cRoutes.length).toBeGreaterThan(10);
    const tried = [...stationRoutes, ...clientStationRoutes, ...clientOwnRoutes].map(([, method, path]) => `${method} /api/v1${path().split('?')[0]}`);
    const untried = phase5cRoutes.filter(({ method, path }) => {
      const pattern = new RegExp(`^${method} ${path.replace(/\./g, '\\.').replace(/:[A-Za-z]+/g, '[^/]+')}$`);
      return !tried.some((request) => pattern.test(request));
    });
    expect(untried).toEqual([]);
  });
});
