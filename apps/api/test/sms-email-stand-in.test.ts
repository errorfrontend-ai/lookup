import { randomInt, randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HUMAN_CHECK_DUMMY_TOKEN } from '../src/common/security/human-check.js';
import { APP_CONFIG, loadAppConfig, type AppConfig } from '../src/config/app-config.js';
import { NotificationQueue } from '../src/features/notifications/notification-queue.js';
import { EMAIL_SENDER, type EmailSender, type OutgoingEmail, STAND_IN_SMS_SUBJECT } from '../src/features/notifications/notification-senders.js';
import { databaseSetupClient } from './support/database-clients.js';
import { waitForLogWrites } from './support/log-capture.js';
import { PORTAL_ORIGIN } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

class RecordingEmailSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];

  async send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
  }
}

/**
 * The showcase's SMS stand-in (SMS_SENDER=email-stand-in; the user's choice of 15 October 2026, until ADR-004's SMS
 * provider is chosen): every SMS is emailed, plainly marked, to the person it is for, and to nobody else.
 */
describe('SMS by email, the showcase stand-in', () => {
  let testApplication: TestApplication;
  let config: AppConfig;
  const emailSender = new RecordingEmailSender();
  const phone = '+447700900302';

  async function eventually<Result>(read: () => Result, isDone: (value: Result) => boolean, what: string): Promise<Result> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = read();
      if (isDone(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  beforeAll(async () => {
    config = { ...loadAppConfig(), SMS_SENDER: 'email-stand-in', NOTIFICATION_SENDING_ENABLED: true, NOTIFICATION_RETRY_DELAY_MILLISECONDS: 20 };
    testApplication = await createTestApplication({
      overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config).overrideProvider(EMAIL_SENDER).useValue(emailSender),
    });
  });
  afterAll(async () => testApplication.close());
  beforeEach(() => {
    emailSender.sent.length = 0;
  });

  it('production accepts the stand-in, as it accepts no sender at all', () => {
    const production = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://lookup_api:password@database.internal:5432/lookup',
      ADMIN_DATABASE_URL: 'postgresql://lookup_admin_api:password@database.internal:5432/lookup',
      KEY_VALUE_STORE_URL: 'redis://:password@key-value.internal:6379',
      AUTHENTICATION_SECRET: 'q4P1k5o8zXhN3wVt7RmYb2LcJ9sUeA6GdF0iHnKjTpW',
      TWO_FACTOR_ENCRYPTION_SECRET: 'Tf6Ns1Qb8Kw3Jx5Pm0Vr7Ld2Hc9Gz4Ya1Ue6Wo3XiRk',
      LISTENER_INSTALL_TOKEN_SECRET: 'Zr7m0Qx2Lk9VpT4cWb6NyH1jS8dGfA3uEoI5aMnRtYv',
      LISTENER_INSTALL_ID_PEPPER: 'Hb3Kq8Wz1Pn6Ty4Rc9Mv2Xs7Lj5Df0Ga1Ue8Io3YtNq',
      OBJECT_STORAGE_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      OBJECT_STORAGE_PUBLIC_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      OBJECT_STORAGE_ACCESS_KEY_ID: 'access-key-id',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret-access-key',
      OBJECT_STORAGE_AD_UPLOADS_BUCKET: 'lookup-ad-uploads',
      DATABASE_TLS_MODE: 'require',
      ALLOWED_BROWSER_ORIGINS: 'https://portal.example.com',
      PORTAL_PUBLIC_ORIGIN: 'https://portal.example.com',
      EMAIL_SMTP_URL: 'smtps://sender:password@smtp.example.com:465',
      EMAIL_FROM_ADDRESS: 'Look Up <no-reply@example.com>',
      HUMAN_CHECK_SECRET_KEY: '0x4AAAAAAAexampleSecretKeyForTheTests',
    };
    expect(loadAppConfig({ ...production, SMS_SENDER: 'email-stand-in' }).SMS_SENDER).toBe('email-stand-in');
    expect(() => loadAppConfig({ ...production, SMS_SENDER: 'development' })).toThrow('SMS_SENDER: must not be "development" in production');
  });

  it('emails an SMS, plainly marked, to the person it is for, and never to the development inbox', async () => {
    const queue = testApplication.application.get(NotificationQueue);
    await queue.enqueue('sms', phone, { template: 'phone_verification_code', code: '042817' }, randomUUID(), { smsStandInEmail: 'chanda@example.com' });
    const [delivered] = await eventually(() => emailSender.sent, (sent) => sent.length === 1, 'the stand-in email');
    expect(delivered).toEqual({
      to: 'chanda@example.com',
      subject: STAND_IN_SMS_SUBJECT,
      text: expect.stringContaining("Your Look Up code is 042817. It expires in 10 minutes. Don't share it."),
    });
    expect(delivered?.text).toMatch(/^Look Up sends this by email for now\. Later it will come as a text message to \+44 ••• ••02\./);
    expect(delivered?.text).not.toContain('447700900302');
  });

  it('an SMS with no email to go to is sent to nobody: it is tried, then given up, with the reason in the log', async () => {
    const queue = testApplication.application.get(NotificationQueue);
    const requestId = randomUUID();
    await queue.enqueue('sms', phone, { template: 'application_approved', stationName: 'Sunrise FM' }, requestId);
    await eventually(
      () => testApplication.logs.lines,
      (lines) => lines.some((line) => line.requestId === requestId && line.level === 50),
      'the give-up line',
    );
    await waitForLogWrites();
    expect(emailSender.sent).toEqual([]);
  });

  it('a sign-up’s code goes to the applicant’s own email', async () => {
    const setupClient = databaseSetupClient();
    await setupClient.connect();
    const mobileNumber = `97${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
    const signUpEmail = `stand.in.${randomUUID().slice(0, 8)}@example.com`;
    try {
      const signedUp = await supertest(testApplication.application.getHttpServer())
        .post('/api/v1/registration/applicants')
        .set('Origin', PORTAL_ORIGIN)
        .set('X-Forwarded-For', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
        .send({ fullName: 'Chanda Mwila', email: signUpEmail, mobileNumber, password: `sunrise over the river ${randomUUID().slice(24)}`, humanCheckToken: HUMAN_CHECK_DUMMY_TOKEN })
        .expect(201);
      const toApplicant = await eventually(
        () => emailSender.sent.filter((sent) => sent.to === signUpEmail),
        (sent) => sent.some((one) => one.subject === STAND_IN_SMS_SUBJECT),
        'the code by email',
      );
      expect(toApplicant.find((one) => one.subject === STAND_IN_SMS_SUBJECT)?.text).toMatch(/Your Look Up code is \d{6}\./);
      expect(emailSender.sent.some((sent) => sent.to.endsWith('@sms.development.invalid'))).toBe(false);
      const stationId = signedUp.body.stationId as string;
      await setupClient.query('DELETE FROM app.audit_events WHERE station_id = $1 OR actor_portal_user_id = $2', [stationId, signedUp.body.user.id]);
      await setupClient.query('DELETE FROM app.station_memberships WHERE station_id = $1', [stationId]);
      await setupClient.query('DELETE FROM app.stations WHERE id = $1', [stationId]);
      await setupClient.query('DELETE FROM app.portal_users WHERE id = $1', [signedUp.body.user.id]);
    } finally {
      await setupClient.end();
    }
  });
});
