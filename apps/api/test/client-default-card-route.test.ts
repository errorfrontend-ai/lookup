import { randomInt, randomUUID } from 'node:crypto';
import type pg from 'pg';
import supertest from 'supertest';
import { QueryFailedError } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { ClientsService } from '../src/features/clients/clients.service.js';
import { RecognizeQueue } from '../src/infrastructure/job-queues/recognize-queue.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { FakeRecognizeWorker, match, recognize, registerInstall } from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { StationResolutionTestData } from './support/station-resolution-test-data.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

/**
 * PUT /api/v1/stations/{stationId}/clients/{clientId}/default-action-card (P4 design §5.10; P4-FALLBACK-04, -05):
 * a client's usual card, which a listener gets when the ad is heard out of its slots. Owners and managers set or
 * clear it, only to one of that client's saved card versions, and every change is in the audit trail.
 */
describe('a client’s usual card', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  let testData: StationResolutionTestData;
  let worker: FakeRecognizeWorker;
  const installRows: string[] = [];
  const sessions = new Map<string, Record<string, string>>();
  const client = () => supertest(testApplication.application.getHttpServer());
  const pathOf = (stationId: string, clientId: string) => `/api/v1/stations/${stationId}/clients/${clientId}/default-action-card`;

  async function cookiesFor(user: PortalTestUser): Promise<Record<string, string>> {
    const existing = sessions.get(user.userId);
    if (existing) return existing;
    const response = await client()
      .post('/api/v1/auth/sign-in')
      .set('Origin', PORTAL_ORIGIN)
      .set('X-Forwarded-For', newClientAddress())
      .send({ email: user.email, password: user.password })
      .expect(200);
    const cookies = cookiesSetBy(response);
    sessions.set(user.userId, cookies);
    return cookies;
  }
  const put = async (user: PortalTestUser, path: string, body: unknown, origin = PORTAL_ORIGIN) => {
    const cookies = await cookiesFor(user);
    return client().put(path).set('Origin', origin).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookieHeader(cookies)).send(body as object);
  };

  /** A station owned by a new portal user, airing an ad whose campaign ended last week: out of its slots now. */
  async function stationWithAnAdOffAir() {
    const owner = await testUsers.create();
    const recording = await testData.createRecording();
    const weekAgo = (weeks: number) => new Date(Date.now() - weeks * 7 * 86_400_000).toISOString();
    const airing = await testData.airAd({ recording, stationId: owner.stationId, clientName: 'Brand A', period: [weekAgo(2), weekAgo(1)] });
    const usualCard = await testData.createCard(owner.stationId, airing.clientId);
    return { owner, recording, airing, usualCard };
  }
  const storedDefault = async (clientId: string) =>
    (await setupClient.query('SELECT default_action_card_id FROM app.clients WHERE id = $1', [clientId])).rows[0].default_action_card_id as string | null;
  const auditRows = async (clientId: string) =>
    (
      await setupClient.query(
        `SELECT station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id FROM app.audit_events
          WHERE entity_id = $1 AND action = 'client_default_card_changed' ORDER BY occurred_at, id`,
        [clientId],
      )
    ).rows;

  async function identify(assetNumber: number) {
    worker.answer = () => match(assetNumber);
    const install = await registerInstall(client);
    const hash = testApplication.application.get(InstallTokens).hashInstallId(install.installId);
    installRows.push((await setupClient.query('SELECT id FROM app.listener_installs WHERE install_id_hash = $1', [hash])).rows[0].id as string);
    return recognize(client, { installToken: install.installToken });
  }

  beforeAll(async () => {
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
    testData = new StationResolutionTestData(setupClient);
    worker = new FakeRecognizeWorker(process.env.KEY_VALUE_STORE_URL as string, process.env.QUEUE_KEY_PREFIX as string);
    await worker.startHeartbeat();
    await testApplication.application.get(RecognizeQueue).refreshAdmission();
  });
  afterAll(async () => {
    await worker.close();
    await setupClient.query(`DELETE FROM app.recognition_candidates WHERE recognition_id IN (SELECT id FROM app.recognition_events WHERE listener_install_id = ANY($1))`, [installRows]);
    await setupClient.query('DELETE FROM app.recognition_idempotency_keys WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1)', [installRows]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installRows]);
    await testUsers.cleanUp();
    await testData.removeAll();
    await setupClient.end();
    await testApplication.close();
  });

  it('P4-FALLBACK-04: setting it stores the reference, and a clip heard out of the ad’s slots gets that card', async () => {
    const { owner, recording, airing, usualCard } = await stationWithAnAdOffAir();
    expect((await identify(recording.assetNumber)).body.status).toBe('NO_MATCH');

    const response = await put(owner, pathOf(owner.stationId, airing.clientId), { actionCardId: usualCard.cardId });
    expect(response.status, JSON.stringify(response.body)).toBe(204);
    expect(response.text).toBe('');
    expect(await storedDefault(airing.clientId)).toBe(usualCard.cardId);

    const recognised = await identify(recording.assetNumber);
    expect(recognised.body).toMatchObject({ status: 'MATCH', result: { kind: 'CLIENT_DEFAULT', station: { id: owner.stationId }, card: { actions: usualCard.content.actions } } });
  });

  it('P4-FALLBACK-05: every change is audited with the previous and the new card ids, never a card’s content; clearing takes the card away', async () => {
    const { owner, recording, airing, usualCard } = await stationWithAnAdOffAir();
    const set = await put(owner, pathOf(owner.stationId, airing.clientId), { actionCardId: usualCard.cardId });
    expect(set.status).toBe(204);
    // The same card again changes and records nothing.
    expect((await put(owner, pathOf(owner.stationId, airing.clientId), { actionCardId: usualCard.cardId.toUpperCase() })).status).toBe(204);
    const cleared = await put(owner, pathOf(owner.stationId, airing.clientId), { actionCardId: null });
    expect(cleared.status).toBe(204);
    expect(await storedDefault(airing.clientId)).toBeNull();
    expect((await identify(recording.assetNumber)).body.status).toBe('NO_MATCH');

    const audit = await auditRows(airing.clientId);
    const entry = (requestId: string, changes: object) => ({
      station_id: owner.stationId,
      actor_portal_user_id: owner.userId,
      action: 'client_default_card_changed',
      entity_type: 'client',
      entity_id: airing.clientId,
      changes,
      request_id: requestId,
    });
    expect(audit).toEqual([
      entry(set.headers['x-request-id'] as string, { previousActionCardId: null, actionCardId: usualCard.cardId }),
      entry(cleared.headers['x-request-id'] as string, { previousActionCardId: usualCard.cardId, actionCardId: null }),
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/\+447700900|example\.com|Call us/);
  });

  it('refuses a card that is not one of this client’s versions: another client’s, another station’s, or none at all, and changes nothing', async () => {
    const { owner, airing, usualCard } = await stationWithAnAdOffAir();
    expect((await put(owner, pathOf(owner.stationId, airing.clientId), { actionCardId: usualCard.cardId })).status).toBe(204);
    const otherClientId = await testData.createClient(owner.stationId, 'Brand B');
    const otherClientsCard = await testData.createCard(owner.stationId, otherClientId);
    const elsewhere = await stationWithAnAdOffAir();

    for (const actionCardId of [otherClientsCard.cardId, elsewhere.usualCard.cardId, randomUUID()]) {
      const refused = await put(owner, pathOf(owner.stationId, airing.clientId), { actionCardId });
      expect(refused.status).toBe(400);
      expect(assertErrorEnvelope(refused.body).error).toMatchObject({ code: 'VALIDATION_FAILED', fields: [{ path: 'actionCardId', code: 'card_not_of_this_client' }] });
    }
    expect(await storedDefault(airing.clientId)).toBe(usualCard.cardId);
    expect(await auditRows(airing.clientId)).toHaveLength(1);
  });

  it('only owners and managers may set it: an analyst gets 403 and nothing changes', async () => {
    const { owner, airing, usualCard } = await stationWithAnAdOffAir();
    const manager = await testUsers.create({ joinStationId: owner.stationId, role: 'MANAGER' });
    const analyst = await testUsers.create({ joinStationId: owner.stationId, role: 'ANALYST' });
    const refused = await put(analyst, pathOf(owner.stationId, airing.clientId), { actionCardId: usualCard.cardId });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('FORBIDDEN');
    expect(await storedDefault(airing.clientId)).toBeNull();
    expect((await put(manager, pathOf(owner.stationId, airing.clientId), { actionCardId: usualCard.cardId })).status).toBe(204);
    expect(await storedDefault(airing.clientId)).toBe(usualCard.cardId);
  });

  it('another station’s client is not found: through its own station, through this one, or by an id that is not one', async () => {
    const mine = await stationWithAnAdOffAir();
    const theirs = await stationWithAnAdOffAir();
    // A member of another station, on this station's path.
    expect((await put(theirs.owner, pathOf(mine.owner.stationId, mine.airing.clientId), { actionCardId: null })).status).toBe(404);
    // This station's path with another station's client.
    expect((await put(mine.owner, pathOf(mine.owner.stationId, theirs.airing.clientId), { actionCardId: null })).status).toBe(404);
    expect((await put(mine.owner, pathOf(mine.owner.stationId, 'not-a-client'), { actionCardId: null })).status).toBe(404);
    expect(await storedDefault(theirs.airing.clientId)).toBeNull();
  });

  it('takes exactly { actionCardId: uuid | null }: anything else is refused, naming the field', async () => {
    const { owner, airing } = await stationWithAnAdOffAir();
    for (const [body, field] of [
      [{ actionCardId: 'not-a-card' }, 'actionCardId'],
      [{}, 'actionCardId'],
      [{ actionCardId: null, clientId: airing.clientId }, ''],
    ] as const) {
      const refused = await put(owner, pathOf(owner.stationId, airing.clientId), body);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('VALIDATION_FAILED');
      expect(refused.body.error.fields).toContainEqual(expect.objectContaining({ path: field }));
    }
  });

  it('ALL-SECURITY-09: a cookie request from another site is refused before anything happens, and signing in is needed', async () => {
    const { owner, airing, usualCard } = await stationWithAnAdOffAir();
    const crossSite = await put(owner, pathOf(owner.stationId, airing.clientId), { actionCardId: usualCard.cardId }, 'https://elsewhere.example.com');
    expect(crossSite.status).toBe(403);
    const signedOut = await client().put(pathOf(owner.stationId, airing.clientId)).set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).send({ actionCardId: usualCard.cardId });
    expect(signedOut.status).toBe(401);
    expect(await storedDefault(airing.clientId)).toBeNull();
  });

  it('ALL-ERRORS-02 to -04: a database failure or a programming error underneath is a generic 500, with the stack in the log under the request id', async () => {
    const { owner, airing, usualCard } = await stationWithAnAdOffAir();
    const service = testApplication.application.get(ClientsService);
    const driverError = Object.assign(new Error('duplicate key value violates unique constraint "clients_primary_key"'), { code: '23505', severity: 'ERROR' });
    const failures = [
      new QueryFailedError('UPDATE app.clients SET default_action_card_id = $2 WHERE id = $1', [airing.clientId, usualCard.cardId], driverError),
      new TypeError("Cannot read properties of undefined (reading 'default_action_card_id')"),
    ];
    for (const failure of failures) {
      const spy = vi.spyOn(service, 'setDefaultActionCard').mockRejectedValueOnce(failure);
      try {
        const response = await put(owner, pathOf(owner.stationId, airing.clientId), { actionCardId: usualCard.cardId });
        expect(response.status).toBe(500);
        expect(assertErrorEnvelope(response.body).error).toMatchObject({ code: 'INTERNAL', request_id: response.headers['x-request-id'] });
        await waitForLogWrites();
        const logLine = testApplication.logs.find((line) => line.requestId === response.headers['x-request-id'] && line.level === 50);
        expect((logLine?.err as { stack?: string } | undefined)?.stack, failure.name).toContain(failure.name);
      } finally {
        spy.mockRestore();
      }
    }
  });
});
