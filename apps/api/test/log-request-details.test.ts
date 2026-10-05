import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitForLogWrites } from './support/log-capture.js';
import { PORTAL_ORIGIN } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * S1-LOGGING-07, S1-LOGGING-08, S1-LOGGING-15: with LOG_REQUEST_DETAILS switched on (for debugging
 * only), request lines carry headers, but credentials in them are still redacted. (This file runs in
 * its own process, so switching the setting here changes no other test.)
 */
describe('request logging with LOG_REQUEST_DETAILS on', () => {
  let testApplication: TestApplication;

  beforeAll(async () => {
    process.env.LOG_REQUEST_DETAILS = 'true';
    testApplication = await createTestApplication();
  });
  afterAll(async () => {
    delete process.env.LOG_REQUEST_DETAILS;
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
});
