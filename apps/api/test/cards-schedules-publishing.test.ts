import { randomInt, randomUUID } from 'node:crypto';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { mp3Bytes } from './support/audio-fixtures.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertNoInternalDetails } from './support/internal-detail-patterns.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

const actionCard = (overrides: Partial<{ url: string; phone: string }> = {}) => ({
  schema_version: 1,
  layout: 'VERTICAL_STACK',
  actions: [
    { type: 'CALL', id: randomUUID(), label: 'Call Brand A', style: 'PRIMARY', phone_number_e164: overrides.phone ?? '+260977123456' },
    { type: 'LINK', id: randomUUID(), label: 'Visit website', style: 'OUTLINE', url: overrides.url ?? 'https://example.co.zm/offer' },
  ],
});

/** Station-local (Lusaka) date and time, shifted by some minutes, as the schedule writes them. */
function lusakaLocal(minutesFromNow: number) {
  const moment = new Date(Date.now() + minutesFromNow * 60_000);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lusaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(moment);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lusaka', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(moment);
  return { date, time };
}

/** A schedule that is on air right now: every day, from an hour ago to an hour from now (station time). */
function onAirNowSchedule() {
  return {
    startsOn: lusakaLocal(-24 * 60).date,
    endsOn: lusakaLocal(24 * 60).date,
    timeWindows: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], localStartTime: lusakaLocal(-60).time, localEndTime: lusakaLocal(60).time }],
    gracePeriodMinutes: 10,
    engagementLimit: null,
  };
}

describe('buttons, schedules and publishing', () => {
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

  function expectStatus(response: supertest.Response, httpStatus: number): supertest.Response {
    expect(response.status, JSON.stringify(response.body)).toBe(httpStatus);
    return response;
  }

  async function cookiesFor(user: PortalTestUser) {
    const existing = sessions.get(user.userId);
    if (existing) return existing;
    const response = await client()
      .post('/api/v1/auth/sign-in')
      .set('Origin', PORTAL_ORIGIN)
      .set('X-Forwarded-For', newClientAddress())
      .send({ email: user.email, password: user.password });
    const cookies = cookiesSetBy(expectStatus(response, 200));
    sessions.set(user.userId, cookies);
    return cookies;
  }

  const send = async (user: PortalTestUser, method: 'get' | 'post' | 'put', path: string, body?: object) => {
    const cookies = await cookiesFor(user);
    const request = client()[method](path).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookieHeader(cookies));
    if (method !== 'get') request.set('Origin', PORTAL_ORIGIN);
    return body ? request.send(body) : request;
  };

  /** An owner with a client and an ad; `uploaded` also uploads and verifies its audio. */
  async function adFor(options: { uploaded: boolean; role?: 'OWNER' | 'ANALYST' } = { uploaded: true }) {
    const owner = await testUsers.create();
    const clientId = expectStatus(await send(owner, 'post', `/api/v1/stations/${owner.stationId}/clients`, { name: 'Brand A' }), 201).body.id;
    const adsPath = `/api/v1/stations/${owner.stationId}/ads`;
    const bytes = mp3Bytes();
    const created = expectStatus(
      await send(owner, 'post', adsPath, {
        clientId,
        title: 'Summer service offer',
        upload: { fileName: 'offer.mp3', contentType: 'audio/mpeg', sizeBytes: bytes.length },
      }),
      201,
    ).body;
    if (options.uploaded) {
      const uploadStatus = await fetch(created.upload.url, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'audio/mpeg' } });
      expect(uploadStatus.status).toBe(200);
      expectStatus(await send(owner, 'post', `${adsPath}/${created.adId}/complete`), 200);
    }
    const member = options.role === 'ANALYST' ? await testUsers.create({ joinStationId: owner.stationId, role: 'ANALYST' }) : owner;
    return { owner, member, adPath: `${adsPath}/${created.adId}`, adsPath, adId: created.adId as string };
  }

  describe('buttons (action cards)', () => {
    it('saves the card as a new version each time and shows the latest on the ad', async () => {
      const { owner, adPath, adId } = await adFor();
      const firstCard = actionCard();
      const saved = expectStatus(await send(owner, 'put', `${adPath}/card`, firstCard), 200);
      expect(saved.body.actionCard).toEqual(firstCard);
      const secondCard = actionCard({ phone: '+260966000111' });
      expectStatus(await send(owner, 'put', `${adPath}/card`, secondCard), 200);
      const detail = expectStatus(await send(owner, 'get', adPath), 200);
      expect(detail.body.actionCard).toEqual(secondCard);
      const versions = await setupClient.query(
        `SELECT count(*)::integer AS version_count FROM app.action_cards WHERE client_id = (SELECT client_id FROM app.ads WHERE id = $1)`,
        [adId],
      );
      expect(versions.rows[0].version_count).toBe(2);
      const audit = await setupClient.query(`SELECT changes FROM app.audit_events WHERE entity_id = $1 AND action = 'action_card_saved'`, [adId]);
      expect(audit.rows).toHaveLength(2);
      expect(JSON.stringify(audit.rows)).not.toContain('+260966000111');
    });

    it('refuses a javascript: link or a local phone number, naming the field and the rule, never echoing the value', async () => {
      const { owner, adPath } = await adFor();
      const badLink = expectStatus(await send(owner, 'put', `${adPath}/card`, actionCard({ url: 'javascript:alert(1)' })), 400);
      expect(badLink.body.error.fields).toEqual([
        { path: 'actions.1.url', code: 'invalid_format' },
        { path: 'actions.1.url', code: 'link_must_be_canonical_https' },
      ]);
      expect(JSON.stringify(badLink.body)).not.toContain('javascript');
      const badPhone = expectStatus(await send(owner, 'put', `${adPath}/card`, actionCard({ phone: '0977123456' })), 400);
      expect(badPhone.body.error.fields).toEqual([{ path: 'actions.0.phone_number_e164', code: 'invalid_format' }]);
      expect(JSON.stringify(badPhone.body)).not.toContain('0977123456');
      const shortener = expectStatus(await send(owner, 'put', `${adPath}/card`, actionCard({ url: 'https://bit.ly/abc123' })), 400);
      expect(shortener.body.error.fields).toEqual([{ path: 'actions.1.url', code: 'link_uses_url_shortener' }]);
      assertNoInternalDetails(badLink.body);
    });
  });

  describe('schedules', () => {
    it('creates a draft campaign in the station time zone and replaces its windows when saved again', async () => {
      const { owner, adPath } = await adFor();
      const schedule = {
        startsOn: '2026-11-02',
        endsOn: '2026-11-30',
        timeWindows: [
          { daysOfWeek: [5, 1, 3], localStartTime: '07:00', localEndTime: '09:00' },
          { daysOfWeek: [5], localStartTime: '22:00', localEndTime: '02:00' },
        ],
        gracePeriodMinutes: 20,
        engagementLimit: 250,
      };
      const saved = expectStatus(await send(owner, 'put', `${adPath}/schedule`, schedule), 200).body;
      expect(saved.schedule).toEqual({
        id: expect.any(String),
        displayStatus: 'DRAFT',
        startsOn: '2026-11-02',
        endsOn: '2026-11-30',
        timeWindows: [
          { daysOfWeek: [1, 3, 5], localStartTime: '07:00', localEndTime: '09:00' },
          { daysOfWeek: [5], localStartTime: '22:00', localEndTime: '02:00' },
        ],
        gracePeriodMinutes: 20,
        engagementLimit: 250,
        stationTimeZone: 'Africa/Lusaka',
      });
      const period = await setupClient.query(`SELECT lower(active_period) AS starts_at, upper(active_period) AS ends_at FROM app.campaigns WHERE id = $1`, [
        saved.schedule.id,
      ]);
      // Midnight in Lusaka (UTC+2) is 22:00 UTC the day before.
      expect(period.rows[0].starts_at.toISOString()).toBe('2026-11-01T22:00:00.000Z');
      expect(period.rows[0].ends_at.toISOString()).toBe('2026-11-30T22:00:00.000Z');

      const replaced = expectStatus(
        await send(owner, 'put', `${adPath}/schedule`, { ...schedule, timeWindows: [{ daysOfWeek: [6, 7], localStartTime: '10:00', localEndTime: '14:00' }] }),
        200,
      ).body;
      expect(replaced.schedule.id).toBe(saved.schedule.id);
      expect(replaced.schedule.timeWindows).toEqual([{ daysOfWeek: [6, 7], localStartTime: '10:00', localEndTime: '14:00' }]);
    });

    it('refuses an end before the start with the rule named', async () => {
      const { owner, adPath } = await adFor();
      const refused = expectStatus(await send(owner, 'put', `${adPath}/schedule`, { ...onAirNowSchedule(), startsOn: '2026-12-10', endsOn: '2026-12-01' }), 400);
      expect(refused.body.error.fields).toEqual([{ path: 'endsOn', code: 'end_before_start' }]);
    });
  });

  describe('publishing', () => {
    it('names every missing step: upload, buttons and schedule', async () => {
      const { owner, adPath } = await adFor({ uploaded: false });
      const refused = expectStatus(await send(owner, 'post', `${adPath}/publish`), 409);
      expect(refused.body.error.code).toBe('AD_NOT_READY_TO_PUBLISH');
      expect(refused.body.error.fields).toEqual([
        { path: 'upload', code: 'upload_not_verified' },
        { path: 'actionCard', code: 'action_card_missing' },
        { path: 'schedule', code: 'schedule_missing' },
      ]);
    });

    it('refuses a schedule that has already ended', async () => {
      const { owner, adPath } = await adFor();
      expectStatus(await send(owner, 'put', `${adPath}/card`, actionCard()), 200);
      expectStatus(await send(owner, 'put', `${adPath}/schedule`, { ...onAirNowSchedule(), startsOn: '2026-01-01', endsOn: '2026-01-31' }), 200);
      const refused = expectStatus(await send(owner, 'post', `${adPath}/publish`), 409);
      expect(refused.body.error.fields).toEqual([{ path: 'schedule', code: 'schedule_already_ended' }]);
    });

    it('goes live with the current card, shows as Live now inside its window, and is audited', async () => {
      const { owner, adPath, adsPath, adId } = await adFor();
      const card = actionCard();
      expectStatus(await send(owner, 'put', `${adPath}/card`, card), 200);
      expectStatus(await send(owner, 'put', `${adPath}/schedule`, onAirNowSchedule()), 200);
      const published = expectStatus(await send(owner, 'post', `${adPath}/publish`), 200).body;
      expect(published.schedule.displayStatus).toBe('LIVE_NOW');
      const campaign = await setupClient.query(
        `SELECT campaign.status, campaign.action_card_id = ads.current_action_card_id AS uses_current_card
           FROM app.campaigns AS campaign JOIN app.ads ON ads.id = campaign.ad_id WHERE campaign.ad_id = $1`,
        [adId],
      );
      expect(campaign.rows).toEqual([{ status: 'ACTIVE', uses_current_card: true }]);
      const listed = expectStatus(await send(owner, 'get', adsPath), 200).body.ads.find((ad: { id: string }) => ad.id === adId);
      expect(listed.campaign.displayStatus).toBe('LIVE_NOW');
      expect(listed.campaign.timeWindows).toHaveLength(1);
      const audit = await setupClient.query(`SELECT 1 FROM app.audit_events WHERE entity_id = $1 AND action = 'ad_published'`, [adId]);
      expect(audit.rowCount).toBe(1);
    });

    it('a card saved while the ad is live reaches listeners at once', async () => {
      const { owner, adPath, adId } = await adFor();
      expectStatus(await send(owner, 'put', `${adPath}/card`, actionCard()), 200);
      expectStatus(await send(owner, 'put', `${adPath}/schedule`, onAirNowSchedule()), 200);
      expectStatus(await send(owner, 'post', `${adPath}/publish`), 200);
      expectStatus(await send(owner, 'put', `${adPath}/card`, actionCard({ phone: '+260955000222' })), 200);
      const campaign = await setupClient.query(
        `SELECT card.content -> 'actions' -> 0 ->> 'phone_number_e164' AS phone
           FROM app.campaigns AS campaign JOIN app.action_cards AS card ON card.id = campaign.action_card_id WHERE campaign.ad_id = $1`,
        [adId],
      );
      expect(campaign.rows[0].phone).toBe('+260955000222');
    });
  });

  describe('who may change buttons, schedules and publishing', () => {
    it('an analyst may read the ad but not change any of it', async () => {
      const { member: analyst, adPath } = await adFor({ uploaded: true, role: 'ANALYST' });
      expectStatus(await send(analyst, 'get', adPath), 200);
      expectStatus(await send(analyst, 'put', `${adPath}/card`, actionCard()), 403);
      expectStatus(await send(analyst, 'put', `${adPath}/schedule`, onAirNowSchedule()), 403);
      expectStatus(await send(analyst, 'post', `${adPath}/publish`), 403);
    });

    it("another station gets 404 on this station's ad, whatever it tries", async () => {
      const { adId } = await adFor();
      const outsider = await testUsers.create();
      const outsiderPath = `/api/v1/stations/${outsider.stationId}/ads/${adId}`;
      expectStatus(await send(outsider, 'put', `${outsiderPath}/card`, actionCard()), 404);
      expectStatus(await send(outsider, 'put', `${outsiderPath}/schedule`, onAirNowSchedule()), 404);
      expectStatus(await send(outsider, 'post', `${outsiderPath}/publish`), 404);
    });
  });
});
