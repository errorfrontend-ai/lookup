import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY_VALUE_STORE } from '../src/infrastructure/key-value-store/key-value-store.module.js';
import { assertNoInternalDetails } from './support/internal-detail-patterns.js';
import { waitForLogWrites } from './support/log-capture.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

describe('health when the key-value store is down', () => {
  let testApplication: TestApplication;

  beforeAll(async () => {
    const connectionRefused = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:56379'));
    const unreachableKeyValueStore = {
      ping: connectionRefused,
      eval: connectionRefused, // the baseline rate limit allows requests through, so health still answers
      quit: () => Promise.resolve('OK'),
      disconnect: () => undefined,
    };
    testApplication = await createTestApplication({
      overrideProviders: (builder) => builder.overrideProvider(KEY_VALUE_STORE).useValue(unreachableKeyValueStore),
    });
  });
  afterAll(async () => testApplication.close());

  it('returns a generic 503 with a request id, and logs the real cause privately', async () => {
    const response = await supertest(testApplication.application.getHttpServer()).get('/api/v1/health').expect(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.body.error.request_id).toBe(response.headers['x-request-id']);
    assertNoInternalDetails(response.body);
    expect(JSON.stringify(response.body)).not.toContain('ECONNREFUSED');

    await waitForLogWrites();
    const logLine = testApplication.logs.find(
      (line) => line.requestId === response.body.error.request_id && line.code === 'SERVICE_UNAVAILABLE',
    );
    expect(logLine, 'private log line for this request').toBeDefined();
    expect(logLine?.detail).toContain('key_value_store=rejected');
    expect(JSON.stringify(logLine?.err)).toContain('stack');
  });
});
