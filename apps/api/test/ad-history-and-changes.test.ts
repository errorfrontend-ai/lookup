import { randomInt, randomUUID } from 'node:crypto';
import { type AdHistoryEvent, AD_HISTORY_EVENTS_PER_PAGE } from '@lookup/contracts';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { mp3Bytes } from './support/audio-fixtures.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const SECRETS = ['+260977123456', '+260966000111', '977123456', 'example.co.zm', 'Hello there'];

/**
 * An ad's history, renaming and removing an ad. The history is read back after a real sequence of
 * changes, and checked to say what happened without ever repeating a phone number, link or place.
 */
describe('ad history, rename and archive', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  let owner: PortalTestUser;
  let analyst: PortalTestUser;
  let otherStationOwner: PortalTestUser;
  let stationUnderReviewOwner: PortalTestUser;
  let clientId: string;
  const sessions = new Map<string, Record<string, string>>();
  const client = () => supertest(testApplication.application.getHttpServer());
  const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  const adsPath = (user: PortalTestUser) => `/api/v1/stations/${user.stationId}/ads`;

  async function cookiesFor(user: PortalTestUser) {
    const existing = sessions.get(user.userId);
    if (existing) return existing;
    const response = await client().post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).send({ email: user.email, password: user.password });
    expect(response.status).toBe(200);
    const cookies = cookiesSetBy(response);
    sessions.set(user.userId, cookies);
    return cookies;
  }

  async function send(user: PortalTestUser, method: 'get' | 'post' | 'put', path: string, body?: object) {
    const cookies = await cookiesFor(user);
    const request = client()[method](path).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookieHeader(cookies));
    if (method !== 'get') request.set('Origin', PORTAL_ORIGIN);
    return body ? request.send(body) : request;
  }

  function expectStatus(response: supertest.Response, httpStatus: number): supertest.Response {
    expect(response.status, JSON.stringify(response.body)).toBe(httpStatus);
    return response;
  }

  /** An ad with its audio uploaded and checked. */
  async function createUploadedAd(user: PortalTestUser, title: string, forClientId = clientId): Promise<string> {
    const bytes = mp3Bytes();
    const created = expectStatus(
      await send(user, 'post', adsPath(user), { clientId: forClientId, title, upload: { fileName: 'offer.mp3', contentType: 'audio/mpeg', sizeBytes: bytes.length } }),
      201,
    ).body;
    expect((await fetch(created.upload.url, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'audio/mpeg' } })).status).toBe(200);
    expectStatus(await send(user, 'post', `${adsPath(user)}/${created.adId}/complete`), 200);
    return created.adId as string;
  }

  const cardWith = (phone: string, whatsappPhone: string, buttonIds = { call: randomUUID(), whatsapp: randomUUID() }) => ({
    schema_version: 1,
    layout: 'VERTICAL_STACK',
    actions: [
      { type: 'CALL', id: buttonIds.call, label: 'Call us', style: 'PRIMARY', phone_number_e164: phone },
      { type: 'WHATSAPP', id: buttonIds.whatsapp, label: 'Chat with us', style: 'SECONDARY', phone_number_e164: whatsappPhone, prefilled_text: 'Hello there' },
    ],
  });

  function lusakaLocal(minutesFromNow: number) {
    const moment = new Date(Date.now() + minutesFromNow * 60_000);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lusaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(moment);
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lusaka', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(moment);
    return { date, time };
  }
  const onAirNowSchedule = (endsInDays = 1) => ({
    startsOn: lusakaLocal(-24 * 60).date,
    endsOn: lusakaLocal(endsInDays * 24 * 60).date,
    timeWindows: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], localStartTime: lusakaLocal(-60).time, localEndTime: lusakaLocal(60).time }],
    gracePeriodMinutes: 10,
    engagementLimit: null,
  });

  const historyOf = async (user: PortalTestUser, adId: string, query = '') => (await send(user, 'get', `${adsPath(user)}/${adId}/history${query}`)) as supertest.Response;

  beforeAll(async () => {
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
    owner = await testUsers.create({ fullName: 'Chanda Mwale' });
    analyst = await testUsers.create({ joinStationId: owner.stationId, role: 'ANALYST', fullName: 'Mutale Banda' });
    otherStationOwner = await testUsers.create();
    stationUnderReviewOwner = await testUsers.create({ stationStatus: 'PENDING_REVIEW' });
    clientId = expectStatus(await send(owner, 'post', `/api/v1/stations/${owner.stationId}/clients`, { name: 'Brand A' }), 201).body.id;
  });
  afterAll(async () => {
    await testUsers.cleanUp();
    await setupClient.end();
    await testApplication.close();
  });

  describe('history', () => {
    it('tells the story of an ad in order, naming who did each thing, without repeating a number or a link', async () => {
      const adId = await createUploadedAd(owner, 'Summer offer');
      const buttonIds = { call: randomUUID(), whatsapp: randomUUID() };
      expectStatus(await send(owner, 'put', `${adsPath(owner)}/${adId}/card`, cardWith('+260977123456', '+260966000111', buttonIds)), 200);
      expectStatus(await send(owner, 'put', `${adsPath(owner)}/${adId}/card`, cardWith('+260977123456', '+260955000222', buttonIds)), 200);
      expectStatus(await send(owner, 'put', `${adsPath(owner)}/${adId}/schedule`, onAirNowSchedule(1)), 200);
      expectStatus(await send(owner, 'put', `${adsPath(owner)}/${adId}/schedule`, onAirNowSchedule(3)), 200);
      expectStatus(await send(owner, 'post', `${adsPath(owner)}/${adId}/publish`), 200);
      expectStatus(await send(owner, 'put', `${adsPath(owner)}/${adId}/title`, { title: 'Summer service offer' }), 200);

      const response = expectStatus(await historyOf(owner, adId), 200);
      const events = response.body.events as AdHistoryEvent[];
      expect(events.map((event) => event.kind)).toEqual([
        'ad_renamed', 'ad_published', 'schedule_saved', 'schedule_saved', 'buttons_saved', 'buttons_saved', 'audio_upload_checked', 'ad_created',
      ]);
      for (const event of events) expect(event.actorName, event.kind).toBe('Chanda Mwale');
      expect(events[0]).toMatchObject({ previousTitle: 'Summer offer', title: 'Summer service offer' });
      expect(events[1]).toMatchObject({ isRepublish: false });
      expect(events[2]).toMatchObject({ isFirstSave: false, changedParts: ['dates'] });
      expect(events[3]).toMatchObject({ isFirstSave: true });
      expect(events[4]).toMatchObject({
        isFirstSave: false,
        buttonChanges: [{ buttonLabel: 'Chat with us', buttonType: 'WHATSAPP', change: 'changed', changedFields: ['phone_number'] }],
      });
      expect(events[5]).toMatchObject({
        isFirstSave: true,
        buttonChanges: [{ buttonLabel: 'Call us', change: 'added' }, { buttonLabel: 'Chat with us', change: 'added' }],
      });
      expect(events[7]).toMatchObject({ fileName: 'offer.mp3' });
      expect(response.body.nextCursor).toBeNull();

      // Newest first, and no value from any button or schedule appears anywhere in the response.
      const times = events.map((event) => event.occurredAt);
      expect([...times].sort().reverse()).toEqual(times);
      for (const secret of [...SECRETS, '+260955000222']) expect(JSON.stringify(response.body), secret).not.toContain(secret);
    });

    it('says a second publish of a live ad is an update', async () => {
      const adId = await createUploadedAd(owner, 'Republished ad');
      expectStatus(await send(owner, 'put', `${adsPath(owner)}/${adId}/card`, cardWith('+260977123456', '+260966000111')), 200);
      expectStatus(await send(owner, 'put', `${adsPath(owner)}/${adId}/schedule`, onAirNowSchedule()), 200);
      expectStatus(await send(owner, 'post', `${adsPath(owner)}/${adId}/publish`), 200);
      expectStatus(await send(owner, 'post', `${adsPath(owner)}/${adId}/publish`), 200);
      const events = (await historyOf(owner, adId)).body.events as AdHistoryEvent[];
      expect(events.filter((event) => event.kind === 'ad_published').map((event) => (event as { isRepublish: boolean }).isRepublish)).toEqual([true, false]);
    });

    it('shows a former team member\'s actions without their name', async () => {
      const adId = await createUploadedAd(owner, 'Handed over');
      const formerMember = await testUsers.create({ fullName: 'Former Member' }); // belongs to a different station: not on this team
      await setupClient.query(
        `INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id) VALUES ($1, $2, 'ad_renamed', 'ad', $3, $4, 'test')`,
        [owner.stationId, formerMember.userId, adId, JSON.stringify({ previousTitle: 'Old', title: 'Handed over' })],
      );
      const events = (await historyOf(owner, adId)).body.events as AdHistoryEvent[];
      expect(events[0]).toMatchObject({ kind: 'ad_renamed', actorName: null });
      expect(JSON.stringify(events)).not.toContain('Former Member');
    });

    it('pages through a long history, newest first, with no repeats', async () => {
      const adId = await createUploadedAd(owner, 'Long story');
      for (let index = 0; index < AD_HISTORY_EVENTS_PER_PAGE + 5; index += 1) {
        await setupClient.query(
          `INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id) VALUES ($1, $2, 'ad_renamed', 'ad', $3, $4, 'test')`,
          [owner.stationId, owner.userId, adId, JSON.stringify({ previousTitle: `Title ${index}`, title: `Title ${index + 1}` })],
        );
      }
      const firstPage = (await historyOf(owner, adId)).body;
      expect(firstPage.events).toHaveLength(AD_HISTORY_EVENTS_PER_PAGE);
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = expectStatus(await historyOf(owner, adId, `?cursor=${firstPage.nextCursor}`), 200).body;
      expect(secondPage.events.length).toBeGreaterThanOrEqual(5);
      const ids = [...firstPage.events, ...secondPage.events].map((event: AdHistoryEvent) => event.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(secondPage.events.at(-1)).toMatchObject({ kind: 'ad_created' });
      expect(secondPage.nextCursor).toBeNull();
      for (const bad of ['abc', '1.5', '-3', '99999999999999999999']) {
        expect(expectStatus(await historyOf(owner, adId, `?cursor=${bad}`), 400).body.error.fields).toEqual([{ path: 'cursor', code: 'invalid_cursor' }]);
      }
    });

    it('is read-only for analysts, and another station\'s ad, an unknown ad or a station under review are refused', async () => {
      const adId = await createUploadedAd(owner, 'Visible to analysts');
      expect((await historyOf(analyst, adId)).status).toBe(200);
      const foreign = await send(otherStationOwner, 'get', `${adsPath(owner)}/${adId}/history`);
      expect(foreign.status).toBe(404);
      assertErrorEnvelope(foreign.body);
      // The same id under the other person's own station is "not found" too: the ad isn't theirs.
      expect((await send(otherStationOwner, 'get', `${adsPath(otherStationOwner)}/${adId}/history`)).status).toBe(404);
      expect((await historyOf(owner, randomUUID())).status).toBe(404);
      expect((await historyOf(owner, 'not-a-uuid')).status).toBe(404);
      const underReview = await send(stationUnderReviewOwner, 'get', `${adsPath(stationUnderReviewOwner)}/${adId}/history`);
      expect(underReview.status).toBe(403);
    });

    it('only the ad\'s own history: another ad\'s buttons and schedule never appear', async () => {
      const first = await createUploadedAd(owner, 'First of two');
      const second = await createUploadedAd(owner, 'Second of two');
      expectStatus(await send(owner, 'put', `${adsPath(owner)}/${second}/card`, cardWith('+260977123456', '+260966000111')), 200);
      expect(((await historyOf(owner, first)).body.events as AdHistoryEvent[]).map((event) => event.kind)).toEqual(['audio_upload_checked', 'ad_created']);
    });
  });

  describe('renaming', () => {
    it('changes the title, records who and from what, and leaves an unchanged title unrecorded', async () => {
      const adId = await createUploadedAd(owner, 'Typo in tilte');
      const renamed = expectStatus(await send(owner, 'put', `${adsPath(owner)}/${adId}/title`, { title: '  Typo in title  ' }), 200).body;
      expect(renamed.title).toBe('Typo in title');
      expectStatus(await send(owner, 'put', `${adsPath(owner)}/${adId}/title`, { title: 'Typo in title' }), 200);
      const audit = await setupClient.query(`SELECT changes FROM app.audit_events WHERE entity_id = $1 AND action = 'ad_renamed'`, [adId]);
      expect(audit.rows).toEqual([{ changes: { previousTitle: 'Typo in tilte', title: 'Typo in title' } }]);
      expect(((await send(owner, 'get', `${adsPath(owner)}/${adId}`)).body as { title: string }).title).toBe('Typo in title');
    });

    it('refuses an empty or over-long title, an unknown field, an analyst and another station', async () => {
      const adId = await createUploadedAd(owner, 'Stays as it is');
      for (const body of [{ title: '   ' }, { title: 'x'.repeat(121) }, { title: 'ok', extra: 1 }, {}]) {
        const response = await send(owner, 'put', `${adsPath(owner)}/${adId}/title`, body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        assertErrorEnvelope(response.body);
      }
      expect((await send(analyst, 'put', `${adsPath(owner)}/${adId}/title`, { title: 'Nope' })).status).toBe(403);
      expect((await send(otherStationOwner, 'put', `${adsPath(owner)}/${adId}/title`, { title: 'Nope' })).status).toBe(404);
      expect(((await send(owner, 'get', `${adsPath(owner)}/${adId}`)).body as { title: string }).title).toBe('Stays as it is');
    });
  });

  describe('removing an ad', () => {
    it('removes a draft from every list and page, keeps it for the record, and audits it', async () => {
      const adId = await createUploadedAd(owner, 'Abandoned draft');
      expectStatus(await send(owner, 'post', `${adsPath(owner)}/${adId}/archive`), 204);

      expect((await send(owner, 'get', `${adsPath(owner)}/${adId}`)).status).toBe(404);
      expect((await historyOf(owner, adId)).status).toBe(404);
      const listed = (await send(owner, 'get', `${adsPath(owner)}?view=all`)).body.ads as Array<{ id: string }>;
      expect(listed.map((ad) => ad.id)).not.toContain(adId);
      const stored = await setupClient.query(`SELECT archived_at IS NOT NULL AS is_archived FROM app.ads WHERE id = $1`, [adId]);
      expect(stored.rows).toEqual([{ is_archived: true }]);
      const audit = await setupClient.query(`SELECT changes FROM app.audit_events WHERE entity_id = $1 AND action = 'ad_archived'`, [adId]);
      expect(audit.rows).toEqual([{ changes: { title: 'Abandoned draft' } }]);
      // Removing it again: it is gone.
      expect((await send(owner, 'post', `${adsPath(owner)}/${adId}/archive`)).status).toBe(404);
    });

    it('refuses to remove an ad that is published, until its schedule has ended', async () => {
      const adId = await createUploadedAd(owner, 'Live ad');
      expectStatus(await send(owner, 'put', `${adsPath(owner)}/${adId}/card`, cardWith('+260977123456', '+260966000111')), 200);
      expectStatus(await send(owner, 'put', `${adsPath(owner)}/${adId}/schedule`, onAirNowSchedule()), 200);
      expectStatus(await send(owner, 'post', `${adsPath(owner)}/${adId}/publish`), 200);

      const refused = expectStatus(await send(owner, 'post', `${adsPath(owner)}/${adId}/archive`), 409);
      expect(refused.body.error.code).toBe('CONFLICT');
      expect(refused.body.error.message).toBe('This ad is published. It can be removed once its schedule has ended.');
      expect((await send(owner, 'get', `${adsPath(owner)}/${adId}`)).status).toBe(200);

      // Once the schedule has ended, it can go.
      await setupClient.query(`UPDATE app.campaigns SET status = 'ENDED' WHERE ad_id = $1`, [adId]);
      expectStatus(await send(owner, 'post', `${adsPath(owner)}/${adId}/archive`), 204);
    });

    it('is for owners and managers; an analyst, another station and a station under review are refused', async () => {
      const adId = await createUploadedAd(owner, 'Protected');
      expect((await send(analyst, 'post', `${adsPath(owner)}/${adId}/archive`)).status).toBe(403);
      expect((await send(otherStationOwner, 'post', `${adsPath(owner)}/${adId}/archive`)).status).toBe(404);
      expect((await send(stationUnderReviewOwner, 'post', `${adsPath(stationUnderReviewOwner)}/${adId}/archive`)).status).toBe(403);
      expect((await send(owner, 'get', `${adsPath(owner)}/${adId}`)).status).toBe(200);

      const manager = await testUsers.create({ joinStationId: owner.stationId, role: 'MANAGER' });
      expectStatus(await send(manager, 'post', `${adsPath(owner)}/${adId}/archive`), 204);
      expect((await send(owner, 'get', `${adsPath(owner)}/${adId}`)).status).toBe(404);
    });
  });
});
