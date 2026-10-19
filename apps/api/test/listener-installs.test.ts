import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidVersion7 } from '../src/common/identifiers/uuid-version-7.js';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { PUBLIC_ROUTE_METADATA } from '../src/features/authentication/public-route.decorator.js';
import { databaseSetupClient } from './support/database-clients.js';
import { recognize } from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * POST /api/v1/installs: anonymous registration of a listener app install. This file runs with low
 * per-address limits (portal 10 a minute, listener routes 60 a minute, registrations 20 an hour) to
 * test them quickly.
 */
describe('listener app installs', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  const client = () => supertest(testApplication.application.getHttpServer());
  const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  const register = (body: object, clientAddress = newClientAddress()) =>
    client().post('/api/v1/installs').set('X-Forwarded-For', clientAddress).send(body);
  const registeredHashes: Buffer[] = [];
  const installBody = (changes: object = {}) => ({ install_id: randomUUID(), platform: 'ANDROID', app_version: '1.0.0', ...changes });
  const hashOf = (installId: string) => testApplication.application.get(InstallTokens).hashInstallId(installId);
  const rowFor = async (installId: string) => {
    registeredHashes.push(hashOf(installId));
    return (await setupClient.query('SELECT * FROM app.listener_installs WHERE install_id_hash = $1', [hashOf(installId)])).rows as Array<Record<string, unknown>>;
  };

  beforeAll(async () => {
    process.env.RATE_LIMIT_REQUESTS_PER_MINUTE = '10';
    process.env.LISTENER_REQUESTS_PER_CLIENT_ADDRESS_PER_MINUTE = '60';
    process.env.LISTENER_REGISTRATIONS_PER_CLIENT_ADDRESS_PER_HOUR = '20';
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.listener_installs WHERE install_id_hash = ANY($1)', [registeredHashes]);
    await setupClient.end();
    await testApplication.close();
  });

  it('registers with no sign-in, cookie or token, and gives a token the recognize route accepts', async () => {
    const body = installBody();
    const response = await register(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ install_token: expect.any(String), expires_at: expect.any(String) });
    expect(response.headers['set-cookie']).toBeUndefined();
    const expiresInDays = (new Date(response.body.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(expiresInDays).toBeGreaterThan(29.9);
    expect(expiresInDays).toBeLessThanOrEqual(30);

    // Accepted: the request goes past the token check (to the fields), it is not refused as 401.
    const accepted = await recognize(client, { installToken: response.body.install_token, fields: { codec: 'not-a-codec' } });
    expect(accepted.status).toBe(400);
    await rowFor(body.install_id);
  });

  it('stores only a keyed hash of the install id, with the platform and the app version, and no verdict', async () => {
    const body = installBody({ platform: 'IOS', app_version: '2.3.1+45' });
    await register(body);
    const rows = await rowFor(body.install_id);
    expect(rows).toHaveLength(1);
    const pepper = Buffer.from(process.env.LISTENER_INSTALL_ID_PEPPER as string, 'base64url');
    expect(rows[0]?.install_id_hash).toEqual(createHmac('sha256', pepper).update(body.install_id).digest());
    expect(rows[0]).toMatchObject({ platform: 'IOS', app_version: '2.3.1+45', status: 'ACTIVE', integrity_verdict: null });
    expect(JSON.stringify(rows[0])).not.toContain(body.install_id);
    await waitForLogWrites();
    expect(JSON.stringify(testApplication.logs.lines)).not.toContain(body.install_id);
  });

  it('registering the same install again keeps one row, never fails, and updates the app version', async () => {
    const body = installBody();
    const first = await register(body);
    const second = await register({ ...body, app_version: '1.1.0' });
    expect([first.status, second.status]).toEqual([200, 200]);
    const rows = await rowFor(body.install_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.app_version).toBe('1.1.0');
  });

  it('refuses a platform other than ANDROID or IOS, an install id that is not a UUID, and unknown fields', async () => {
    for (const changes of [{ platform: 'WINDOWS' }, { platform: 'android' }, { install_id: 'phone-123' }, { app_version: '' }, { push_token: 'x' }]) {
      const response = await register(installBody(changes));
      expect(response.status, JSON.stringify(changes)).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('the database refuses a platform it does not know, whoever writes it', async () => {
    await expect(
      setupClient.query(`INSERT INTO app.listener_installs (install_id_hash, platform, app_version) VALUES ($1, 'WINDOWS', '1.0.0')`, [hashOf(randomUUID())]),
    ).rejects.toThrow(/listener_installs_platform_check/);
  });

  it('a blocked install cannot register again', async () => {
    const body = installBody();
    await register(body);
    await setupClient.query(`UPDATE app.listener_installs SET status = 'BLOCKED' WHERE install_id_hash = $1`, [hashOf(body.install_id)]);
    const response = await register(body);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    await rowFor(body.install_id);
  });

  it('works for a phone without Google Play: no integrity verdict is needed', async () => {
    const body = installBody();
    const response = await register(body);
    expect(response.status).toBe(200);
    expect((await rowFor(body.install_id))[0]?.integrity_verdict).toBeNull();
  });

  it('registrations are limited per address, strictly: installs cost nothing to make', async () => {
    const address = newClientAddress();
    for (let registration = 0; registration < 20; registration += 1) {
      const body = installBody();
      expect((await register(body, address)).status).toBe(200);
      registeredHashes.push(hashOf(body.install_id));
    }
    const refused = await register(installBody(), address);
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    const elsewhere = installBody();
    expect((await register(elsewhere)).status).toBe(200);
    await rowFor(elsewhere.install_id);
  });

  it('the listener routes have their own per-address ceiling, above the portal’s: many listeners share one mobile-network address', async () => {
    const sharedAddress = newClientAddress();
    // The portal's baseline here is 10 a minute; the listener ceiling is 60, shared by every listener route.
    const listenerRequests = [
      () => client().post('/api/v1/recognize'),
      () => client().post(`/api/v1/recognitions/${uuidVersion7()}/choice`).send({ station_id: randomUUID() }),
      () => client().get('/api/v1/stations'),
    ];
    for (let request = 0; request < 15; request += 1) {
      const send = listenerRequests[request % listenerRequests.length] as (typeof listenerRequests)[number];
      const response = await send().set('X-Forwarded-For', sharedAddress).set('Authorization', 'Bearer not-a-token');
      expect(response.status).toBe(401);
    }
    for (let request = 0; request < 10; request += 1) await client().get('/api/v1/auth/me').set('X-Forwarded-For', sharedAddress);
    expect((await client().get('/api/v1/auth/me').set('X-Forwarded-For', sharedAddress)).status).toBe(429);
    let lastStatus = 0;
    for (let request = 0; request < 46; request += 1) {
      lastStatus = (await client().post('/api/v1/recognize').set('X-Forwarded-For', sharedAddress).set('Authorization', 'Bearer not-a-token')).status;
    }
    expect(lastStatus).toBe(429);
  });

  it('only health, sign-in, refresh, sign-out, station sign-up and its email link, an invitation link, client errors and the listener app’s routes (installs, recognize, a station choice, a button tap, a report, a withheld result, the listener account, the station list) are open without signing in, and none lists ads', async () => {
    const discovery = testApplication.application.get(DiscoveryService);
    const scanner = new MetadataScanner();
    const openRoutes: string[] = [];
    for (const wrapper of discovery.getControllers()) {
      const controller = wrapper.metatype as (new (...arguments_: never[]) => unknown) | undefined;
      if (!controller) continue;
      const controllerPath = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
      const isControllerOpen = Reflect.getMetadata(PUBLIC_ROUTE_METADATA, controller) === true;
      for (const methodName of scanner.getAllMethodNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[methodName] as object;
        const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (requestMethod === undefined) continue;
        if (!isControllerOpen && Reflect.getMetadata(PUBLIC_ROUTE_METADATA, handler) !== true) continue;
        const methodPath = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
        openRoutes.push(`/${[controllerPath, methodPath].filter((part) => part && part !== '/').join('/')}`.replace(/\/+/g, '/'));
      }
    }
    expect(openRoutes.sort()).toEqual([
      '/auth/refresh',
      '/auth/sign-in',
      '/auth/sign-out',
      '/client-errors',
      '/engagements',
      '/health',
      '/installs',
      '/invitations/acceptance-with-new-account',
      '/invitations/description',
      // Listener accounts (ADR-005): POST creates, GET describes, DELETE erases; each is for an install token alone.
      '/listener-account',
      '/listener-account',
      '/listener-account',
      '/listener-account/code',
      '/listener-account/sign-out',
      '/listener-account/verify',
      '/recognitions/:recognitionId',
      '/recognitions/:recognitionId/choice',
      '/recognitions/:recognitionId/report',
      '/recognize',
      '/registration/applicants',
      '/registration/email-verifications',
      '/stations',
    ]);
  });
});
