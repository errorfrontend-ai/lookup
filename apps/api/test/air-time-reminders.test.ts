import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AirTimeReminders } from '../src/features/air-time-reminders/air-time-reminders.js';
import { emailTextOf, type NotificationMessage, pushNoticeOf } from '../src/features/notifications/notification-messages.js';
import type { NotificationChannel } from '../src/features/notifications/notification-queue.js';
import { NotificationQueue } from '../src/features/notifications/notification-queue.js';
import { PUSH_SENDER, type PushSender } from '../src/features/notifications/web-push.js';
import { databaseSetupClient } from './support/database-clients.js';
import { PLACEHOLDER_PASSWORD_HASH } from './support/test-data.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/** The queue as the job sees it: every message it was given, in order. */
class RecordingQueue {
  readonly queued: Array<{ channel: NotificationChannel; recipient: string; message: NotificationMessage; requestId: string }> = [];
  async enqueue(channel: NotificationChannel, recipient: string, message: NotificationMessage, requestId: string): Promise<void> {
    this.queued.push({ channel, recipient, message, requestId });
  }
  async countWaiting(): Promise<number> {
    return 0;
  }
}

const pushSender: PushSender & { isOn: boolean } = {
  isOn: true,
  get publicKey() {
    return this.isOn ? 'B'.repeat(87) : null;
  },
  send: async () => 'SENT',
};

/**
 * The air-time reminders (ADR-006 decision 6; P5C-NOTIFY-04, -05, -07): the job run by hand at fixed moments. Brand A's
 * advert airs Monday to Friday 07:00–09:00 in Lusaka (05:00 UTC); the week starts Monday 5 October 2026.
 */
describe('air-time reminders', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let reminders: AirTimeReminders;
  const queue = new RecordingQueue();
  const stationId = randomUUID();
  const clientId = randomUUID();
  const adId = randomUUID();
  const people = { pushOnly: randomUUID(), emailToo: randomUUID() };
  const emails = { pushOnly: `push-only-${people.pushOnly.slice(0, 8)}@example.test`, emailToo: `email-too-${people.emailToo.slice(0, 8)}@example.test` };

  beforeAll(async () => {
    testApplication = await createTestApplication({
      overrideProviders: (builder) => builder.overrideProvider(NotificationQueue).useValue(queue).overrideProvider(PUSH_SENDER).useValue(pushSender),
    });
    reminders = testApplication.application.get(AirTimeReminders);
    setupClient = databaseSetupClient();
    await setupClient.connect();
    await setupClient.query(`INSERT INTO app.stations (id, name, frequency_label, status, time_zone) VALUES ($1, 'Reminder FM', '98.1 FM', 'ACTIVE', 'Africa/Lusaka')`, [stationId]);
    await setupClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, 'Brand A')`, [clientId, stationId]);
    await setupClient.query(`INSERT INTO app.ads (id, station_id, client_id, title) VALUES ($1, $2, $3, 'Summer service offer')`, [adId, stationId, clientId]);
    const campaign = await setupClient.query(
      `INSERT INTO app.campaigns (station_id, ad_id, name, status, active_period) VALUES ($1, $2, 'Reminder campaign', 'ACTIVE', tstzrange('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', '[)')) RETURNING id`,
      [stationId, adId],
    );
    await setupClient.query(`INSERT INTO app.campaign_time_windows (campaign_id, station_id, days_of_week, local_start_time, local_end_time) VALUES ($1, $2, '{1,2,3,4,5}', '07:00', '09:00')`, [campaign.rows[0].id, stationId]);
    for (const name of ['pushOnly', 'emailToo'] as const) {
      await setupClient.query('INSERT INTO app.portal_users (id, email, password_hash, full_name) VALUES ($1, $2, $3, $4)', [people[name], emails[name], PLACEHOLDER_PASSWORD_HASH, `Client ${name}`]);
      await setupClient.query('INSERT INTO app.client_viewers (client_id, station_id, portal_user_id) VALUES ($1, $2, $3)', [clientId, stationId, people[name]]);
    }
    await setupClient.query('INSERT INTO app.client_viewer_notification_settings (portal_user_id, is_push_on, is_email_on, lead_minutes) VALUES ($1, true, true, 30)', [people.emailToo]);
  });

  beforeEach(async () => {
    queue.queued.length = 0;
    pushSender.isOn = true;
    await setupClient.query('DELETE FROM app.air_time_reminders WHERE portal_user_id = ANY($1)', [Object.values(people)]);
  });

  afterAll(async () => {
    await setupClient.query('DELETE FROM app.portal_users WHERE id = ANY($1)', [Object.values(people)]);
    await setupClient.query('DELETE FROM app.campaign_time_windows WHERE station_id = $1', [stationId]);
    await setupClient.query('DELETE FROM app.campaigns WHERE station_id = $1', [stationId]);
    await setupClient.query('DELETE FROM app.ads WHERE station_id = $1', [stationId]);
    await setupClient.query('DELETE FROM app.clients WHERE station_id = $1', [stationId]);
    await setupClient.query('DELETE FROM app.stations WHERE id = $1', [stationId]);
    await setupClient.end();
    await testApplication.close();
  });

  const ours = () => queue.queued.filter((entry) => entry.message.template === 'air_time_reminder' && entry.message.adId === adId);

  it('P5C-NOTIFY-04: each person is reminded once, at their own lead time, by the channels they chose', async () => {
    // 04:29 UTC: nobody yet. 04:30: the 30-minute person, by push and by email.
    expect(await reminders.runOnce(new Date('2026-10-05T04:29:00Z'))).toMatchObject({ queued: 0 });
    await reminders.runOnce(new Date('2026-10-05T04:30:00Z'));
    expect(ours().map((entry) => [entry.channel, entry.recipient])).toEqual([
      ['push', people.emailToo],
      ['email', emails.emailToo],
    ]);
    // 04:45: the person with the default 15 minutes, by push only; the first person is not reminded again.
    queue.queued.length = 0;
    await reminders.runOnce(new Date('2026-10-05T04:45:00Z'));
    expect(ours().map((entry) => [entry.channel, entry.recipient])).toEqual([['push', people.pushOnly]]);
    queue.queued.length = 0;
    await reminders.runOnce(new Date('2026-10-05T04:59:00Z'));
    expect(ours()).toEqual([]);
  });

  it('P5C-NOTIFY-04: two runs at the same minute (two servers) send each reminder once', async () => {
    const runs = await Promise.all([reminders.runOnce(new Date('2026-10-06T04:50:00Z')), reminders.runOnce(new Date('2026-10-06T04:50:00Z'))]);
    expect(runs.reduce((total, run) => total + run.queued, 0)).toBe(2);
    expect(ours().filter((entry) => entry.channel === 'push').map((entry) => entry.recipient).sort()).toEqual([people.emailToo, people.pushOnly].sort());
  });

  it('P5C-NOTIFY-06: without push on the server, only email reminders go', async () => {
    pushSender.isOn = false;
    await reminders.runOnce(new Date('2026-10-07T04:50:00Z'));
    expect(ours().map((entry) => [entry.channel, entry.recipient])).toEqual([['email', emails.emailToo]]);
  });

  it('P5C-NOTIFY-05, P5C-NOTIFY-07: the reminder names the advert, the station, its frequency and the slot, never a minute or a listener; it opens the advert', async () => {
    await reminders.runOnce(new Date('2026-10-08T04:45:00Z'));
    const [push] = ours().filter((entry) => entry.channel === 'push' && entry.recipient === people.pushOnly);
    const message = push?.message as Extract<NotificationMessage, { template: 'air_time_reminder' }>;
    const notice = pushNoticeOf(message, Date.parse('2026-10-08T04:45:00Z'));
    expect(notice).toEqual({
      notice: {
        title: 'Summer service offer airs soon',
        body: 'On Reminder FM (98.1 FM) between 07:00 and 09:00 today. Listen in to check it.',
        url: `/client/stations/${stationId}/ads/${adId}`,
        tag: expect.stringMatching(/^air-time-[0-9a-f-]{36}-2026-10-08$/),
      },
      ttlSeconds: 15 * 60,
    });
    const email = emailTextOf(message, 'https://portal.example');
    expect(email).toEqual({
      subject: 'Summer service offer airs soon on Reminder FM',
      text: `Summer service offer airs on Reminder FM (98.1 FM) between 07:00 and 09:00 today. Listen in to check it.\n\nhttps://portal.example/client/stations/${stationId}/ads/${adId}\n\nTo change your reminders: https://portal.example/client/notifications`,
    });
    expect(`${email?.text} ${notice?.notice.body}`).not.toMatch(/listener|07:0[1-9]|\d{2}:\d{2}:\d{2}/i);
    // A slot just after midnight, reminded the evening before, says "tomorrow".
    expect(pushNoticeOf({ ...message, localStartTime: '00:10', localEndTime: '01:00', isToday: false })?.notice.body).toBe('On Reminder FM (98.1 FM) between 00:10 and 01:00 tomorrow. Listen in to check it.');
  });

  it('P5C-NOTIFY-04: a sent reminder is remembered for 30 days, then forgotten', async () => {
    const windowId = (await setupClient.query('SELECT id FROM app.campaign_time_windows WHERE station_id = $1', [stationId])).rows[0].id as string;
    await setupClient.query(`INSERT INTO app.air_time_reminders (portal_user_id, campaign_time_window_id, slot_starts_at, queued_at) VALUES ($1, $2, '2026-08-03T05:00:00Z', now() - interval '31 days')`, [people.pushOnly, windowId]);
    await setupClient.query(`INSERT INTO app.air_time_reminders (portal_user_id, campaign_time_window_id, slot_starts_at, queued_at) VALUES ($1, $2, '2026-09-28T05:00:00Z', now() - interval '29 days')`, [people.pushOnly, windowId]);
    // The job forgets old reminders at most once an hour; the runs above were days earlier.
    await reminders.runOnce(new Date('2026-10-10T12:00:00Z'));
    const kept = (await setupClient.query('SELECT slot_starts_at FROM app.air_time_reminders WHERE portal_user_id = $1', [people.pushOnly])).rows.map((row: { slot_starts_at: Date }) => row.slot_starts_at.toISOString());
    expect(kept).toEqual(['2026-09-28T05:00:00.000Z']);
  });
});
