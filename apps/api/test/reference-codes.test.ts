import { randomInt, randomUUID } from 'node:crypto';
import { referenceCodeForRequestId } from '@lookup/contracts';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FailureRoutesModule } from './support/failure-routes.module.js';
import { type LogLine, waitForLogWrites } from './support/log-capture.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

/**
 * The reference code the listener app shows (design S4-D9) is all support needs: the first 8 hex
 * digits of the request id, found in the log by searching for a requestId that starts with them.
 * S4-ERROR-07 and S4-ERRORREPORTING-08, the API's half.
 */
describe('finding a log line from the reference code a listener reads out', () => {
  let testApplication: TestApplication;
  const client = () => supertest(testApplication.application.getHttpServer());
  const linesForCode = (referenceCode: string) => {
    const digits = referenceCode.replace('-', '').toLowerCase();
    return testApplication.logs.lines.filter((line: LogLine) => typeof line.requestId === 'string' && line.requestId.startsWith(digits));
  };

  beforeAll(async () => {
    testApplication = await createTestApplication({ extraModules: [FailureRoutesModule] });
  });
  afterAll(async () => testApplication.close());

  it('a server failure: the code made from the echoed request id finds the full error, with its stack, and nothing else', async () => {
    const sentRequestId = randomUUID();
    const response = await client().get('/api/v1/test-only/programming-error').set('X-Request-Id', sentRequestId);
    expect(response.status).toBe(500);
    expect(response.headers['x-request-id']).toBe(sentRequestId);
    const referenceCode = referenceCodeForRequestId(response.body.error.request_id);
    expect(referenceCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);

    await waitForLogWrites();
    const found = linesForCode(referenceCode as string);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((line) => line.requestId === sentRequestId)).toBe(true);
    const errorLine = found.find((line) => line.level === 50);
    expect(JSON.stringify(errorLine?.err)).toContain('stack');
    // The answer the listener saw carries none of it.
    expect(JSON.stringify(response.body)).not.toMatch(/stack|TypeError|\.ts:\d+/);
  });

  it('a crash report from the app: the code of its accepted report finds the report in the log', async () => {
    const reportRequestId = randomUUID();
    const response = await client()
      .post('/api/v1/client-errors')
      .set('X-Forwarded-For', newClientAddress())
      .set('X-Request-Id', reportRequestId)
      .send({ source: 'listener-app', kind: 'uncaught', message: 'State error: the recorder was used after it was closed', appVersion: '0.1.0+1' });
    expect(response.status).toBe(202);
    expect(response.headers['x-request-id']).toBe(reportRequestId);
    const referenceCode = referenceCodeForRequestId(response.headers['x-request-id']);

    await waitForLogWrites();
    const reportLine = linesForCode(referenceCode as string).find((line) => line.msg === 'client error reported');
    expect(reportLine?.level).toBe(50);
    expect(reportLine?.clientError).toMatchObject({ source: 'listener-app', kind: 'uncaught' });
  });
});
