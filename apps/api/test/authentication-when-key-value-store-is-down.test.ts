import { Redis } from 'ioredis';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../src/config/app-config.js';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { KEY_VALUE_STORE } from '../src/infrastructure/key-value-store/key-value-store.module.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertNoInternalDetails } from './support/internal-detail-patterns.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * The real Valkey connection, with a switch that makes every command fail the way a dead store does.
 * Lets one test sign in while the store is up, then see what still works once it goes down.
 */
function switchableKeyValueStore(config: AppConfig) {
  const realStore = new Redis(config.KEY_VALUE_STORE_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  const switchState = { isDown: false };
  const connectionRefused = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:56379'));
  const store = new Proxy(realStore, {
    get(target, property, receiver) {
      if (switchState.isDown && (property === 'eval' || property === 'ping' || property === 'del')) return connectionRefused;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store, switchState };
}

/**
 * Sign-in limits can't be enforced without the counter store, so sign-in refuses rather than allow
 * unlimited guessing. Refreshing a session keeps working: a refresh token is 256 random bits, so
 * there is nothing to guess, and refusing would sign every station out during a store outage.
 */
describe('authentication when the key-value store is down', () => {
  let testApplication: TestApplication;
  let switchState: { isDown: boolean };
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  const client = () => supertest(testApplication.application.getHttpServer());

  beforeAll(async () => {
    testApplication = await createTestApplication({
      overrideProviders: (builder) =>
        builder.overrideProvider(KEY_VALUE_STORE).useFactory({
          inject: [APP_CONFIG],
          factory: (config: AppConfig) => {
            const switchable = switchableKeyValueStore(config);
            switchState = switchable.switchState;
            return switchable.store;
          },
        }),
    });
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
  });
  afterAll(async () => {
    switchState.isDown = false;
    await testUsers.cleanUp();
    await setupClient.end();
    await testApplication.close();
  });

  it('sign-in answers 503 with a request id and no internals', async () => {
    switchState.isDown = true;
    const response = await client()
      .post('/api/v1/auth/sign-in')
      .set('Origin', PORTAL_ORIGIN)
      .send({ email: 'someone@example.test', password: 'a long enough password here' });
    switchState.isDown = false;

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.body.error.request_id).toBe(response.headers['x-request-id']);
    assertNoInternalDetails(response.body);
  });

  it('a signed-in person can still refresh their session, and use it', async () => {
    const user = await testUsers.create();
    const signIn = await client().post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).send({ email: user.email, password: user.password });
    expect(signIn.status).toBe(200);

    switchState.isDown = true;
    const refresh = await client().post('/api/v1/auth/refresh').set('Origin', PORTAL_ORIGIN).set('Cookie', cookieHeader(cookiesSetBy(signIn)));
    expect(refresh.status).toBe(204);
    const me = await client().get('/api/v1/auth/me').set('Origin', PORTAL_ORIGIN).set('Cookie', cookieHeader(cookiesSetBy(refresh)));
    switchState.isDown = false;

    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(user.email);
  });
});
