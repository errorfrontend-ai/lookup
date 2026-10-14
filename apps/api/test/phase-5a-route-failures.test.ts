import { randomInt, randomUUID } from 'node:crypto';
import { computeTwoFactorCode, decodeBase32, twoFactorTimeStepAt } from '@lookup/contracts';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ClsService } from 'nestjs-cls';
import type pg from 'pg';
import supertest from 'supertest';
import { type DataSource, QueryFailedError } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../scripts/create-super-admin.js';
import { loadDatabaseSetupConfig } from '../scripts/database-setup-config.js';
import { HUMAN_CHECK_DUMMY_TOKEN } from '../src/common/security/human-check.js';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { ADMIN_DATA_SOURCE, AdminTransaction } from '../src/infrastructure/admin-database/admin-database.module.js';
import { StationScopedTransaction } from '../src/infrastructure/database/station-scoped-transaction.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { waitForLogWrites } from './support/log-capture.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

type FailureKind = 'database' | 'programming';

/** What the next request runs into, and where: a station transaction (after the guard's), the admin's, or one SQL call. */
const failureSwitch = {
  kind: null as FailureKind | null,
  successfulTransactionsLeft: 0,
  isAdmin: false,
  sqlToFail: null as RegExp | null,
};

/** Failures carrying exactly what must never reach a response: SQL, a table name, a value. */
function injectedFailure(kind: FailureKind): Error {
  if (kind === 'database') {
    const driverError = Object.assign(new Error('relation "app.stations_internal" does not exist'), { code: '42P01', severity: 'ERROR' });
    return new QueryFailedError('SELECT * FROM app.stations_internal WHERE contact_email = $1', ['mutale.banda@example.test'], driverError);
  }
  return new TypeError("Cannot read properties of undefined (reading 'licence_number')");
}

/**
 * P5A design §6 (the leak suite on every 5a route; ALL-ERRORS-02 to -04): each sign-up, team, change-request,
 * second-factor and admin route, made to fail inside its own work by a database or a programming error, answers the
 * generic 500 with a request id, and the real failure is in the private log under that id.
 */
describe('phase 5a routes when something underneath fails', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  let owner: PortalTestUser;
  let ownerCookie = '';
  let applicantCookie = '';
  let applicantStationId = '';
  let adminCookie = '';
  const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  const client = () => supertest(testApplication.application.getHttpServer());
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    testApplication = await createTestApplication({
      overrideProviders: (builder) =>
        builder
          .overrideProvider(StationScopedTransaction)
          .useFactory({
            inject: [getDataSourceToken(), ClsService],
            factory: (dataSource: DataSource, requestContext: ClsService) => {
              const real = new StationScopedTransaction(dataSource, requestContext);
              return {
                run: (work: Parameters<StationScopedTransaction['run']>[0], scope?: Parameters<StationScopedTransaction['run']>[1]) => {
                  if (failureSwitch.kind && !failureSwitch.isAdmin && !failureSwitch.sqlToFail) {
                    if (failureSwitch.successfulTransactionsLeft > 0) failureSwitch.successfulTransactionsLeft -= 1;
                    else return Promise.reject(injectedFailure(failureSwitch.kind));
                  }
                  return real.run(work, scope);
                },
              };
            },
          })
          .overrideProvider(AdminTransaction)
          .useFactory({
            inject: [getDataSourceToken(ADMIN_DATA_SOURCE), ClsService],
            factory: (dataSource: DataSource, requestContext: ClsService) => {
              const real = new AdminTransaction(dataSource, requestContext);
              return {
                run: (work: Parameters<AdminTransaction['run']>[0], scope?: Parameters<AdminTransaction['run']>[1]) =>
                  failureSwitch.kind && failureSwitch.isAdmin ? Promise.reject(injectedFailure(failureSwitch.kind)) : real.run(work, scope),
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
    ownerCookie = await signIn(owner.email, owner.password);
    const applicant = await testUsers.create({ stationStatus: 'PENDING_REVIEW' });
    await setupClient.query(`UPDATE app.stations SET status = 'REJECTED' WHERE id = $1`, [applicant.stationId]);
    applicantStationId = applicant.stationId;
    applicantCookie = await signIn(applicant.email, applicant.password);

    const password = `quiet harbour lantern ${randomUUID().slice(24)}`;
    const email = `failure.admin.${randomUUID().slice(0, 8)}@example.com`;
    const enrolment = await createSuperAdmin(loadDatabaseSetupConfig().setupUrl, { email, fullName: 'Failure Drill', password }, process.env.TWO_FACTOR_ENCRYPTION_SECRET as string);
    createdUserIds.push(enrolment.portalUserId);
    adminCookie = await signIn(email, password);
    const code = await computeTwoFactorCode(decodeBase32(enrolment.secretBase32) as Uint8Array, twoFactorTimeStepAt(Date.now()));
    await client().post('/api/v1/auth/two-factor-code').set('Origin', PORTAL_ORIGIN).set('Cookie', adminCookie).send({ code }).expect(204);
  });
  afterAll(async () => {
    failureSwitch.kind = null;
    await setupClient.query('DELETE FROM app.audit_events WHERE actor_portal_user_id = ANY($1) OR entity_id = ANY($1)', [createdUserIds]);
    await testUsers.cleanUp();
    await setupClient.query('DELETE FROM app.portal_users WHERE id = ANY($1)', [createdUserIds]);
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
    for (const secret of ['stations_internal', 'mutale.banda', 'licence_number', 'contact_email']) expect(JSON.stringify(response.body)).not.toContain(secret);
    await waitForLogWrites();
    const logLine = testApplication.logs.find((line) => line.requestId === envelope.error.request_id && line.level === 50);
    expect(logLine, 'the real failure is logged under the same request id').toBeDefined();
    expect(String((logLine?.err as { message?: string }).message)).toContain(kind === 'database' ? 'stations_internal' : "reading 'licence_number'");
  }

  type Route = [name: string, method: 'get' | 'post' | 'put' | 'delete', path: () => string, body?: () => object];
  const applicationPath = () => `/stations/${applicantStationId}/application`;
  const applicationRoutes: Route[] = [
    ['read the application', 'get', applicationPath],
    ['change the account', 'put', () => `${applicationPath()}/account`, () => ({ fullName: 'Mutale Banda', email: `x.${randomUUID().slice(0, 8)}@example.com`, mobileNumber: '977123456' })],
    ['send a phone code', 'post', () => `${applicationPath()}/phone-verification-codes`],
    ['check a phone code', 'post', () => `${applicationPath()}/phone-verification`, () => ({ code: '123456' })],
    ['send an email link', 'post', () => `${applicationPath()}/email-verification-links`],
    ['save the details', 'put', () => `${applicationPath()}/details`, () => ({ name: 'Drill FM', frequencyLabel: '90.1 FM', province: 'Lusaka', city: 'Lusaka', timeZone: 'Africa/Lusaka', coverageNote: null, streamAddress: null })],
    ['save the licence number', 'put', () => `${applicationPath()}/licence`, () => ({ licenceNumber: 'IBA/2026/0001' })],
    ['submit', 'post', () => `${applicationPath()}/submission`, () => ({ isLicenceConfirmed: true })],
  ];
  const activeStationRoutes: Route[] = [
    ['read the change request', 'get', () => `/stations/${owner.stationId}/change-request`],
    ['ask for a change', 'post', () => `/stations/${owner.stationId}/change-requests`, () => ({ name: 'Drill FM', frequencyLabel: '90.1 FM', licenceNumber: 'IBA/2026/0001', licenceDocumentUploadId: null })],
    ['withdraw a change', 'post', () => `/stations/${owner.stationId}/change-request/withdrawal`],
    ['read the team', 'get', () => `/stations/${owner.stationId}/members`],
    ['invite', 'post', () => `/stations/${owner.stationId}/invitations`, () => ({ email: `x.${randomUUID().slice(0, 8)}@example.com`, role: 'ANALYST' })],
    ['revoke an invitation', 'post', () => `/stations/${owner.stationId}/invitations/${randomUUID()}/revocation`],
    ['remove a member', 'delete', () => `/stations/${owner.stationId}/members/${randomUUID()}`],
  ];
  const adminRoutes: Route[] = [
    ['the summary', 'get', () => '/admin/summary'],
    ['the queue', 'get', () => '/admin/applications'],
    ['an application', 'get', () => `/admin/applications/${applicantStationId}`],
    ['a licence link', 'post', () => `/admin/applications/${applicantStationId}/licence-document-link`],
    ['an approval', 'post', () => `/admin/applications/${applicantStationId}/approval`],
    ['a rejection', 'post', () => `/admin/applications/${applicantStationId}/rejection`, () => ({ reason: 'A reason long enough to be accepted.' })],
    ['a change approval', 'post', () => `/admin/change-requests/${randomUUID()}/approval`],
    ['a change rejection', 'post', () => `/admin/change-requests/${randomUUID()}/rejection`, () => ({ reason: 'A reason long enough to be accepted.' })],
    ['a change’s licence link', 'post', () => `/admin/change-requests/${randomUUID()}/licence-document-link`],
    ['the stations', 'get', () => '/admin/stations?search=drill'],
    ['a suspension', 'post', () => `/admin/stations/${owner.stationId}/suspension`, () => ({ reason: 'A reason long enough to be accepted.' })],
    ['a reactivation', 'post', () => `/admin/stations/${owner.stationId}/reactivation`],
    ['the audio findings', 'get', () => '/admin/audio-overlaps'],
    ['a preview', 'post', () => `/admin/audio-overlaps/${randomUUID()}/preview-links`],
    ['a finding\'s review', 'post', () => `/admin/audio-overlaps/${randomUUID()}/review`, () => ({ note: null })],
    ['System health', 'get', () => '/admin/system-health'],
    ['a reference code', 'get', () => '/admin/reference-codes/ABCD-1234'],
  ];

  /** Routes whose own work touches no database: the failure comes in the station check before it. */
  const checkedFirstRoutes: Array<[...Route, cookie: () => string]> = [
    ['a logo upload address', 'post', () => `${applicationPath()}/logo-uploads`, () => ({ fileName: 'logo.png', contentType: 'image/png', byteCount: 1000 }), () => applicantCookie],
    ['a logo upload’s check', 'post', () => `${applicationPath()}/logo-uploads/${randomUUID()}/complete`, undefined, () => applicantCookie],
    ['a licence upload address', 'post', () => `${applicationPath()}/licence-document-uploads`, () => ({ fileName: 'licence.pdf', contentType: 'application/pdf', byteCount: 1000 }), () => applicantCookie],
    ['a licence upload’s check', 'post', () => `${applicationPath()}/licence-document-uploads/${randomUUID()}/complete`, undefined, () => applicantCookie],
    ['a change document address', 'post', () => `/stations/${owner.stationId}/change-request/licence-document-uploads`, () => ({ fileName: 'licence.pdf', contentType: 'application/pdf', byteCount: 1000 }), () => ownerCookie],
    ['a change document’s check', 'post', () => `/stations/${owner.stationId}/change-request/licence-document-uploads/${randomUUID()}/complete`, undefined, () => ownerCookie],
  ];

  describe.each(['database', 'programming'] as const)('a %s error inside the route', (kind) => {
    it.each(checkedFirstRoutes)('files: %s', async (_name, method, path, body, cookie) => {
      Object.assign(failureSwitch, { kind, successfulTransactionsLeft: 0, isAdmin: false, sqlToFail: null });
      try {
        await expectGenericFailure(await send(method, path(), body?.(), cookie()), kind);
      } finally {
        failureSwitch.kind = null;
      }
    });

    it.each(applicationRoutes)('sign-up: %s', async (_name, method, path, body) => {
      Object.assign(failureSwitch, { kind, successfulTransactionsLeft: 1, isAdmin: false, sqlToFail: null });
      try {
        await expectGenericFailure(await send(method, path(), body?.(), applicantCookie), kind);
      } finally {
        failureSwitch.kind = null;
      }
    });

    it.each(activeStationRoutes)('team and changes: %s', async (_name, method, path, body) => {
      Object.assign(failureSwitch, { kind, successfulTransactionsLeft: 1, isAdmin: false, sqlToFail: null });
      try {
        await expectGenericFailure(await send(method, path(), body?.(), ownerCookie), kind);
      } finally {
        failureSwitch.kind = null;
      }
    });

    it('accepting an invitation while signed in', async () => {
      Object.assign(failureSwitch, { kind, successfulTransactionsLeft: 0, isAdmin: false, sqlToFail: null });
      try {
        await expectGenericFailure(await send('post', '/invitations/acceptance', { token: 'A'.repeat(43) }, ownerCookie), kind);
      } finally {
        failureSwitch.kind = null;
      }
    });

    it.each(adminRoutes)('admin: %s', async (_name, method, path, body) => {
      Object.assign(failureSwitch, { kind, successfulTransactionsLeft: 0, isAdmin: true, sqlToFail: null });
      try {
        await expectGenericFailure(await send(method, path(), body?.(), adminCookie), kind);
      } finally {
        failureSwitch.kind = null;
      }
    });
  });

  const directRoutes: Array<[name: string, sql: RegExp, path: string, body: () => object, cookie: () => string | null]> = [
    ['sign-up step 1', /register_station_applicant/, '/registration/applicants', () => ({
      fullName: 'Mutale Banda', email: `drill.${randomUUID().slice(0, 8)}@example.com`, mobileNumber: `97${String(randomInt(0, 10_000_000)).padStart(7, '0')}`,
      password: `river crossing at dawn ${randomUUID().slice(24)}`, humanCheckToken: HUMAN_CHECK_DUMMY_TOKEN,
    }), () => null],
    ['the email link', /confirm_email_verification_link/, '/registration/email-verifications', () => ({ token: 'A'.repeat(43) }), () => null],
    ['describing an invitation', /describe_invitation/, '/invitations/description', () => ({ token: 'A'.repeat(43) }), () => null],
    ['joining with a new account', /describe_invitation/, '/invitations/acceptance-with-new-account', () => ({ token: 'A'.repeat(43), fullName: 'X', mobileNumber: null, password: 'long enough password here' }), () => null],
    ['the second-factor code', /find_two_factor_secret/, '/auth/two-factor-code', () => ({ code: '123456' }), () => adminCookie],
  ];

  it.each(directRoutes)('a database error in %s', async (_name, sql, path, body, cookie) => {
    Object.assign(failureSwitch, { kind: 'database', successfulTransactionsLeft: 0, isAdmin: false, sqlToFail: sql });
    try {
      await expectGenericFailure(await send('post', path, body(), cookie()), 'database');
    } finally {
      failureSwitch.kind = null;
      failureSwitch.sqlToFail = null;
    }
  });

  it('P5A-TESTS-10: every phase 5a route the API has is in this suite', () => {
    const express = testApplication.application.getHttpAdapter().getInstance() as { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } };
    const phase5aRoutes = express.router.stack.flatMap((layer) =>
      layer.route ? Object.keys(layer.route.methods).map((method) => ({ method, path: layer.route?.path as string })) : [],
    ).filter(({ path }) => /^\/api\/v1\/(admin|registration|invitations|auth\/two-factor-code|stations\/:stationId\/(application|change-request|invitations|members))/.test(path));
    const tried = [
      ...[...applicationRoutes, ...activeStationRoutes, ...adminRoutes, ...checkedFirstRoutes].map(([, method, path]) => ({ method, path: path() })),
      { method: 'post', path: '/invitations/acceptance' },
      ...directRoutes.map(([, , path]) => ({ method: 'post', path })),
    ].map(({ method, path }) => `${method} /api/v1${path.split('?')[0]}`);
    const untried = phase5aRoutes.filter(({ method, path }) => {
      const pattern = new RegExp(`^${method} ${path.replace(/:[A-Za-z]+/g, '[^/]+')}$`);
      return !tried.some((request) => pattern.test(request));
    });
    expect(untried).toEqual([]);
  });
});
