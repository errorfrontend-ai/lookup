import { randomInt, randomUUID } from 'node:crypto';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeTwoFactorCode, decodeBase32, twoFactorTimeStepAt } from '@lookup/contracts';
import { createSuperAdmin } from '../scripts/create-super-admin.js';
import { loadDatabaseSetupConfig } from '../scripts/database-setup-config.js';
import { HUMAN_CHECK_DUMMY_TOKEN } from '../src/common/security/human-check.js';
import { APP_CONFIG, type AppConfig, loadAppConfig } from '../src/config/app-config.js';
import { EMAIL_SENDER, type EmailSender, type OutgoingEmail } from '../src/features/notifications/notification-senders.js';
import { KEY_VALUE_STORE } from '../src/infrastructure/key-value-store/key-value-store.module.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertNoInternalDetails } from './support/internal-detail-patterns.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN } from './support/portal-test-users.js';
import { switchableKeyValueStore } from './support/switchable-key-value-store.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

class RecordingEmailSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];
  async send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
  }
}

/**
 * Phase 5a's code checks when the counter store (Valkey) is down (P5A design §3.4; P5A-VERIFICATION-08,
 * P5A-ADMIN-ACCESS-10): their limits cannot be counted, so they refuse with 503 in the error envelope rather than
 * allow unlimited codes or guesses; no SMS code goes out and no authenticator code is checked.
 */
describe('phase 5a code checks when the key-value store is down', () => {
  let testApplication: TestApplication;
  let switchState: { isDown: boolean };
  let setupClient: pg.Client;
  const emails = new RecordingEmailSender();
  const createdStationIds: string[] = [];
  const createdUserIds: string[] = [];
  const server = () => testApplication.application.getHttpServer();
  const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

  beforeAll(async () => {
    const config: AppConfig = { ...loadAppConfig(), NOTIFICATION_SENDING_ENABLED: true, NOTIFICATION_RETRY_DELAY_MILLISECONDS: 20 };
    testApplication = await createTestApplication({
      overrideProviders: (builder) =>
        builder
          .overrideProvider(APP_CONFIG)
          .useValue(config)
          .overrideProvider(EMAIL_SENDER)
          .useValue(emails)
          .overrideProvider(KEY_VALUE_STORE)
          .useFactory({
            inject: [APP_CONFIG],
            factory: (appConfig: AppConfig) => {
              const switchable = switchableKeyValueStore(appConfig);
              switchState = switchable.switchState;
              return switchable.store;
            },
          }),
    });
    setupClient = databaseSetupClient();
    await setupClient.connect();
  });
  afterAll(async () => {
    switchState.isDown = false;
    await setupClient.query('DELETE FROM app.audit_events WHERE station_id = ANY($1) OR actor_portal_user_id = ANY($2)', [createdStationIds, createdUserIds]);
    await setupClient.query('DELETE FROM app.station_memberships WHERE station_id = ANY($1)', [createdStationIds]);
    await setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [createdStationIds]);
    await setupClient.query('DELETE FROM app.audit_events WHERE entity_id = ANY($1)', [createdUserIds]);
    await setupClient.query('DELETE FROM app.portal_users WHERE id = ANY($1)', [createdUserIds]);
    await setupClient.end();
    await testApplication.close();
  });

  it('P5A-VERIFICATION-08: sending and checking a code answer 503 in the error envelope, and no code is sent', async () => {
    const mobileNumber = `97${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
    const signedUp = await supertest(server())
      .post('/api/v1/registration/applicants')
      .set('Origin', PORTAL_ORIGIN)
      .set('X-Forwarded-For', newClientAddress())
      .send({ fullName: 'Chanda Mwila', email: `applicant.${randomUUID().slice(0, 8)}@example.com`, mobileNumber, password: `sunrise over the river ${randomUUID().slice(24)}`, humanCheckToken: HUMAN_CHECK_DUMMY_TOKEN })
      .expect(201);
    createdStationIds.push(signedUp.body.stationId as string);
    createdUserIds.push(signedUp.body.user.id as string);
    const cookie = cookieHeader(cookiesSetBy(signedUp));
    const smsSent = () => emails.sent.filter((email) => email.to === `260${mobileNumber}@sms.development.invalid`).length;
    const deadline = Date.now() + 10_000;
    while (smsSent() === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(smsSent()).toBe(1);

    switchState.isDown = true;
    const route = (path: string) =>
      supertest(server()).post(`/api/v1/stations/${signedUp.body.stationId}/application${path}`).set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookie);
    const send = await route('/phone-verification-codes');
    const check = await route('/phone-verification').send({ code: '123456' });
    switchState.isDown = false;

    for (const answer of [send, check]) {
      expect(answer.status).toBe(503);
      expect(answer.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', request_id: answer.headers['x-request-id'] });
      assertNoInternalDetails(answer.body);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(smsSent()).toBe(1);
  });

  it('P5A-ADMIN-ACCESS-10: the super admin’s code check answers 503 in the error envelope, and the code is not checked', async () => {
    const password = `quiet river lantern ${randomUUID()}`;
    const email = `admin.${randomUUID().slice(0, 8)}@example.com`;
    const admin = await createSuperAdmin(loadDatabaseSetupConfig().setupUrl, { email, fullName: 'Platform Admin', password }, process.env.TWO_FACTOR_ENCRYPTION_SECRET as string);
    createdUserIds.push(admin.portalUserId);
    const signedIn = await supertest(server()).post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).send({ email, password }).expect(200);
    const code = await computeTwoFactorCode(decodeBase32(admin.secretBase32) as Uint8Array, twoFactorTimeStepAt(Date.now()));

    switchState.isDown = true;
    const answer = await supertest(server())
      .post('/api/v1/auth/two-factor-code')
      .set('Origin', PORTAL_ORIGIN)
      .set('X-Forwarded-For', newClientAddress())
      .set('Cookie', cookieHeader(cookiesSetBy(signedIn)))
      .send({ code });
    switchState.isDown = false;

    expect(answer.status).toBe(503);
    expect(answer.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', request_id: answer.headers['x-request-id'] });
    assertNoInternalDetails(answer.body);
    const stored = await setupClient.query('SELECT two_factor_last_used_time_step FROM app.portal_users WHERE id = $1', [admin.portalUserId]);
    expect(stored.rows[0].two_factor_last_used_time_step).toBeNull();
    const attempts = await setupClient.query(`SELECT count(*)::int AS count FROM app.audit_events WHERE actor_portal_user_id = $1 AND action LIKE 'two_factor_%'`, [admin.portalUserId]);
    expect(attempts.rows[0].count).toBe(0);
  });
});
