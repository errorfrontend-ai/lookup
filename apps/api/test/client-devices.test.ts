import { createECDH, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { ClientNotificationSettings } from '@lookup/contracts';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { EMAIL_SENDER, type EmailSender, type OutgoingEmail } from '../src/features/notifications/notification-senders.js';
import { PUSH_SENDER, type PushDevice, type PushNotice, type PushOutcome, type PushSender, PushSendFailure } from '../src/features/notifications/web-push.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { waitForLogWrites } from './support/log-capture.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

class RecordingEmailSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];
  async send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
  }
}

/** A push service stand-in: what it was sent, and how it answers each device (by default "sent"). */
class RecordingPushSender implements PushSender {
  isOn = true;
  readonly sent: Array<{ device: PushDevice; notice: PushNotice; ttlSeconds: number }> = [];
  answers = new Map<string, Array<PushOutcome | 'FAIL'>>();
  get publicKey(): string | null {
    return this.isOn ? 'B'.repeat(87) : null;
  }
  async send(device: PushDevice, notice: PushNotice, ttlSeconds: number): Promise<PushOutcome> {
    const answer = this.answers.get(device.endpoint)?.shift() ?? 'SENT';
    if (answer === 'FAIL') throw new PushSendFailure(503);
    this.sent.push({ device, notice, ttlSeconds });
    return answer;
  }
}

const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

/** A browser's subscription as PushManager gives it, on Google's push service. */
function browserSubscription() {
  const keys = createECDH('prime256v1');
  keys.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(24).toString('base64url')}`, expirationTime: null, keys: { p256dh: keys.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

/**
 * A client's devices and the push channel (ADR-006 decision 7; P5C-NOTIFY-01, -03, -06): turning notifications on and
 * off on a device, the test notification, and the worker sending one notice to each of a person's devices.
 */
describe("a client's devices", () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  let owner: PortalTestUser;
  let viewer: PortalTestUser;
  const emails = new RecordingEmailSender();
  const pushSender = new RecordingPushSender();
  const server = () => testApplication.application.getHttpServer();

  async function signedIn(user: { email: string; password: string }) {
    const response = await supertest(server()).post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).send({ email: user.email, password: user.password }).expect(200);
    return cookieHeader(cookiesSetBy(response));
  }
  const at = (cookie: string, method: 'get' | 'post' | 'put', path: string) =>
    supertest(server())[method](`/api/v1${path}`).set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookie);
  const devicesOf = async (userId: string) =>
    (await setupClient.query('SELECT endpoint, last_sent_at FROM app.web_push_subscriptions WHERE portal_user_id = $1 ORDER BY created_at', [userId])).rows as Array<{ endpoint: string; last_sent_at: Date | null }>;
  async function eventually<Result>(read: () => Result | Promise<Result>, isDone: (value: Result) => boolean, what: string): Promise<Result> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (isDone(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  beforeAll(async () => {
    const config = { ...loadAppConfig(), NOTIFICATION_SENDING_ENABLED: true, NOTIFICATION_RETRY_DELAY_MILLISECONDS: 20 };
    testApplication = await createTestApplication({
      overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config).overrideProvider(EMAIL_SENDER).useValue(emails).overrideProvider(PUSH_SENDER).useValue(pushSender),
    });
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
    owner = await testUsers.create();
    const clientId = randomUUID();
    await setupClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, 'Brand A')`, [clientId, owner.stationId]);
    viewer = await testUsers.createClientViewer(owner.stationId, clientId);
  });

  beforeEach(async () => {
    pushSender.isOn = true;
    pushSender.sent.length = 0;
    pushSender.answers.clear();
    await setupClient.query('DELETE FROM app.web_push_subscriptions WHERE portal_user_id = $1', [viewer.userId]);
    await setupClient.query('DELETE FROM app.client_viewer_notification_settings WHERE portal_user_id = $1', [viewer.userId]);
  });

  afterAll(async () => {
    await testUsers.cleanUp();
    await setupClient.end();
    await testApplication.close();
  });

  it('P5C-NOTIFY-01, P5C-NOTIFY-03: a device turned on is kept for the person, its address and keys never answered or logged; turned off, it is gone', async () => {
    const cookie = await signedIn(viewer);
    const subscription = browserSubscription();
    const turnedOn = await at(cookie, 'post', '/client/push-subscriptions').send(subscription).expect(204);
    expect(turnedOn.text).toBe('');
    expect((await devicesOf(viewer.userId)).map((device) => device.endpoint)).toEqual([subscription.endpoint]);
    // The same device again is the same device.
    await at(cookie, 'post', '/client/push-subscriptions').send(subscription).expect(204);
    expect(await devicesOf(viewer.userId)).toHaveLength(1);
    const settings = (await at(cookie, 'get', '/client/notification-settings').expect(200)).body as ClientNotificationSettings;
    expect(settings).toMatchObject({ isPushAvailable: true, pushPublicKey: 'B'.repeat(87) });
    expect(JSON.stringify(settings)).not.toContain(subscription.endpoint);

    await at(cookie, 'post', '/client/push-subscriptions/removal').send({ endpoint: subscription.endpoint }).expect(204);
    expect(await devicesOf(viewer.userId)).toEqual([]);
    await waitForLogWrites();
    const logs = JSON.stringify(testApplication.logs);
    for (const secret of [subscription.endpoint.split('/').at(-1) as string, subscription.keys.p256dh, subscription.keys.auth]) expect(logs).not.toContain(secret);
  });

  it.each([
    ['an address that is not a browser push service', { endpoint: 'https://169.254.169.254/latest/meta-data' }],
    ['a plain http address', { endpoint: 'http://fcm.googleapis.com/fcm/send/abc' }],
    ['a key of the wrong shape', { keys: { p256dh: 'short', auth: randomBytes(16).toString('base64url') } }],
    ['a field the browser never sends', { extra: true }],
  ])('P5C-NOTIFY-03: %s is refused', async (_what, change) => {
    const cookie = await signedIn(viewer);
    const response = await at(cookie, 'post', '/client/push-subscriptions').send({ ...browserSubscription(), ...change });
    expect(response.status).toBe(400);
    expect(assertErrorEnvelope(response.body).error.code).toBe('VALIDATION_FAILED');
    expect(await devicesOf(viewer.userId)).toEqual([]);
  });

  it('P5C-NOTIFY-06: without the push keys, a device is refused with PUSH_NOT_AVAILABLE and the settings say push is off', async () => {
    pushSender.isOn = false;
    const cookie = await signedIn(viewer);
    const response = await at(cookie, 'post', '/client/push-subscriptions').send(browserSubscription());
    expect(response.status).toBe(503);
    expect(assertErrorEnvelope(response.body).error.code).toBe('PUSH_NOT_AVAILABLE');
    expect((await at(cookie, 'get', '/client/notification-settings').expect(200)).body).toMatchObject({ isPushAvailable: false, pushPublicKey: null });
  });

  it('P5C-NOTIFY-01: the test notification goes to each device of the person and, when it is on, to their email', async () => {
    const cookie = await signedIn(viewer);
    const phone = browserSubscription();
    const computer = browserSubscription();
    await at(cookie, 'post', '/client/push-subscriptions').send(phone).expect(204);
    await at(cookie, 'post', '/client/push-subscriptions').send(computer).expect(204);
    await at(cookie, 'put', '/client/notification-settings').send({ isPushOn: true, isEmailOn: true, leadMinutes: 15, mutedAds: [] }).expect(200);
    expect((await at(cookie, 'post', '/client/test-notification').expect(200)).body).toEqual({ devices: 2, isEmailSent: true });
    const sent = await eventually(() => pushSender.sent, (list) => list.length === 2, 'two push notices');
    expect(sent.map((entry) => entry.device.endpoint).sort()).toEqual([phone.endpoint, computer.endpoint].sort());
    expect(sent[0]?.notice).toEqual({ title: 'Look Up notifications are on', body: "This is a test. You'll get a notice like this before each of your adverts airs.", url: '/client/notifications', tag: 'test-notification' });
    const email = await eventually(() => emails.sent.filter((entry) => entry.to === viewer.email.toLowerCase()), (list) => list.length === 1, 'the test email');
    expect(email[0]?.subject).toBe('Test notification from Look Up');
    await eventually(() => devicesOf(viewer.userId), (devices) => devices.every((device) => device.last_sent_at !== null), 'each device noted as sent');
  });

  it('P5C-NOTIFY-03: a device its push service no longer knows is forgotten; when no device takes a notice it is tried again', async () => {
    const cookie = await signedIn(viewer);
    const gone = browserSubscription();
    const busy = browserSubscription();
    await at(cookie, 'post', '/client/push-subscriptions').send(gone).expect(204);
    await at(cookie, 'post', '/client/push-subscriptions').send(busy).expect(204);
    pushSender.answers.set(gone.endpoint, ['GONE']);
    pushSender.answers.set(busy.endpoint, ['FAIL']);
    await at(cookie, 'post', '/client/test-notification').expect(200);
    // First try: one device gone (forgotten), one refused; no device took it, so the job runs again and the busy one takes it.
    await eventually(() => pushSender.sent.filter((entry) => entry.device.endpoint === busy.endpoint), (list) => list.length === 1, 'the retried notice');
    expect((await devicesOf(viewer.userId)).map((device) => device.endpoint)).toEqual([busy.endpoint]);
  });

  it('P5C-NOTIFY-01: with push off and email off, a test notification reaches nothing and says so', async () => {
    const cookie = await signedIn(viewer);
    await at(cookie, 'post', '/client/push-subscriptions').send(browserSubscription()).expect(204);
    await at(cookie, 'put', '/client/notification-settings').send({ isPushOn: false, isEmailOn: false, leadMinutes: 15, mutedAds: [] }).expect(200);
    expect((await at(cookie, 'post', '/client/test-notification').expect(200)).body).toEqual({ devices: 0, isEmailSent: false });
  });

  it('P5C-ACCESS-02: a station member who follows no client can add no device and send no test', async () => {
    const cookie = await signedIn(owner);
    expect((await at(cookie, 'post', '/client/push-subscriptions').send(browserSubscription())).status).toBe(404);
    expect((await at(cookie, 'post', '/client/test-notification')).status).toBe(404);
  });
});
