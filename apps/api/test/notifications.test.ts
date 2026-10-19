import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HUMAN_CHECK_DUMMY_TOKEN } from '../src/common/security/human-check.js';
import { APP_CONFIG, loadAppConfig, type AppConfig } from '../src/config/app-config.js';
import { NotificationQueue, NOTIFY_QUEUE_NAME, type NotificationJobData } from '../src/features/notifications/notification-queue.js';
import { describeSendFailure, notifyWorkerHeartbeatKey } from '../src/features/notifications/notification-worker.js';
import { smsTextOf, type NotificationMessage } from '../src/features/notifications/notification-messages.js';
import { EMAIL_SENDER, type EmailSender, type OutgoingEmail } from '../src/features/notifications/notification-senders.js';
import { databaseSetupClient } from './support/database-clients.js';
import { PORTAL_ORIGIN } from './support/portal-test-users.js';
import { waitForLogWrites } from './support/log-capture.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * The notify queue and its in-process worker (P5A design §3.1, §3.6; P5A-D9, P5A-D10; P5A-NOTIFICATIONS-01, -04, -08,
 * -10), with the real Valkey and a recording email sender in place of SMTP: an SMS in development arrives as an email
 * to the development inbox; a failed send is tried again with growing waits, five times in all; a job past its
 * deadline is dropped; nothing of a recipient stays in Valkey or reaches the log.
 */
class RecordingEmailSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];
  failuresToCome = 0;
  /** While set, every send waits for it: a slow mail server. */
  gate: Promise<void> | null = null;

  async send(email: OutgoingEmail): Promise<void> {
    if (this.gate) await this.gate;
    if (this.failuresToCome > 0) {
      this.failuresToCome -= 1;
      throw Object.assign(new Error(`550 mailbox unavailable for ${email.to}`), { code: 'EENVELOPE', responseCode: 550 });
    }
    this.sent.push(email);
  }
}

describe('notifications', () => {
  let testApplication: TestApplication;
  let config: AppConfig;
  let keyValueStore: Redis;
  let rawQueue: Queue<NotificationJobData>;
  const emailSender = new RecordingEmailSender();
  const phone = '+447700900301';
  const email = `notified.${randomUUID().slice(0, 8)}@example.com`;

  async function eventually<Result>(read: () => Result | Promise<Result>, isDone: (value: Result) => boolean, what: string): Promise<Result> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (isDone(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const queuedJobCount = async () => Object.values(await rawQueue.getJobCounts()).reduce((total, count) => total + count, 0);

  beforeAll(async () => {
    config = { ...loadAppConfig(), NOTIFICATION_SENDING_ENABLED: true, NOTIFICATION_RETRY_DELAY_MILLISECONDS: 20 };
    testApplication = await createTestApplication({
      overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config).overrideProvider(EMAIL_SENDER).useValue(emailSender),
    });
    keyValueStore = new Redis(config.KEY_VALUE_STORE_URL, { maxRetriesPerRequest: 1 });
    rawQueue = new Queue<NotificationJobData>(NOTIFY_QUEUE_NAME, { connection: keyValueStore, prefix: config.QUEUE_KEY_PREFIX });
  });
  afterAll(async () => {
    await rawQueue.close();
    await keyValueStore.quit();
    await testApplication.close();
  });
  beforeEach(() => {
    emailSender.sent.length = 0;
    emailSender.failuresToCome = 0;
  });

  it('P5A-D10, P5A-NOTIFICATIONS-04: in development a phone code arrives as an email to the inbox, with the code and the WebOTP line', async () => {
    const queue = testApplication.application.get(NotificationQueue);
    await queue.enqueue('sms', phone, { template: 'phone_verification_code', code: '042817' }, randomUUID());
    const [delivered] = await eventually(() => emailSender.sent, (sent) => sent.length === 1, 'the SMS');
    expect(delivered).toEqual({
      to: '447700900301@sms.development.invalid',
      subject: 'SMS to +44 ••• ••01',
      text: `Your Look Up code is 042817. It expires in 10 minutes. Don't share it.\n\n@${new URL(config.PORTAL_PUBLIC_ORIGIN).host} #042817`,
    });
  });

  it('P5A-NOTIFICATIONS-03: a sign-up answers at once while its code waits on a slow mail server; the worker sends it afterwards', async () => {
    let openGate = () => undefined as void;
    emailSender.gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const setupClient = databaseSetupClient();
    await setupClient.connect();
    const mobileNumber = `97${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
    const signUpEmail = `queued.${randomUUID().slice(0, 8)}@example.com`;
    try {
      const signedUp = await supertest(testApplication.application.getHttpServer())
        .post('/api/v1/registration/applicants')
        .set('Origin', PORTAL_ORIGIN)
        .set('X-Forwarded-For', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
        .send({ fullName: 'Chanda Mwila', email: signUpEmail, mobileNumber, password: `sunrise over the river ${randomUUID().slice(24)}`, humanCheckToken: HUMAN_CHECK_DUMMY_TOKEN })
        .expect(201);
      // Answered while nothing has been sent: the code and the link wait in the queue.
      expect(emailSender.sent.filter((sent) => sent.to === `260${mobileNumber}@sms.development.invalid` || sent.to === signUpEmail)).toEqual([]);
      openGate();
      await eventually(() => emailSender.sent, (sent) => sent.some((one) => one.to === `260${mobileNumber}@sms.development.invalid`) && sent.some((one) => one.to === signUpEmail), 'the code and the link');
      const stationId = signedUp.body.stationId as string;
      await setupClient.query('DELETE FROM app.audit_events WHERE station_id = $1 OR actor_portal_user_id = $2', [stationId, signedUp.body.user.id]);
      await setupClient.query('DELETE FROM app.station_memberships WHERE station_id = $1', [stationId]);
      await setupClient.query('DELETE FROM app.stations WHERE id = $1', [stationId]);
      await setupClient.query('DELETE FROM app.portal_users WHERE id = $1', [signedUp.body.user.id]);
    } finally {
      openGate();
      emailSender.gate = null;
      await setupClient.end();
    }
  });

  it('P5A-NOTIFICATIONS-02, -06: every urgent message (the phone code, a review decision, a critical alert) has an SMS', () => {
    const urgent: NotificationMessage[] = [
      { template: 'phone_verification_code', code: '042817' },
      { template: 'application_approved', stationName: 'Sunrise FM' },
      { template: 'application_rejected', stationName: 'Sunrise FM', reason: 'Please send a clearer photo.' },
      { template: 'change_request_approved', stationName: 'Sunrise FM' },
      { template: 'change_request_rejected', stationName: 'Sunrise FM', reason: 'The name belongs to another station.' },
      { template: 'station_suspended', stationName: 'Sunrise FM', reason: 'Scam buttons.' },
      { template: 'station_reactivated', stationName: 'Sunrise FM' },
    ];
    for (const message of urgent) expect(smsTextOf(message, 'http://localhost:5180'), message.template).toMatch(/^(Your Look Up code|Look Up: )/);
  });

  it('an email link is a plain-text email whose link carries the token in its fragment', async () => {
    const queue = testApplication.application.get(NotificationQueue);
    const linkToken = randomBytes(32).toString('base64url');
    await queue.enqueue('email', email, { template: 'email_verification_link', linkToken, fullName: 'Applicant Person' }, randomUUID());
    const [delivered] = await eventually(() => emailSender.sent, (sent) => sent.length === 1, 'the email');
    expect(delivered?.to).toBe(email);
    expect(delivered?.subject).toBe('Confirm your email for Look Up');
    expect(delivered?.text).toContain(`${config.PORTAL_PUBLIC_ORIGIN}/verify-email#token=${linkToken}`);
    expect(delivered?.text).not.toMatch(/<[a-z]+[ >]/);
  });

  it('a failed send is tried again until it goes; the log names the recipient only by its hash, never the server\'s message', async () => {
    emailSender.failuresToCome = 2;
    const requestId = randomUUID();
    await testApplication.application.get(NotificationQueue).enqueue('email', email, { template: 'station_reactivated', stationName: 'Sunrise FM' }, requestId);
    await eventually(() => emailSender.sent, (sent) => sent.length === 1, 'the third try');
    await waitForLogWrites();
    const lines = testApplication.logs.lines.filter((line) => line.requestId === requestId);
    expect(lines.map((line) => line.msg)).toEqual([
      'notification send failed; it will be tried again',
      'notification send failed; it will be tried again',
      'notification sent',
    ]);
    expect(lines[0]).toMatchObject({ template: 'station_reactivated', channel: 'email', recipientHash: expect.any(String), failure: { errorName: 'Error', errorCode: 'EENVELOPE', responseCode: 550 } });
    expect(JSON.stringify(testApplication.logs.lines)).not.toContain(email);
    expect(JSON.stringify(testApplication.logs.lines)).not.toContain('mailbox unavailable');
  });

  it('P5A-NOTIFICATIONS-01: after five failed tries it gives up with an error in the log, and the job is gone', async () => {
    emailSender.failuresToCome = 5;
    const requestId = randomUUID();
    await testApplication.application.get(NotificationQueue).enqueue('email', email, { template: 'station_reactivated', stationName: 'Sunrise FM' }, requestId);
    await eventually(
      async () => { await waitForLogWrites(); return testApplication.logs.lines.filter((line) => line.requestId === requestId); },
      (lines) => lines.some((line) => line.msg === 'notification not sent after every try'),
      'the fifth failure',
    );
    expect(testApplication.logs.find((line) => line.requestId === requestId && line.msg === 'notification not sent after every try')).toMatchObject({ level: 50, attempt: 5 });
    expect(emailSender.sent).toEqual([]);
    await eventually(queuedJobCount, (count) => count === 0, 'the queue to empty');
  });

  it('LA-ROUTES-05: a listener’s email code is an email only, worth sending for ten minutes, and nothing of it stays in Valkey once sent', async () => {
    let openGate = () => undefined as void;
    emailSender.gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    try {
      const queuedAt = Date.now();
      await testApplication.application.get(NotificationQueue).enqueue('email', email, { template: 'listener_email_code', code: '042817' }, randomUUID());
      const [job] = await eventually(
        () => rawQueue.getJobs(['waiting', 'active', 'delayed', 'prioritized']),
        (jobs) => jobs.length === 1,
        'the code to be queued',
      );
      expect(job?.opts.attempts).toBe(5);
      const secondsToDeadline = ((job?.data.deadlineEpochMilliseconds ?? 0) - queuedAt) / 1000;
      expect(secondsToDeadline).toBeGreaterThan(9 * 60);
      expect(secondsToDeadline).toBeLessThanOrEqual(10 * 60 + 5);
    } finally {
      openGate();
      emailSender.gate = null;
    }
    const [delivered] = await eventually(() => emailSender.sent, (sent) => sent.length === 1, 'the email');
    expect(delivered).toMatchObject({ to: email, subject: 'Your Look Up code is 042817' });
    expect(delivered?.text).toContain('042817');
    expect(delivered?.text).toContain('10 minutes');
    expect(smsTextOf({ template: 'listener_email_code', code: '042817' }, config.PORTAL_PUBLIC_ORIGIN)).toBeNull();
    await eventually(queuedJobCount, (count) => count === 0, 'the queue to empty');
    for (const key of await keyValueStore.keys(`${config.QUEUE_KEY_PREFIX}:${NOTIFY_QUEUE_NAME}:*`)) {
      const type = await keyValueStore.type(key);
      const content =
        type === 'string' ? await keyValueStore.get(key)
          : type === 'hash' ? JSON.stringify(await keyValueStore.hgetall(key))
            : type === 'stream' ? JSON.stringify(await keyValueStore.xrange(key, '-', '+'))
              : type === 'zset' ? JSON.stringify(await keyValueStore.zrange(key, 0, -1))
                : type === 'list' ? JSON.stringify(await keyValueStore.lrange(key, 0, -1))
                  : JSON.stringify(await keyValueStore.smembers(key).catch(() => []));
      expect(content ?? '', key).not.toContain(email);
      expect(content ?? '', key).not.toContain('042817');
    }
  });

  it('a job past its deadline is dropped, not sent late', async () => {
    const requestId = randomUUID();
    await rawQueue.add('phone_verification_code', {
      channel: 'sms', recipient: phone, message: { template: 'phone_verification_code', code: '111111' }, requestId, deadlineEpochMilliseconds: Date.now() - 1,
    }, { removeOnComplete: true, removeOnFail: true });
    await eventually(
      async () => { await waitForLogWrites(); return testApplication.logs.find((line) => line.requestId === requestId); },
      (line) => line !== undefined,
      'the drop',
    );
    expect(testApplication.logs.find((line) => line.requestId === requestId)?.msg).toBe('notification dropped: past its deadline');
    expect(emailSender.sent).toEqual([]);
  });

  it('P5A-NOTIFICATIONS-10: once sent, nothing of the recipient or the message is left in Valkey; a heartbeat says the worker is alive', async () => {
    // One send that fails first, so the queue's record of failures (its events stream) is checked too.
    emailSender.failuresToCome = 1;
    await testApplication.application.get(NotificationQueue).enqueue('sms', phone, { template: 'phone_verification_code', code: '987654' }, randomUUID());
    await eventually(() => emailSender.sent, (sent) => sent.length === 1, 'the SMS');
    await eventually(queuedJobCount, (count) => count === 0, 'the queue to empty');
    const keys = await keyValueStore.keys(`${config.QUEUE_KEY_PREFIX}:${NOTIFY_QUEUE_NAME}:*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const type = await keyValueStore.type(key);
      const content =
        type === 'string' ? await keyValueStore.get(key)
          : type === 'hash' ? JSON.stringify(await keyValueStore.hgetall(key))
            : type === 'stream' ? JSON.stringify(await keyValueStore.xrange(key, '-', '+'))
              : type === 'zset' ? JSON.stringify(await keyValueStore.zrange(key, 0, -1))
                : type === 'list' ? JSON.stringify(await keyValueStore.lrange(key, 0, -1))
                  : JSON.stringify(await keyValueStore.smembers(key).catch(() => []));
      expect(content ?? '', key).not.toContain('447700900301');
      expect(content ?? '', key).not.toContain('987654');
      expect(content ?? '', key).not.toContain('mailbox unavailable');
    }
    expect(Number(await keyValueStore.get(notifyWorkerHeartbeatKey(config.QUEUE_KEY_PREFIX)))).toBeGreaterThan(Date.now() - 60_000);
  });

  it('a send failure is described by its kind and codes, its stack without the message', () => {
    const failure = Object.assign(new Error('550 rejected applicant@example.com'), { code: 'EENVELOPE', responseCode: 550 });
    const described = describeSendFailure(failure);
    expect(described).toMatchObject({ errorName: 'Error', errorCode: 'EENVELOPE', responseCode: 550 });
    expect(JSON.stringify(described)).not.toContain('applicant@example.com');
    expect(described.stack).toMatch(/notifications\.test\.ts/);
  });
});
