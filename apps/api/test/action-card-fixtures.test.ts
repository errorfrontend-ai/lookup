import { randomInt } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VALIDATION_REASON_CODES } from '@lookup/contracts';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const FIXTURES = resolve(import.meta.dirname, '..', '..', '..', 'packages', 'contracts', 'fixtures', 'action-card');

interface CardFixture {
  description: string;
  card: unknown;
  expected_issues?: Array<{ path: string; code: string }>;
}

function readFixtures(folder: 'valid' | 'invalid'): Array<[string, CardFixture]> {
  return readdirSync(resolve(FIXTURES, folder))
    .filter((fileName) => fileName.endsWith('.json'))
    .sort()
    .map((fileName) => [fileName.replace(/\.json$/, ''), JSON.parse(readFileSync(resolve(FIXTURES, folder, fileName), 'utf8')) as CardFixture]);
}

/** How the API reports a fixture's expected issue: custom rules by their reason when it is a known code. */
function asApiField(issue: { path: string; code: string }) {
  if (!issue.code.startsWith('custom:')) return issue;
  const reason = issue.code.slice('custom:'.length);
  return { path: issue.path, code: VALIDATION_REASON_CODES.has(reason) ? reason : 'custom' };
}

/**
 * S2-CARDS-23, S2-CARDS-22: the shared contract fixtures, the same ones the portal and the listener
 * app are tested with, sent through the real route. Every valid card is stored and comes back
 * unchanged; every invalid card is refused with exactly the fields and reasons the fixture expects.
 */
describe('action card fixtures through PUT …/card', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  let cardPath: string;
  let cookies: string;
  const client = () => supertest(testApplication.application.getHttpServer());
  const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  const putCard = (card: unknown) =>
    client().put(cardPath).set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookies).send(card as object);

  beforeAll(async () => {
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
    const owner = await testUsers.create();
    const signIn = await client().post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).send({ email: owner.email, password: owner.password });
    cookies = cookieHeader(cookiesSetBy(signIn));
    const stationPath = `/api/v1/stations/${owner.stationId}`;
    const send = (path: string, body: object) =>
      client().post(path).set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookies).send(body);
    const clientId = (await send(`${stationPath}/clients`, { name: 'Fixture brand' })).body.id as string;
    const created = await send(`${stationPath}/ads`, {
      clientId,
      title: 'Fixture ad',
      upload: { fileName: 'fixture.mp3', contentType: 'audio/mpeg', sizeBytes: 2048 },
    });
    cardPath = `${stationPath}/ads/${created.body.adId}/card`;
  });
  afterAll(async () => {
    await testUsers.cleanUp();
    await setupClient.end();
    await testApplication.close();
  });

  it.each(readFixtures('valid'))('stores %s and returns it unchanged', async (_name, fixture) => {
    const response = await putCard(fixture.card);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.actionCard).toEqual(fixture.card);
  });

  it.each(readFixtures('invalid'))('refuses %s with the expected fields and reasons', async (_name, fixture) => {
    const response = await putCard(fixture.card);
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    const envelope = assertErrorEnvelope(response.body);
    expect(envelope.error.code).toBe('VALIDATION_FAILED');
    expect(envelope.error.fields).toEqual((fixture.expected_issues ?? []).map(asApiField));
  });
});
