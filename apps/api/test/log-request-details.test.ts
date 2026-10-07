import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { databaseSetupClient } from './support/database-clients.js';
import { waitForLogWrites } from './support/log-capture.js';
import { aacClipBytes, defaultRecognizeFields, recognize, registerInstall } from './support/listener-test-kit.js';
import { cookiesSetBy, PORTAL_ORIGIN, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * S1-LOGGING-07, S1-LOGGING-08, S1-LOGGING-15, S3-LOGGING-07: with LOG_REQUEST_DETAILS switched on (for
 * debugging only), request lines carry headers, but credentials in them are still redacted, and a
 * listener's clip and its fields are never logged. (This file runs in
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

  it('a listener’s recognize request logs neither the clip nor its fields nor the install token, even with request details on', async () => {
    const client = () => supertest(testApplication.application.getHttpServer());
    const install = await registerInstall(client);
    const installRowId = JSON.parse(Buffer.from(install.installToken.split('.')[1] as string, 'base64url').toString('utf8')).sub as string;
    const marker = `clip-content-${randomUUID()}`;
    const clip = Buffer.concat([aacClipBytes(2_048), Buffer.from(marker)]);
    const fields = defaultRecognizeFields();
    try {
      const response = await recognize(client, { installToken: install.installToken, audio: clip, fields });
      expect(response.headers['x-request-id']).toBeDefined();
      await waitForLogWrites();
      expect(testApplication.logs.find((line) => (line.req as { id?: string } | undefined)?.id === response.headers['x-request-id'])).toBeDefined();
      const logged = JSON.stringify(testApplication.logs.lines);
      for (const secret of [marker, clip.toString('base64').slice(0, 48), clip.subarray(0, 64).toString('hex'), install.installToken, install.installId, fields.idempotency_key as string, fields.captured_at as string, fields.sent_at as string]) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = $1', [installRowId]);
      await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = $1', [installRowId]);
      await setupClient.query('DELETE FROM app.listener_installs WHERE id = $1', [installRowId]);
    }
  });
});
