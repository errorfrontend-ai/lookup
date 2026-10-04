import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('health and request ids', () => {
  let testApplication: TestApplication;
  const client = () => supertest(testApplication.application.getHttpServer());

  beforeAll(async () => {
    testApplication = await createTestApplication();
  });
  afterAll(async () => testApplication.close());

  it('reports ok when the database and key-value store answer', async () => {
    const response = await client().get('/api/v1/health').expect(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['x-request-id']).toMatch(UUID_PATTERN);
  });

  it('echoes a well-formed request id from the caller', async () => {
    const requestId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const response = await client().get('/api/v1/health').set('X-Request-Id', requestId).expect(200);
    expect(response.headers['x-request-id']).toBe(requestId);
  });

  // Node's HTTP stack already rejects CR/LF in headers, so these are the hostile values that can
  // actually arrive: forged-log JSON, markup, path tricks and oversized ids.
  it.each([
    ['forged log JSON', '{"level":60,"msg":"forged log line"}'],
    ['markup', '<script>alert(1)</script>'],
    ['path tricks', '../../etc/passwd'],
    ['oversized', 'a'.repeat(2000)],
    ['almost a UUID', '0f8fad5b-d9cb-469f-a165-70867728950e-extra'],
  ])('replaces a hostile request id (%s) with a fresh one', async (_description, hostileRequestId) => {
    const response = await client().get('/api/v1/health').set('X-Request-Id', hostileRequestId).expect(200);
    expect(response.headers['x-request-id']).toMatch(UUID_PATTERN);
  });
});
