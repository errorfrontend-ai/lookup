import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { databaseSetupClient } from './support/database-clients.js';
import { randomClientAddress } from './support/listener-test-kit.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/** Low, so one address and one install use them up quickly (60 an hour and 5 a day in production). */
const REGISTRATIONS_PER_ADDRESS_PER_HOUR = 3;
const REREGISTRATIONS_PER_INSTALL_PER_DAY = 5;

/**
 * Registering again after an app update (A3, P4 design §5.7; P4-INSTALLS-01): a POST /api/v1/installs that carries the
 * install's own valid token is counted against that install, a few a day, not against the per-address limit, so many
 * phones behind one carrier address can all register again after a release. Anything else is a first registration.
 */
describe('POST /api/v1/installs, registering again', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  const installRows: string[] = [];
  const client = () => supertest(testApplication.application.getHttpServer());

  const register = (address: string, installId: string, appVersion: string, installToken?: string) => {
    let request = client().post('/api/v1/installs').set('X-Forwarded-For', address);
    if (installToken) request = request.set('Authorization', `Bearer ${installToken}`);
    return request.send({ install_id: installId, platform: 'ANDROID', app_version: appVersion });
  };

  /** A phone registered from its own address; its token and row. */
  async function registeredPhone() {
    const installId = randomUUID();
    const response = await register(randomClientAddress(), installId, '1.0.0');
    expect(response.status).toBe(200);
    const hash = testApplication.application.get(InstallTokens).hashInstallId(installId);
    const rowId = (await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash])).rows[0].id as string;
    installRows.push(rowId);
    return { installId, installToken: response.body.install_token as string, rowId };
  }

  /** Uses up an address's first registrations with new install ids. */
  async function useUpAddress(address: string) {
    for (let registered = 0; registered < REGISTRATIONS_PER_ADDRESS_PER_HOUR; registered += 1) {
      const installId = randomUUID();
      expect((await register(address, installId, '1.0.0')).status).toBe(200);
      const hash = testApplication.application.get(InstallTokens).hashInstallId(installId);
      installRows.push((await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash])).rows[0].id as string);
    }
    expect((await register(address, randomUUID(), '1.0.0')).status).toBe(429);
  }

  beforeAll(async () => {
    const config = {
      ...loadAppConfig(),
      LISTENER_REGISTRATIONS_PER_CLIENT_ADDRESS_PER_HOUR: REGISTRATIONS_PER_ADDRESS_PER_HOUR,
      LISTENER_REREGISTRATIONS_PER_INSTALL_PER_DAY: REREGISTRATIONS_PER_INSTALL_PER_DAY,
    };
    testApplication = await createTestApplication({ overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config) });
    setupClient = databaseSetupClient();
    await setupClient.connect();
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRows]);
    await setupClient.end();
    await testApplication.close();
  });

  it('A3: with the address’s registrations used up, a phone carrying its own valid token registers again; the same request without the token gets 429', async () => {
    const phone = await registeredPhone();
    const carrierAddress = randomClientAddress();
    await useUpAddress(carrierAddress);

    const again = await register(carrierAddress, phone.installId, '1.1.0', phone.installToken);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toEqual({ install_token: expect.any(String), expires_at: expect.any(String) });
    // The same install, now recorded with the new version.
    expect((await setupClient.query('SELECT app_version FROM app.listener_installs WHERE id = $1', [phone.rowId])).rows[0].app_version).toBe('1.1.0');

    const withoutToken = await register(carrierAddress, phone.installId, '1.1.0');
    expect(withoutToken.status).toBe(429);
    expect(withoutToken.body.error.code).toBe('RATE_LIMITED');
  });

  it('A3: an install’s sixth re-registration in a day gets 429, while other phones behind the same address still register again', async () => {
    const phone = await registeredPhone();
    const neighbour = await registeredPhone();
    const carrierAddress = randomClientAddress();
    for (let update = 1; update <= REREGISTRATIONS_PER_INSTALL_PER_DAY; update += 1) {
      expect((await register(carrierAddress, phone.installId, `1.0.${update}`, phone.installToken)).status).toBe(200);
    }
    const sixth = await register(carrierAddress, phone.installId, '1.0.9', phone.installToken);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('RATE_LIMITED');
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    expect((await register(carrierAddress, neighbour.installId, '1.0.1', neighbour.installToken)).status).toBe(200);
  });

  it('A3: a token of another install, a bad token or a token of a blocked install is treated as no token, a first registration counted per address', async () => {
    const phone = await registeredPhone();
    const other = await registeredPhone();
    const blocked = await registeredPhone();
    await setupClient.query(`UPDATE app.listener_installs SET status = 'BLOCKED' WHERE id = $1`, [blocked.rowId]);
    const carrierAddress = randomClientAddress();
    await useUpAddress(carrierAddress);
    for (const token of [other.installToken, `${phone.installToken.slice(0, -2)}xx`, 'not-a-token']) {
      const response = await register(carrierAddress, phone.installId, '1.2.0', token);
      expect(response.status, token.slice(0, 12)).toBe(429);
    }
    // A blocked install carrying its own token is no re-registration either.
    expect((await register(carrierAddress, blocked.installId, '1.2.0', blocked.installToken)).status).toBe(429);
    // The header is never required: from a fresh address, the same request without it is a plain first registration.
    expect((await register(randomClientAddress(), phone.installId, '1.2.0')).status).toBe(200);
  });
});
