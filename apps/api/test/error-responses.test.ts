import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FailureRoutesModule } from './support/failure-routes.module.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { waitForLogWrites } from './support/log-capture.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * The leak regression suite: every failure returns the public envelope
 * { error: { code, message, request_id } } with nothing technical in it, and the full detail —
 * message, stack, route, request id — lands in the private log instead.
 */
describe('error responses never expose internals', () => {
  let testApplication: TestApplication;
  const client = () => supertest(testApplication.application.getHttpServer());

  beforeAll(async () => {
    testApplication = await createTestApplication({ extraModules: [FailureRoutesModule] });
  });
  afterAll(async () => testApplication.close());

  function expectErrorEnvelope(response: supertest.Response, httpStatus: number, code: string) {
    expect(response.status).toBe(httpStatus);
    expect(Object.keys(response.body)).toEqual(['error']);
    expect(response.body.error.code).toBe(code);
    expect(typeof response.body.error.message).toBe('string');
    expect(response.body.error.request_id).toBe(response.headers['x-request-id']);
    assertErrorEnvelope(response.body);
  }

  it('database errors become a generic 500, with the real error and stack in the log', async () => {
    const response = await client().get('/api/v1/test-only/database-error');
    expectErrorEnvelope(response, 500, 'INTERNAL');

    await waitForLogWrites();
    const logLine = testApplication.logs.find((line) => line.requestId === response.body.error.request_id && line.level === 50);
    expect(logLine, 'error-level log line with the same request id').toBeDefined();
    const loggedError = JSON.stringify(logLine?.err);
    expect(loggedError).toContain('duplicate key');
    expect(loggedError).toContain('stack');
    expect(logLine?.route).toBe('/api/v1/test-only/database-error');
  });

  it('a malformed id reaching the database gives no driver text back', async () => {
    expectErrorEnvelope(await client().get('/api/v1/test-only/malformed-id/not-a-uuid'), 500, 'INTERNAL');
  });

  it('broken percent-encoding in the URL gets a plain 400', async () => {
    expectErrorEnvelope(await client().get('/api/v1/test-only/malformed-id/%E0%A4%A'), 400, 'BAD_REQUEST');
  });

  it('programming errors become a generic 500', async () => {
    expectErrorEnvelope(await client().get('/api/v1/test-only/programming-error'), 500, 'INTERNAL');
  });

  it('a message written for the user is relayed; its private detail is not', async () => {
    const response = await client().get('/api/v1/test-only/app-error');
    expectErrorEnvelope(response, 409, 'CONFLICT');
    expect(response.body.error.message).toBe('This conflicts with something that already exists.');
    expect(JSON.stringify(response.body)).not.toContain('station 42');
  });

  it('framework exception text is never passed through', async () => {
    const response = await client().get('/api/v1/test-only/framework-error');
    expectErrorEnvelope(response, 400, 'BAD_REQUEST');
    expect(JSON.stringify(response.body)).not.toContain('password_hash');
  });

  it('malformed JSON gets a plain 400 without the parser message', async () => {
    const response = await client().post('/api/v1/test-only/echo').set('Content-Type', 'application/json').send('{"broken": ');
    expectErrorEnvelope(response, 400, 'INVALID_JSON');
  });

  it('oversized JSON bodies get a 413', async () => {
    const response = await client()
      .post('/api/v1/test-only/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(150 * 1024) }));
    expectErrorEnvelope(response, 413, 'PAYLOAD_TOO_LARGE');
  });

  it('unknown routes get a 404 envelope', async () => {
    expectErrorEnvelope(await client().get('/api/v1/does-not-exist'), 404, 'NOT_FOUND');
  });

  it('valid JSON still works', async () => {
    const response = await client().post('/api/v1/test-only/echo').send({ hello: 'world' }).expect(201);
    expect(response.body).toEqual({ hello: 'world' });
  });
});
