import { randomInt, randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathOnly, scrubPersonalData } from '../src/common/privacy/scrub-personal-data.js';
import { waitForLogWrites } from './support/log-capture.js';
import { PORTAL_ORIGIN } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

describe('client error reports', () => {
  let testApplication: TestApplication;
  const report = (body: object, clientAddress = newClientAddress()) =>
    supertest(testApplication.application.getHttpServer()).post('/api/v1/client-errors').set('X-Forwarded-For', clientAddress).send(body);

  beforeAll(async () => {
    testApplication = await createTestApplication();
  });
  afterAll(async () => testApplication.close());

  it('accepts a report without signing in and logs it at error level, scrubbed, with the related request id', async () => {
    const relatedRequestId = randomUUID();
    const response = await report({
      source: 'portal',
      kind: 'uncaught',
      message: 'Cannot read name of undefined for owner@station.example +260 977 123 456',
      stack: 'TypeError: x\n    at render (https://portal.example/assets/app.js?token=abcdefghijklmnopqrstuvwxyz0123456789:1:2)',
      location: '/stations/abc/ads?search=secret#top',
      relatedRequestId,
      appVersion: '0.1.0',
    });
    expect(response.status).toBe(202);
    await waitForLogWrites();
    const logLine = testApplication.logs.find((line) => line.msg === 'client error reported' && (line.clientError as { relatedRequestId?: string })?.relatedRequestId === relatedRequestId);
    expect(logLine?.level).toBe(50);
    const loggedText = JSON.stringify(logLine);
    expect(loggedText).not.toContain('owner@station.example');
    expect(loggedText).not.toContain('977');
    expect(loggedText).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(loggedText).not.toContain('secret');
    expect(logLine?.clientError).toMatchObject({ source: 'portal', kind: 'uncaught', location: '/stations/abc/ads' });
  });

  it('refuses unknown fields and oversized text', async () => {
    expect((await report({ source: 'portal', kind: 'uncaught', message: 'x', cookies: 'a=b' })).status).toBe(400);
    expect((await report({ source: 'portal', kind: 'uncaught', message: 'x'.repeat(501) })).status).toBe(400);
  });

  it('limits reports to 30 a minute per client address', async () => {
    const clientAddress = newClientAddress();
    for (let reportNumber = 0; reportNumber < 30; reportNumber++) {
      expect((await report({ source: 'listener-app', kind: 'reported', message: 'probe' }, clientAddress)).status).toBe(202);
    }
    expect((await report({ source: 'listener-app', kind: 'reported', message: 'probe' }, clientAddress)).status).toBe(429);
  });

  it('a cookie-carrying report from another site is refused (cross-site check)', async () => {
    const response = await supertest(testApplication.application.getHttpServer())
      .post('/api/v1/client-errors')
      .set('Cookie', 'session=x')
      .set('Origin', 'https://other-site.example')
      .send({ source: 'portal', kind: 'uncaught', message: 'x' });
    expect(response.status).toBe(403);
    const fromPortal = await supertest(testApplication.application.getHttpServer())
      .post('/api/v1/client-errors')
      .set('Cookie', 'session=x')
      .set('Origin', PORTAL_ORIGIN)
      .send({ source: 'portal', kind: 'uncaught', message: 'x' });
    expect(fromPortal.status).toBe(202);
  });
});

describe('scrubbing', () => {
  it.each([
    ['an email', 'failed for a.b+c@example.co.zm today', 'failed for [email] today'],
    ['a phone number', 'call 0977 123 456 now', 'call [number] now'],
    ['an international number', 'call +260-977-123-456', 'call [number]'],
    ['a long token', 'token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xyz', 'token [token]'],
    ['a query string', 'GET https://api.example/x?email=a&b=c failed', 'GET https://api.example/x failed'],
  ])('removes %s', (_description, input, expected) => {
    expect(scrubPersonalData(input)).toBe(expected);
  });

  it('keeps only the path of a location', () => {
    expect(pathOnly('/stations/x/ads?cursor=abc#top')).toBe('/stations/x/ads');
  });
});
