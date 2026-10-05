import { randomInt, randomUUID } from 'node:crypto';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertNoInternalDetails } from './support/internal-detail-patterns.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

describe('station access, the station profile and clients', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  const client = () => supertest(testApplication.application.getHttpServer());
  const sessions = new Map<string, Record<string, string>>();

  beforeAll(async () => {
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
  });
  afterAll(async () => {
    await testUsers.cleanUp();
    await setupClient.end();
    await testApplication.close();
  });

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

  // Sign in first, then build the request: building a supertest request starts the test server, and
  // starting a second request (the sign-in) while the first is only half built makes them interfere.
  const get = async (user: PortalTestUser, path: string) => {
    const cookies = await cookiesFor(user);
    return client().get(path).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookieHeader(cookies));
  };
  const post = async (user: PortalTestUser, path: string, body: object) => {
    const cookies = await cookiesFor(user);
    return client()
      .post(path)
      .set('Origin', PORTAL_ORIGIN)
      .set('X-Forwarded-For', newClientAddress())
      .set('Cookie', cookieHeader(cookies))
      .send(body);
  };

  /** Fails with the response body in the message, which makes a wrong status easy to diagnose. */
  function expectStatus(response: supertest.Response, httpStatus: number): supertest.Response {
    expect(response.status, JSON.stringify(response.body)).toBe(httpStatus);
    return response;
  }

  describe('who can reach a station', () => {
    it('a member reads the station profile, with their role', async () => {
      const owner = await testUsers.create();
      const response = expectStatus(await get(owner, `/api/v1/stations/${owner.stationId}`), 200);
      expect(response.body).toEqual({
        id: owner.stationId,
        name: expect.stringMatching(/^Test Station /),
        frequencyLabel: '98.1 FM',
        province: null,
        city: null,
        timeZone: 'Africa/Lusaka',
        status: 'ACTIVE',
        isListedInApp: true,
        yourRole: 'OWNER',
      });
    });

    it("another station's id answers 404, exactly like a station that does not exist or an id that is not a UUID", async () => {
      const owner = await testUsers.create();
      const otherOwner = await testUsers.create();
      const answers = [
        await get(owner, `/api/v1/stations/${otherOwner.stationId}`),
        await get(owner, `/api/v1/stations/${otherOwner.stationId}/clients`),
        await get(owner, `/api/v1/stations/${randomUUID()}`),
        await get(owner, '/api/v1/stations/not-a-uuid/clients'),
      ];
      for (const answer of answers) {
        expect(answer.status).toBe(404);
        expect({ ...answer.body.error, request_id: undefined }).toEqual({ code: 'NOT_FOUND', message: 'Not found.', request_id: undefined });
      }
    });

    it('without signing in, station routes answer 401', async () => {
      const owner = await testUsers.create();
      const response = await client().get(`/api/v1/stations/${owner.stationId}/clients`).expect(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('a station under review can read its profile but not its content yet', async () => {
      const owner = await testUsers.create({ stationStatus: 'PENDING_REVIEW' });
      expect(expectStatus(await get(owner, `/api/v1/stations/${owner.stationId}`), 200).body.status).toBe('PENDING_REVIEW');
      const clients = await get(owner, `/api/v1/stations/${owner.stationId}/clients`);
      expect(clients.status).toBe(403);
      expect(clients.body.error.code).toBe('STATION_NOT_ACTIVE');
    });

    it('a suspended station loses access to its content at once', async () => {
      const owner = await testUsers.create();
      expectStatus(await get(owner, `/api/v1/stations/${owner.stationId}/clients`), 200);
      await setupClient.query(`UPDATE app.stations SET status = 'SUSPENDED' WHERE id = $1`, [owner.stationId]);
      expect((await get(owner, `/api/v1/stations/${owner.stationId}/clients`)).status).toBe(403);
    });
  });

  describe('clients', () => {
    it('lists alphabetically, ignoring case', async () => {
      const owner = await testUsers.create();
      for (const name of ['zebra Foods', 'Apex Motors', 'banda Hardware']) {
        expectStatus(await post(owner, `/api/v1/stations/${owner.stationId}/clients`, { name }), 201);
      }
      const listed = expectStatus(await get(owner, `/api/v1/stations/${owner.stationId}/clients`), 200);
      expect(listed.body.map((client: { name: string }) => client.name)).toEqual(['Apex Motors', 'banda Hardware', 'zebra Foods']);
    });

    it('creating a client is audited with who, which station and the request id', async () => {
      const owner = await testUsers.create();
      const created = expectStatus(await post(owner, `/api/v1/stations/${owner.stationId}/clients`, { name: '  Brand A  ' }), 201);
      expect(created.body).toEqual({ id: expect.any(String), name: 'Brand A' });
      const audit = (
        await setupClient.query(
          'SELECT station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id FROM app.audit_events WHERE entity_id = $1',
          [created.body.id],
        )
      ).rows;
      expect(audit).toEqual([
        {
          station_id: owner.stationId,
          actor_portal_user_id: owner.userId,
          action: 'client_created',
          entity_type: 'client',
          entity_id: created.body.id,
          changes: { name: 'Brand A' },
          request_id: created.headers['x-request-id'],
        },
      ]);
    });

    it('a duplicate name is refused with a plain message', async () => {
      const owner = await testUsers.create();
      expectStatus(await post(owner, `/api/v1/stations/${owner.stationId}/clients`, { name: 'Brand B' }), 201);
      const duplicate = await post(owner, `/api/v1/stations/${owner.stationId}/clients`, { name: 'Brand B' });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.message).toBe('This station already has a client with that name.');
      assertNoInternalDetails(duplicate.body);
    });

    it('two stations may each have a client with the same name', async () => {
      const firstOwner = await testUsers.create();
      const secondOwner = await testUsers.create();
      expectStatus(await post(firstOwner, `/api/v1/stations/${firstOwner.stationId}/clients`, { name: 'Shared Name' }), 201);
      expectStatus(await post(secondOwner, `/api/v1/stations/${secondOwner.stationId}/clients`, { name: 'Shared Name' }), 201);
    });

    it('names must be 1 to 80 characters, and unknown fields are refused', async () => {
      const owner = await testUsers.create();
      for (const [body, expectedFields] of [
        [{ name: '   ' }, [{ path: 'name', code: 'too_small' }]],
        [{ name: 'x'.repeat(81) }, [{ path: 'name', code: 'too_big' }]],
        [{ name: 'Fine', station_id: randomUUID() }, [{ path: '', code: 'unrecognized_keys' }]],
      ] as const) {
        const refused = await post(owner, `/api/v1/stations/${owner.stationId}/clients`, body);
        expect(refused.status).toBe(400);
        expect(refused.body.error.fields).toEqual(expectedFields);
      }
    });

    it('an analyst can list clients but not create them', async () => {
      const owner = await testUsers.create();
      const analyst = await testUsers.create({ joinStationId: owner.stationId, role: 'ANALYST' });
      expectStatus(await get(analyst, `/api/v1/stations/${owner.stationId}/clients`), 200);
      const refused = await post(analyst, `/api/v1/stations/${owner.stationId}/clients`, { name: 'Not Allowed' });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
    });

    it("a member of another station can neither list nor add this station's clients", async () => {
      const owner = await testUsers.create();
      const otherOwner = await testUsers.create();
      expectStatus(await post(owner, `/api/v1/stations/${owner.stationId}/clients`, { name: 'Private Client' }), 201);
      expect((await get(otherOwner, `/api/v1/stations/${owner.stationId}/clients`)).status).toBe(404);
      expect((await post(otherOwner, `/api/v1/stations/${owner.stationId}/clients`, { name: 'Intruder' })).status).toBe(404);
    });
  });
});
