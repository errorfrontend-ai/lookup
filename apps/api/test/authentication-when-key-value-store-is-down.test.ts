import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY_VALUE_STORE } from '../src/infrastructure/key-value-store/key-value-store.module.js';
import { assertNoInternalDetails } from './support/internal-detail-patterns.js';
import { PORTAL_ORIGIN } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/** Without the counter store, sign-in limits can't be enforced, so sign-in refuses rather than allow unlimited guessing. */
describe('sign-in when the key-value store is down', () => {
  let testApplication: TestApplication;

  beforeAll(async () => {
    const connectionRefused = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:56379'));
    testApplication = await createTestApplication({
      overrideProviders: (builder) =>
        builder.overrideProvider(KEY_VALUE_STORE).useValue({
          ping: connectionRefused,
          eval: connectionRefused,
          del: connectionRefused,
          quit: () => Promise.resolve('OK'),
          disconnect: () => undefined,
        }),
    });
  });
  afterAll(async () => testApplication.close());

  it('answers 503 with a request id and no internals', async () => {
    const response = await supertest(testApplication.application.getHttpServer())
      .post('/api/v1/auth/sign-in')
      .set('Origin', PORTAL_ORIGIN)
      .send({ email: 'someone@example.test', password: 'a long enough password here' });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.body.error.request_id).toBe(response.headers['x-request-id']);
    assertNoInternalDetails(response.body);
  });
});
