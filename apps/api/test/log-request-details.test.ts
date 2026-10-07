import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { databaseSetupClient } from './support/database-clients.js';
import { waitForLogWrites } from './support/log-capture.js';
import { cookiesSetBy, PORTAL_ORIGIN, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * S1-LOGGING-07, S1-LOGGING-08, S1-LOGGING-15: with LOG_REQUEST_DETAILS switched on (for debugging
 * only), request lines carry headers, but credentials in them are still redacted. (This file runs in
 * its own process, so switching the setting here changes no other test.)
 */
describe('request logging with LOG_REQUEST_DETAILS on', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;

  beforeAll(async () => {
    process.env.LOG_REQUEST_DETAILS = 'true';
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
  });
  afterAll(async () => {
    delete process.env.LOG_REQUEST_DETAILS;
    await testUsers.cleanUp();
    await setupClient.end();
    await testApplication.close();
  });

  it('logs headers but redacts cookies, authorization and set-cookie', async () => {
    const response = await supertest(testApplication.application.getHttpServer())
      .post('/api/v1/auth/sign-in')
      .set('Origin', PORTAL_ORIGIN)
      .set('Cookie', '__Host-lookup_refresh=secret-refresh-token-value')
      .set('Authorization', 'Bearer secret-bearer-token-value')
      .send({ email: 'nobody-here@example.test', password: 'a long enough password here' });
    await waitForLogWrites();

    const requestLine = testApplication.logs.find(
      (line) => line.msg !== undefined && (line.req as { id?: string } | undefined)?.id === response.headers['x-request-id'] && 'res' in line,
    );
    const request = requestLine?.req as { headers?: Record<string, string> };
    expect(request.headers?.origin).toBe(PORTAL_ORIGIN);
    expect(request.headers?.cookie).toBe('[redacted]');
    expect(request.headers?.authorization).toBe('[redacted]');
    const logged = JSON.stringify(testApplication.logs.lines);
    expect(logged).not.toContain('secret-refresh-token-value');
    expect(logged).not.toContain('secret-bearer-token-value');
    expect(logged).not.toContain('a long enough password here');
    expect(logged).not.toContain('nobody-here@example.test');
  });

  it('redacts the session cookies a successful sign-in sets', async () => {
    const user = await testUsers.create();
    const response = await supertest(testApplication.application.getHttpServer())
      .post('/api/v1/auth/sign-in')
      .set('Origin', PORTAL_ORIGIN)
      .send({ email: user.email, password: user.password });
    expect(response.status).toBe(200);
    const cookieValues = Object.values(cookiesSetBy(response));
    expect(cookieValues.length).toBeGreaterThanOrEqual(2);
    await waitForLogWrites();

    const responseLine = testApplication.logs.find(
      (line) => (line.req as { id?: string } | undefined)?.id === response.headers['x-request-id'] && 'res' in line,
    );
    expect((responseLine?.res as { headers?: Record<string, unknown> } | undefined)?.headers?.['set-cookie']).toBe('[redacted]');
    const logged = JSON.stringify(testApplication.logs.lines);
    for (const value of cookieValues) expect(logged).not.toContain(value);
  });
});
