import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { type ClientAdDetail, type ClientHome, type ClientNotificationSettings, type ClientViewerAccessList, ListenerMix } from '@lookup/contracts';
import type pg from 'pg';
import supertest from 'supertest';
import type { EntityManager } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { EMAIL_SENDER, type EmailSender, type OutgoingEmail } from '../src/features/notifications/notification-senders.js';
import { StationScopedTransaction } from '../src/infrastructure/database/station-scoped-transaction.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { StationResolutionTestData } from './support/station-resolution-test-data.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

class RecordingEmailSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];
  async send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
  }
}

const HOUR = 3_600_000;
const CLIENT_RESPONSE_KEYS = new Set([
  'stations', 'stationId', 'stationName', 'frequencyLabel', 'contact', 'name', 'phoneNumberE164', 'clients', 'id', 'nextOnAir',
  'startsAt', 'endsAt', 'localDate', 'localStartTime', 'localEndTime', 'adId', 'adTitle', 'lastSevenDays', 'heard', 'calls',
  'whatsApp', 'directions', 'website', 'ads', 'title', 'clientId', 'clientName', 'status', 'startsOn', 'endsOn', 'timeWindows',
  'daysOfWeek', 'heardLastSevenDays', 'station', 'actionCard', 'nextTimesOnAir', 'range', 'firstDay', 'lastDay', 'listeners',
  'knownListeners', 'notKnownYetListeners', 'genders', 'ageBands', 'group', 'isPushOn', 'isEmailOn', 'leadMinutes', 'mutedAds',
  'isPushAvailable', 'pushPublicKey',
]);

/** Every object key in [value], leaving out the card listeners see. */
function keysIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysIn(item, found);
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      found.add(key);
      if (key !== 'actionCard') keysIn(inner, found);
    }
  }
  return found;
}
const DAY = 24 * HOUR;
const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

interface AiredAd {
  adId: string;
  campaignId: string;
  cardId: string;
}

/**
 * Client accounts (ADR-006; P5C-*): a station invites the business that pays for an advert by email; the person accepts
 * and follows that client's adverts at every station that invited them, each station separate; they see each advert's
 * schedule, how listeners responded and who is listening, and choose their reminders; they can never change station data.
 */
describe('client accounts', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  let resolutionData: StationResolutionTestData;
  const emails = new RecordingEmailSender();
  const createdUserIds: string[] = [];
  const server = () => testApplication.application.getHttpServer();
  let todayStartedAt: number;

  // Station A: Brand A (followed) and Brand Other (not); station B: its own Brand A. One person follows both Brand As.
  let ownerA: PortalTestUser;
  let analystA: PortalTestUser;
  let ownerB: PortalTestUser;
  let follower: PortalTestUser;
  let brandAAtA: string;
  let brandOtherAtA: string;
  let brandAAtB: string;
  let ads: Record<'live' | 'ended' | 'draft' | 'otherClient' | 'atStationB', AiredAd>;

  async function eventually<Result>(read: () => Result, isDone: (value: Result) => boolean, what: string): Promise<Result> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = read();
      if (isDone(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  async function signedIn(user: { email: string; password: string }) {
    const response = await supertest(server()).post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress())
      .send({ email: user.email, password: user.password }).expect(200);
    return cookieHeader(cookiesSetBy(response));
  }
  const at = (cookie: string, method: 'get' | 'post' | 'put' | 'delete' | 'patch', path: string) =>
    supertest(server())[method](`/api/v1${path}`).set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookie);
  const publicly = (path: string) => supertest(server()).post(`/api/v1${path}`).set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress());
  const tokenIn = (email: OutgoingEmail | undefined) => /\/invitations\/accept#token=([A-Za-z0-9_-]{43})/.exec(email?.text ?? '')?.[1] as string;
  const emailsTo = (address: string) => emails.sent.filter((candidate) => candidate.to === address.toLowerCase());
  const newEmail = (who: string) => `${who}.${randomUUID().slice(0, 8)}@example.com`;

  async function lastTokenTo(address: string, count: number): Promise<string> {
    await eventually(() => emailsTo(address), (list) => list.length >= count, `invitation email ${count} to ${address}`);
    return tokenIn(emailsTo(address).at(-1));
  }

  async function newClient(stationId: string, name: string): Promise<string> {
    const clientId = randomUUID();
    await setupClient.query('INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, $3)', [clientId, stationId, name]);
    return clientId;
  }

  /** An advert with a campaign: by default ACTIVE from 10 days ago for 30 days, airing every day 06:00–09:00 and 22:00–01:00. */
  async function airedAd(stationId: string, clientId: string, title: string, campaign: { status?: string; startsDaysAgo?: number; endsInDays?: number } = {}): Promise<AiredAd> {
    const adId = randomUUID();
    const cardId = randomUUID();
    const campaignId = randomUUID();
    await setupClient.query(`INSERT INTO app.action_cards (id, station_id, client_id, schema_version, content) VALUES ($1, $2, $3, 1, '{"schema_version":1}')`, [cardId, stationId, clientId]);
    await setupClient.query(`INSERT INTO app.ads (id, station_id, client_id, title, status, current_action_card_id) VALUES ($1, $2, $3, $4, 'READY', $5)`, [adId, stationId, clientId, title, cardId]);
    await setupClient.query(
      `INSERT INTO app.campaigns (id, station_id, ad_id, action_card_id, name, status, active_period)
       VALUES ($1, $2, $3, $4, $5, $6, tstzrange(now() - make_interval(days => $7), now() + make_interval(days => $8)))`,
      [campaignId, stationId, adId, cardId, title, campaign.status ?? 'ACTIVE', campaign.startsDaysAgo ?? 10, campaign.endsInDays ?? 20],
    );
    for (const [start, end] of [['06:00', '09:00'], ['22:00', '01:00']]) {
      await setupClient.query('INSERT INTO app.campaign_time_windows (campaign_id, station_id, days_of_week, local_start_time, local_end_time) VALUES ($1, $2, $3, $4, $5)', [
        campaignId,
        stationId,
        EVERY_DAY,
        start,
        end,
      ]);
    }
    return { adId, campaignId, cardId };
  }

  /** A recognition of the advert, heard a moment ago (never before the station's midnight) unless told otherwise. */
  async function heard(stationId: string, ad: AiredAd, heardAt = new Date(Math.max(Date.now() - 60_000, todayStartedAt))) {
    const id = randomUUID();
    const receivedAt = new Date(Math.min(heardAt.getTime() + 60_000, Date.now()));
    await setupClient.query(
      `INSERT INTO app.recognition_events (id, listener_install_id, idempotency_key, request_id, captured_at, received_at, is_deferred, outcome, resolution, station_id, campaign_id)
       VALUES ($1, $2, $3, 'client-test', $4, $5, false, 'MATCH', 'SINGLE_OWNER', $6, $7)`,
      [id, await resolutionData.createInstall(), randomUUID(), heardAt, receivedAt, stationId, ad.campaignId],
    );
    return { id, receivedAt };
  }

  async function tapped(stationId: string, ad: AiredAd, actionType: 'CALL' | 'WHATSAPP' | 'MAP' | 'LINK') {
    const recognition = await heard(stationId, ad);
    await setupClient.query(
      `INSERT INTO app.engagement_events (id, received_at, recognition_id, recognition_received_at, station_id, campaign_id, action_card_id, card_kind,
                                          action_id, action_type, occurred_at, client_occurred_at, clock_skew_milliseconds, is_counted, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'CAMPAIGN', $8, $9, $2, $2, 0, true, 'client-test')`,
      [randomUUID(), recognition.receivedAt, recognition.id, recognition.receivedAt, stationId, ad.campaignId, ad.cardId, randomUUID(), actionType],
    );
  }

  beforeAll(async () => {
    const config = { ...loadAppConfig(), NOTIFICATION_SENDING_ENABLED: true, NOTIFICATION_RETRY_DELAY_MILLISECONDS: 20 };
    testApplication = await createTestApplication({
      overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config).overrideProvider(EMAIL_SENDER).useValue(emails),
    });
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
    resolutionData = new StationResolutionTestData(setupClient);
    ownerA = await testUsers.create();
    analystA = await testUsers.create({ joinStationId: ownerA.stationId, role: 'ANALYST' });
    ownerB = await testUsers.create();
    await setupClient.query(
      `UPDATE app.stations SET time_zone = 'Africa/Lusaka', contact_name = 'Mwila Banda', contact_phone_number_e164 = '+447700900123' WHERE id = ANY($1)`,
      [[ownerA.stationId, ownerB.stationId]],
    );
    todayStartedAt = (await setupClient.query(`SELECT ((now() AT TIME ZONE 'Africa/Lusaka')::date::timestamp AT TIME ZONE 'Africa/Lusaka') AS started_at`)).rows[0].started_at.getTime();

    brandAAtA = await newClient(ownerA.stationId, 'Brand A');
    brandOtherAtA = await newClient(ownerA.stationId, 'Brand Other');
    brandAAtB = await newClient(ownerB.stationId, 'Brand A');
    ads = {
      live: await airedAd(ownerA.stationId, brandAAtA, 'Summer service offer'),
      ended: await airedAd(ownerA.stationId, brandAAtA, '=Winter offer', { status: 'ENDED', startsDaysAgo: 40, endsInDays: -10 }),
      draft: await airedAd(ownerA.stationId, brandAAtA, 'Draft offer', { status: 'DRAFT' }),
      otherClient: await airedAd(ownerA.stationId, brandOtherAtA, 'Other brand offer'),
      atStationB: await airedAd(ownerB.stationId, brandAAtB, 'Summer offer on B'),
    };
    // Today: the live advert heard 3 times on its own and tapped once per button type, plus a second call; another
    // client's advert at the same station heard and called; station B's advert heard twice.
    for (let index = 0; index < 3; index++) await heard(ownerA.stationId, ads.live);
    for (const actionType of ['CALL', 'CALL', 'WHATSAPP', 'MAP', 'LINK'] as const) await tapped(ownerA.stationId, ads.live, actionType);
    for (let index = 0; index < 4; index++) await tapped(ownerA.stationId, ads.otherClient, 'CALL');
    for (let index = 0; index < 2; index++) await heard(ownerB.stationId, ads.atStationB);
    // The ended advert, heard 15 days ago, inside its own dates.
    await heard(ownerA.stationId, ads.ended, new Date(todayStartedAt - 15 * DAY + 10 * HOUR));

    follower = await testUsers.createClientViewer(ownerA.stationId, brandAAtA);
    await testUsers.addClientAccess(follower.userId, ownerB.stationId, brandAAtB);
  }, 120_000);

  afterAll(async () => {
    await setupClient.query('DELETE FROM app.audit_events WHERE actor_portal_user_id = ANY($1)', [createdUserIds]);
    await setupClient.query('DELETE FROM app.engagement_events WHERE request_id = $1', ['client-test']);
    await setupClient.query('DELETE FROM app.recognition_events WHERE request_id = $1', ['client-test']);
    await testUsers.cleanUp();
    await setupClient.query('DELETE FROM app.portal_users WHERE id = ANY($1)', [createdUserIds]);
    await setupClient.end();
    await testApplication.close();
  });

  // ---- the station's side and the invitation -------------------------------------------------------------------------

  describe('inviting a client (the station)', () => {
    it('P5C-INVITATIONS-01, P5C-ONBOARDING-04: an owner invites by email; one email, worded like the team invitation, names the station and the client; what is kept is a hash', async () => {
      const cookie = await signedIn(ownerA);
      const email = newEmail('brand.a');
      const response = await at(cookie, 'post', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers/invitations`).send({ email }).expect(201);
      const list = response.body as ClientViewerAccessList;
      expect(list).toMatchObject({ clientId: brandAAtA, clientName: 'Brand A', canManage: true });
      expect(list.pendingInvitations).toEqual([expect.objectContaining({ email, isExpired: false })]);
      expect(JSON.stringify(list)).not.toMatch(/token/i);
      const token = await lastTokenTo(email, 1);
      const [sent] = emailsTo(email);
      expect(sent?.subject).toBe("You're invited to view Brand A's adverts on Look Up");
      expect(sent?.text).toMatch(/^Test Station \S+ \(98\.1 FM\) has invited you to view Brand A's adverts on Look Up/);
      // The same closing line as the team's invitation (P5C-ONBOARDING-04).
      expect(sent?.text).toMatch(/The invitation works once and lasts 7 days\.$/);
      const stored = await setupClient.query(`SELECT kind, client_id, station_role, token_hash FROM app.invitations WHERE station_id = $1 AND invited_email = $2`, [ownerA.stationId, email]);
      expect(stored.rows).toEqual([{ kind: 'CLIENT_VIEWER', client_id: brandAAtA, station_role: null, token_hash: expect.any(Buffer) }]);
      expect(stored.rows[0].token_hash.toString('base64url')).not.toBe(token);
    });

    it('P5C-ONBOARDING-01: adding a client with an email invites it in the same step', async () => {
      const cookie = await signedIn(ownerA);
      const email = newEmail('new.brand');
      const response = await at(cookie, 'post', `/stations/${ownerA.stationId}/clients`).send({ name: `Brand ${randomUUID().slice(0, 6)}`, email }).expect(201);
      expect(response.body).toMatchObject({ invitedEmail: email });
      await lastTokenTo(email, 1);
      const list = (await at(cookie, 'get', `/stations/${ownerA.stationId}/clients`).expect(200)).body as Array<{ id: string; pendingInvitationCount: number; viewerCount: number }>;
      expect(list.find((client) => client.id === response.body.id)).toMatchObject({ pendingInvitationCount: 1, viewerCount: 0 });
      // Without an email nothing is invited.
      const plain = await at(cookie, 'post', `/stations/${ownerA.stationId}/clients`).send({ name: `Brand ${randomUUID().slice(0, 6)}` }).expect(201);
      expect(plain.body.invitedEmail).toBeNull();
    });

    it('P5C-ONBOARDING-01: a refused invitation adds no client: at the day\'s invitation limit, adding a client with an email is refused and nothing is added', async () => {
      const limited = await testUsers.create();
      const cookie = await signedIn(limited);
      const clientId = await newClient(limited.stationId, 'Busy brand');
      for (let index = 0; index < 20; index++) {
        await at(cookie, 'post', `/stations/${limited.stationId}/clients/${clientId}/viewers/invitations`).send({ email: newEmail(`many${index}`) }).expect(201);
      }
      const name = `Refused brand ${randomUUID().slice(0, 6)}`;
      const refused = await at(cookie, 'post', `/stations/${limited.stationId}/clients`).send({ name, email: newEmail('one.too.many') });
      expect(refused.status).toBe(429);
      assertErrorEnvelope(refused.body);
      expect((await setupClient.query('SELECT 1 FROM app.clients WHERE station_id = $1 AND name = $2', [limited.stationId, name])).rows).toEqual([]);
    });

    it('P5C-ONBOARDING-05: an email that already views the client is refused; Send again replaces the link (the old one stops working) and gives another 7 days', async () => {
      const cookie = await signedIn(ownerA);
      const already = await at(cookie, 'post', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers/invitations`).send({ email: follower.email });
      expect(already.status).toBe(409);
      expect(already.body.error.code).toBe('CLIENT_VIEWER_ALREADY_HAS_ACCESS');
      assertErrorEnvelope(already.body);

      const email = newEmail('resent');
      const invited = (await at(cookie, 'post', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers/invitations`).send({ email }).expect(201)).body as ClientViewerAccessList;
      const firstToken = await lastTokenTo(email, 1);
      const invitation = invited.pendingInvitations.find((pending) => pending.email === email);
      await setupClient.query(`UPDATE app.invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [invitation?.id]);
      const expiredList = (await at(cookie, 'get', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers`).expect(200)).body as ClientViewerAccessList;
      expect(expiredList.pendingInvitations.find((pending) => pending.email === email)?.isExpired).toBe(true);

      const resent = (await at(cookie, 'post', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers/invitations/${invitation?.id}/resending`).expect(200)).body as ClientViewerAccessList;
      const fresh = resent.pendingInvitations.filter((pending) => pending.email === email);
      expect(fresh).toHaveLength(1);
      expect(fresh[0]?.isExpired).toBe(false);
      expect(new Date(fresh[0]?.expiresAt as string).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
      const secondToken = await lastTokenTo(email, 2);
      expect(secondToken).not.toBe(firstToken);
      expect((await publicly('/invitations/description').send({ token: firstToken })).body.state).toBe('REVOKED');
      expect((await publicly('/invitations/description').send({ token: secondToken }).expect(200)).body).toMatchObject({ kind: 'CLIENT_VIEWER', state: 'OPEN' });
    });

    it('P5C-ONBOARDING-02: every member sees who can view a client; an analyst can neither invite, send again, cancel nor remove', async () => {
      const analystCookie = await signedIn(analystA);
      const list = (await at(analystCookie, 'get', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers`).expect(200)).body as ClientViewerAccessList;
      expect(list.canManage).toBe(false);
      expect(list.people).toEqual(expect.arrayContaining([expect.objectContaining({ portalUserId: follower.userId, email: follower.email, fullName: 'Chipo Client' })]));
      const invitationId = randomUUID();
      for (const [method, path] of [
        ['post', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers/invitations`],
        ['post', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers/invitations/${invitationId}/resending`],
        ['post', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers/invitations/${invitationId}/revocation`],
        ['delete', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers/${follower.userId}`],
      ] as const) {
        const refused = await at(analystCookie, method, path).send({ email: newEmail('x') });
        expect(refused.status, path).toBe(403);
        assertErrorEnvelope(refused.body);
      }
      // Another station's owner learns nothing about this client.
      const otherOwner = await signedIn(ownerB);
      expect((await at(otherOwner, 'get', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers`)).status).toBe(404);
      expect((await at(otherOwner, 'get', `/stations/${ownerB.stationId}/clients/${brandAAtA}/viewers`)).status).toBe(404);
    });
  });

  describe('accepting (the client)', () => {
    it('P5C-INVITATIONS-02: the link says it is a client invitation; the invitee makes an account, is signed in, and follows the client at that station', async () => {
      const ownerCookie = await signedIn(ownerA);
      const email = newEmail('newcomer');
      await at(ownerCookie, 'post', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers/invitations`).send({ email }).expect(201);
      const token = await lastTokenTo(email, 1);
      const described = (await publicly('/invitations/description').send({ token }).expect(200)).body;
      expect(described).toMatchObject({ kind: 'CLIENT_VIEWER', state: 'OPEN', clientName: 'Brand A', role: null, invitedEmail: email, hasAccount: false });
      const accepted = await publicly('/invitations/acceptance-with-new-account').send({ token, fullName: 'Thandiwe Phiri', mobileNumber: null, password: `golden maize ${randomUUID().slice(0, 6)} harvest` }).expect(201);
      expect(accepted.body).toEqual({ kind: 'CLIENT_VIEWER', stationId: ownerA.stationId, clientId: brandAAtA });
      const cookie = cookieHeader(cookiesSetBy(accepted));
      const me = (await at(cookie, 'get', '/auth/me').expect(200)).body;
      createdUserIds.push(me.user.id);
      expect(me.stations).toEqual([]);
      expect(me.clientAccesses).toEqual([{ stationId: ownerA.stationId, stationName: expect.stringMatching(/^Test Station /), frequencyLabel: '98.1 FM', clientId: brandAAtA, clientName: 'Brand A' }]);
      const home = (await at(cookie, 'get', '/client/home').expect(200)).body as ClientHome;
      expect(home.stations.map((station) => station.stationId)).toEqual([ownerA.stationId]);
      // The link works once.
      expect((await publicly('/invitations/acceptance-with-new-account').send({ token, fullName: 'Again', mobileNumber: null, password: 'another long password phrase' })).status).toBe(400);
    });

    it('P5C-ONBOARDING-03: an email with an account (invited by a second station) signs in to accept, and one login sees both stations; another email signed in is told so', async () => {
      const person = await testUsers.createClientViewer(ownerA.stationId, brandAAtA);
      const ownerCookie = await signedIn(ownerB);
      await at(ownerCookie, 'post', `/stations/${ownerB.stationId}/clients/${brandAAtB}/viewers/invitations`).send({ email: person.email }).expect(201);
      const token = await lastTokenTo(person.email, 1);
      expect((await publicly('/invitations/description').send({ token }).expect(200)).body).toMatchObject({ kind: 'CLIENT_VIEWER', hasAccount: true });
      expect((await publicly('/invitations/acceptance-with-new-account').send({ token, fullName: 'X', mobileNumber: null, password: 'a long enough password phrase' })).body.error.code).toBe('EMAIL_ALREADY_REGISTERED');

      const someoneElse = await signedIn(ownerA);
      const wrong = await at(someoneElse, 'post', '/invitations/acceptance').send({ token });
      expect(wrong.status).toBe(403);
      expect(wrong.body.error.code).toBe('INVITATION_FOR_ANOTHER_EMAIL');

      const cookie = await signedIn(person);
      expect((await at(cookie, 'post', '/invitations/acceptance').send({ token }).expect(200)).body).toEqual({ kind: 'CLIENT_VIEWER', stationId: ownerB.stationId, clientId: brandAAtB });
      const home = (await at(cookie, 'get', '/client/home').expect(200)).body as ClientHome;
      expect(home.stations.map((station) => station.stationId).sort()).toEqual([ownerA.stationId, ownerB.stationId].sort());
    });

    it('P5C-INVITATIONS-03: inviting, accepting, cancelling and removing each write one audit row naming the client and the station, with the request id, and no email', async () => {
      const ownerCookie = await signedIn(ownerA);
      const email = newEmail('audited');
      const invited = await at(ownerCookie, 'post', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers/invitations`).send({ email }).expect(201);
      const token = await lastTokenTo(email, 1);
      const accepted = await publicly('/invitations/acceptance-with-new-account').send({ token, fullName: 'Audit Person', mobileNumber: null, password: `copper river ${randomUUID().slice(0, 6)} morning` }).expect(201);
      const personId = (await at(cookieHeader(cookiesSetBy(accepted)), 'get', '/auth/me').expect(200)).body.user.id as string;
      createdUserIds.push(personId);
      const secondEmail = newEmail('cancelled');
      const second = (await at(ownerCookie, 'post', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers/invitations`).send({ email: secondEmail }).expect(201)).body as ClientViewerAccessList;
      const pending = second.pendingInvitations.find((invitation) => invitation.email === secondEmail);
      await at(ownerCookie, 'post', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers/invitations/${pending?.id}/revocation`).expect(200);
      await at(ownerCookie, 'delete', `/stations/${ownerA.stationId}/clients/${brandAAtA}/viewers/${personId}`).expect(200);
      const rows = (await setupClient.query(
        `SELECT action, station_id, request_id, changes FROM app.audit_events
          WHERE station_id = $1 AND action LIKE 'client_viewer_%' AND (changes ->> 'client_id' = $2 OR (action = 'client_viewer_removed' AND entity_id = $2::uuid))
            AND occurred_at > now() - interval '1 minute'
          ORDER BY occurred_at`,
        [ownerA.stationId, brandAAtA],
      )).rows as Array<{ action: string; station_id: string; request_id: string; changes: unknown }>;
      const actions = rows.map((row) => row.action);
      expect(actions).toEqual(expect.arrayContaining(['client_viewer_invitation_created', 'client_viewer_invitation_accepted', 'client_viewer_invitation_revoked', 'client_viewer_removed']));
      expect(invited.headers['x-request-id']).toBeTruthy();
      expect(rows.some((row) => row.request_id === invited.headers['x-request-id'])).toBe(true);
      for (const row of rows) {
        expect(row.station_id).toBe(ownerA.stationId);
        expect(JSON.stringify(row)).not.toContain('@');
      }
    });
  });

  // ---- the client area -----------------------------------------------------------------------------------------------

  describe('what a client sees', () => {
    it('P5C-DASHBOARD-02, P5C-TESTS-01: one person following a client at two stations sees two sections, each with only its own adverts and numbers, never added together', async () => {
      const cookie = await signedIn(follower);
      const home = (await at(cookie, 'get', '/client/home').expect(200)).body as ClientHome;
      const sectionA = home.stations.find((station) => station.stationId === ownerA.stationId);
      const sectionB = home.stations.find((station) => station.stationId === ownerB.stationId);
      expect(home.stations).toHaveLength(2);
      expect(sectionA?.ads.map((ad) => ad.title)).toEqual(['=Winter offer', 'Summer service offer']);
      expect(sectionB?.ads.map((ad) => ad.title)).toEqual(['Summer offer on B']);
      // P5C-DASHBOARD-07: the last 7 days for this client at this station: 3 heard plus the 5 that led to taps.
      expect(sectionA?.lastSevenDays).toEqual({ heard: 8, calls: 2, whatsApp: 1, directions: 1, website: 1 });
      expect(sectionB?.lastSevenDays).toEqual({ heard: 2, calls: 0, whatsApp: 0, directions: 0, website: 0 });
      expect(Object.keys(home)).toEqual(['stations']);
      expect(sectionA?.contact).toEqual({ name: 'Mwila Banda', phoneNumberE164: '+447700900123' });
      expect(sectionA?.clients).toEqual([{ id: brandAAtA, name: 'Brand A' }]);
    });

    it('P5C-DASHBOARD-03, P5C-DASHBOARD-08: a draft is never shown; each advert has its status, dates and slots', async () => {
      const cookie = await signedIn(follower);
      const home = (await at(cookie, 'get', '/client/home').expect(200)).body as ClientHome;
      const sectionA = home.stations.find((station) => station.stationId === ownerA.stationId);
      expect(JSON.stringify(home)).not.toContain('Draft offer');
      const live = sectionA?.ads.find((ad) => ad.id === ads.live.adId);
      expect(live).toMatchObject({ status: expect.stringMatching(/^(LIVE_NOW|SCHEDULED)$/), heardLastSevenDays: 8 });
      expect(live?.timeWindows).toEqual([
        { daysOfWeek: EVERY_DAY, localStartTime: '06:00', localEndTime: '09:00' },
        { daysOfWeek: EVERY_DAY, localStartTime: '22:00', localEndTime: '01:00' },
      ]);
      expect(sectionA?.ads.find((ad) => ad.id === ads.ended.adId)).toMatchObject({ status: 'ENDED', nextOnAir: null });
      const draft = await at(cookie, 'get', `/client/stations/${ownerA.stationId}/ads/${ads.draft.adId}`);
      expect(draft.status).toBe(404);
    });

    it('P5C-ADVERT-01: the next times on air follow the station\'s clock: the next 5 slots in order, a slot past midnight ending the next day', async () => {
      const cookie = await signedIn(follower);
      const detail = (await at(cookie, 'get', `/client/stations/${ownerA.stationId}/ads/${ads.live.adId}`).expect(200)).body as ClientAdDetail;
      expect(detail.nextTimesOnAir).toHaveLength(5);
      const starts = detail.nextTimesOnAir.map((slot) => new Date(slot.startsAt).getTime());
      expect(starts).toEqual([...starts].sort((first, second) => first - second));
      expect(starts[0]).toBeGreaterThan(Date.now());
      for (const slot of detail.nextTimesOnAir) {
        expect(['06:00', '22:00']).toContain(slot.localStartTime);
        const hours = (new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime()) / HOUR;
        expect(hours).toBe(3);
        // Lusaka is UTC+2 all year: the slot's local start is its instant plus two hours.
        expect(new Date(new Date(slot.startsAt).getTime() + 2 * HOUR).toISOString().slice(11, 16)).toBe(slot.localStartTime);
      }
      expect(detail.nextOnAir).toEqual(detail.nextTimesOnAir[0]);
      const home = (await at(cookie, 'get', '/client/home').expect(200)).body as ClientHome;
      expect(home.stations.find((station) => station.stationId === ownerA.stationId)?.nextOnAir).toMatchObject({ ...detail.nextTimesOnAir[0], adId: ads.live.adId, adTitle: 'Summer service offer' });
    });

    it('P5C-ADVERT-02: an advert\'s figures count only that advert at that station, for today, 7 and 30 days', async () => {
      const cookie = await signedIn(follower);
      for (const range of ['today', 'last7Days', 'last30Days']) {
        const figures = (await at(cookie, 'get', `/client/stations/${ownerA.stationId}/ads/${ads.live.adId}/figures?range=${range}`).expect(200)).body;
        expect(figures, range).toMatchObject({ range, heard: 8, calls: 2, whatsApp: 1, directions: 1, website: 1 });
      }
      const ended = (await at(cookie, 'get', `/client/stations/${ownerA.stationId}/ads/${ads.ended.adId}/figures?range=last7Days`).expect(200)).body;
      expect(ended).toMatchObject({ heard: 0 });
      expect((await at(cookie, 'get', `/client/stations/${ownerA.stationId}/ads/${ads.ended.adId}/figures?range=last30Days`).expect(200)).body).toMatchObject({ heard: 1 });
    });

    it('P5C-ADVERT-03: who is listening to an advert keeps the small-group rule: below 10 known listeners there is no breakdown, and nothing names a listener', async () => {
      const cookie = await signedIn(follower);
      const mix = (await at(cookie, 'get', `/client/stations/${ownerA.stationId}/ads/${ads.live.adId}/listener-mix?range=last7Days`).expect(200)).body;
      expect(mix).toMatchObject({ listeners: 8, knownListeners: 0, notKnownYetListeners: 8, genders: null, ageBands: null });
      expect(JSON.stringify(mix)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    });

    it('P5C-ACCESS-01: a client request runs in a transaction with the person set and no station, so station row-level security shows it nothing', async () => {
      const transaction = testApplication.application.get(StationScopedTransaction);
      const realRun = transaction.run.bind(transaction);
      const seen: Array<{ station: string; person: string }> = [];
      const spy = vi.spyOn(transaction, 'run').mockImplementation(((work: (database: EntityManager) => Promise<unknown>, scope?: Parameters<StationScopedTransaction['run']>[1]) =>
        realRun(async (database) => {
          const [settings] = (await database.query(`SELECT current_setting('app.current_station_id', true) AS station, current_setting('app.current_user_id', true) AS person`)) as Array<{ station: string; person: string }>;
          if (settings) seen.push(settings);
          return work(database);
        }, scope)) as StationScopedTransaction['run']);
      try {
        const cookie = await signedIn(follower);
        await at(cookie, 'get', '/client/home').expect(200);
        await at(cookie, 'get', `/client/stations/${ownerA.stationId}/ads/${ads.live.adId}`).expect(200);
        await at(cookie, 'get', `/client/stations/${ownerA.stationId}/ads/${ads.live.adId}/figures?range=today`).expect(200);
      } finally {
        spy.mockRestore();
      }
      const followers = seen.filter((settings) => settings.person === follower.userId);
      expect(followers.length).toBeGreaterThanOrEqual(4);
      expect(followers.filter((settings) => settings.station !== '')).toEqual([]);
    });

    it("P5C-PRIVACY-01: every client response holds only the fields a client may see: no limits, counters, notes, audio or another client's ids", async () => {
      const cookie = await signedIn(follower);
      const responses = [
        (await at(cookie, 'get', '/client/home').expect(200)).body,
        (await at(cookie, 'get', `/client/stations/${ownerA.stationId}/ads/${ads.live.adId}`).expect(200)).body,
        (await at(cookie, 'get', `/client/stations/${ownerA.stationId}/ads/${ads.live.adId}/figures?range=last30Days`).expect(200)).body,
        (await at(cookie, 'get', `/client/stations/${ownerA.stationId}/ads/${ads.live.adId}/listener-mix?range=last30Days`).expect(200)).body,
        (await at(cookie, 'get', '/client/notification-settings').expect(200)).body,
      ];
      for (const body of responses) {
        expect([...keysIn(body)].filter((key) => !CLIENT_RESPONSE_KEYS.has(key))).toEqual([]);
        const text = JSON.stringify(body);
        for (const internal of [brandOtherAtA, ads.otherClient.adId, ads.otherClient.campaignId, ads.live.campaignId, ads.draft.adId]) expect(text).not.toContain(internal);
      }
      expect(ListenerMix.parse(responses[3])).toEqual(responses[3]);
    });

    it('P5C-ADVERT-04: an advert\'s page has the card listeners see and the station\'s contact', async () => {
      const cookie = await signedIn(follower);
      const detail = (await at(cookie, 'get', `/client/stations/${ownerA.stationId}/ads/${ads.live.adId}`).expect(200)).body as ClientAdDetail;
      expect(detail.actionCard).toEqual({ schema_version: 1 });
      expect(detail.station).toMatchObject({ id: ownerA.stationId, frequencyLabel: '98.1 FM', contact: { name: 'Mwila Banda', phoneNumberE164: '+447700900123' } });
      expect(JSON.stringify(detail)).not.toMatch(/engagement_limit|engagementLimit|grace|audio_asset|audioAsset/);
    });

    it('P5C-ACCESS-04, P5C-TESTS-03: another client\'s advert at the same station, another station\'s advert, a station not followed and invented ids all answer 404', async () => {
      const cookie = await signedIn(follower);
      const strangerStation = await testUsers.create();
      for (const path of [
        `/client/stations/${ownerA.stationId}/ads/${ads.otherClient.adId}`,
        `/client/stations/${ownerA.stationId}/ads/${ads.otherClient.adId}/figures`,
        `/client/stations/${ownerA.stationId}/ads/${ads.otherClient.adId}/listener-mix`,
        `/client/stations/${ownerA.stationId}/ads/${ads.atStationB.adId}`,
        `/client/stations/${strangerStation.stationId}/ads/${ads.live.adId}`,
        `/client/stations/${strangerStation.stationId}/export.csv`,
        `/client/stations/${ownerA.stationId}/ads/${randomUUID()}`,
        `/client/stations/not-a-station/ads/${ads.live.adId}`,
        `/client/stations/${ownerA.stationId}/ads/not-an-advert`,
      ]) {
        const response = await at(cookie, 'get', path);
        expect(response.status, path).toBe(404);
        assertErrorEnvelope(response.body);
      }
      const home = (await at(cookie, 'get', '/client/home').expect(200)).body as ClientHome;
      expect(JSON.stringify(home)).not.toContain('Other brand offer');
      expect(JSON.stringify(home)).not.toContain(brandOtherAtA);
    });

    it('P5C-EXPORT-01: the spreadsheet holds only this client\'s rows at this station, by day, quotes a formula-like title, and is named for the station', async () => {
      const cookie = await signedIn(follower);
      const response = await at(cookie, 'get', `/client/stations/${ownerA.stationId}/export.csv`).buffer(true).parse((stream, done) => {
        let text = '';
        stream.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
        stream.on('end', () => done(null, text));
      }).expect(200);
      expect(response.headers['content-type']).toMatch(/^text\/csv/);
      expect(response.headers['content-disposition']).toMatch(/^attachment; filename="look-up-test-station-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.csv"$/);
      const lines = (response.body as string).replace(/^\uFEFF/, '').trim().split('\r\n');
      expect(lines[0]).toBe('"Day","Advert","Heard","Calls","WhatsApp","Directions","Website"');
      expect(lines.slice(1)).toHaveLength(2);
      expect(lines.some((line) => line.includes(`"Summer service offer",8,2,1,1,1`))).toBe(true);
      expect(lines.some((line) => line.includes(`"'=Winter offer",1,0,0,0,0`))).toBe(true);
      expect(response.body).not.toContain('Other brand offer');
      expect(response.body).not.toContain('Summer offer on B');
    });

    it('P5C-ONBOARDING-06: removing access takes effect on the next request: the station leaves the home and its pages answer 404', async () => {
      const person = await testUsers.createClientViewer(ownerA.stationId, brandAAtA);
      await testUsers.addClientAccess(person.userId, ownerB.stationId, brandAAtB);
      const cookie = await signedIn(person);
      expect(((await at(cookie, 'get', '/client/home').expect(200)).body as ClientHome).stations).toHaveLength(2);
      const ownerCookie = await signedIn(ownerB);
      const list = (await at(ownerCookie, 'delete', `/stations/${ownerB.stationId}/clients/${brandAAtB}/viewers/${person.userId}`).expect(200)).body as ClientViewerAccessList;
      expect(list.people.map((viewer) => viewer.portalUserId)).not.toContain(person.userId);
      const home = (await at(cookie, 'get', '/client/home').expect(200)).body as ClientHome;
      expect(home.stations.map((station) => station.stationId)).toEqual([ownerA.stationId]);
      expect((await at(cookie, 'get', `/client/stations/${ownerB.stationId}/ads/${ads.atStationB.adId}`)).status).toBe(404);
      // With nothing left, the home is empty (the portal says to ask the station again).
      await setupClient.query('DELETE FROM app.client_viewers WHERE portal_user_id = $1', [person.userId]);
      expect(((await at(cookie, 'get', '/client/home').expect(200)).body as ClientHome).stations).toEqual([]);
    });
  });

  describe('who is listening, in groups', () => {
    const listenerAccountIds: string[] = [];
    afterAll(async () => {
      await setupClient.query('DELETE FROM app.listener_accounts WHERE id = ANY($1)', [listenerAccountIds]);
    });

    /** [count] listeners of one gender and age, each with an account and a phone that heard [ad]. */
    async function knownListenersHeard(ad: AiredAd, count: number, gender: 'FEMALE' | 'MALE', age: number) {
      for (let index = 0; index < count; index++) {
        const accountId = (
          await setupClient.query(
            `INSERT INTO app.listener_accounts (email_hash, email_sealed, gender, birth_year, consent_text_version) VALUES ($1, $2, $3, $4, 'listener-consent-2026-10') RETURNING id`,
            [randomBytes(32), randomBytes(40), gender, new Date().getUTCFullYear() - age],
          )
        ).rows[0].id as string;
        listenerAccountIds.push(accountId);
        const installId = await resolutionData.createInstall();
        await setupClient.query('UPDATE app.listener_installs SET listener_account_id = $2 WHERE id = $1', [installId, accountId]);
        const heardAt = new Date(Math.max(Date.now() - 60_000, todayStartedAt));
        await setupClient.query(
          `INSERT INTO app.recognition_events (id, listener_install_id, idempotency_key, request_id, captured_at, received_at, is_deferred, outcome, resolution, station_id, campaign_id)
           VALUES ($1, $2, $3, 'client-test', $4, $4, false, 'MATCH', 'SINGLE_OWNER', $5, $6)`,
          [randomUUID(), installId, randomUUID(), heardAt, ownerA.stationId, ad.campaignId],
        );
      }
    }

    it('P5C-ADVERT-03: at 9 known listeners a client sees no breakdown; at 25 the gender and age groups, in the shape the contract allows', async () => {
      const brandMix = await newClient(ownerA.stationId, 'Brand Mix');
      const ad = await airedAd(ownerA.stationId, brandMix, 'Mix offer');
      const person = await testUsers.createClientViewer(ownerA.stationId, brandMix);
      const cookie = await signedIn(person);
      const mixPath = `/client/stations/${ownerA.stationId}/ads/${ad.adId}/listener-mix?range=last7Days`;
      await knownListenersHeard(ad, 9, 'FEMALE', 30);
      const atNine = ListenerMix.parse((await at(cookie, 'get', mixPath).expect(200)).body);
      expect(atNine).toMatchObject({ listeners: 9, knownListeners: 9, notKnownYetListeners: 0, genders: null, ageBands: null });
      await knownListenersHeard(ad, 6, 'FEMALE', 30);
      await knownListenersHeard(ad, 10, 'MALE', 40);
      const atTwentyFive = ListenerMix.parse((await at(cookie, 'get', mixPath).expect(200)).body);
      const byGroup = (groups: Array<{ group: string; listeners: number }> | null) => Object.fromEntries((groups ?? []).filter((group) => group.listeners > 0).map((group) => [group.group, group.listeners]));
      expect(atTwentyFive).toMatchObject({ listeners: 25, knownListeners: 25, notKnownYetListeners: 0 });
      expect(byGroup(atTwentyFive.genders)).toEqual({ FEMALE: 15, MALE: 10 });
      expect(byGroup(atTwentyFive.ageBands)).toEqual({ AGE_25_TO_34: 15, AGE_35_TO_44: 10 });
      expect(JSON.stringify(atTwentyFive)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      // The follower of Brand A never sees Brand Mix's advert.
      expect((await at(await signedIn(follower), 'get', mixPath)).status).toBe(404);
    });
  });

  describe('notification settings', () => {
    it('P5C-NOTIFY-01: the defaults, then saved settings and muted adverts (only the person\'s own) that survive signing out', async () => {
      const person = await testUsers.createClientViewer(ownerA.stationId, brandAAtA);
      let cookie = await signedIn(person);
      const defaults = (await at(cookie, 'get', '/client/notification-settings').expect(200)).body as ClientNotificationSettings;
      expect(defaults).toMatchObject({ isPushOn: true, isEmailOn: false, leadMinutes: 15, mutedAds: [], isPushAvailable: false, pushPublicKey: null });
      expect(defaults.ads.map((ad) => ad.title).sort()).toEqual(['=Winter offer', 'Summer service offer']);
      const saved = (await at(cookie, 'put', '/client/notification-settings')
        .send({
          isPushOn: false,
          isEmailOn: true,
          leadMinutes: 30,
          mutedAds: [
            { stationId: ownerA.stationId, adId: ads.live.adId },
            { stationId: ownerA.stationId, adId: ads.otherClient.adId },
            { stationId: ownerB.stationId, adId: ads.atStationB.adId },
          ],
        })
        .expect(200)).body as ClientNotificationSettings;
      expect(saved).toMatchObject({ isPushOn: false, isEmailOn: true, leadMinutes: 30, mutedAds: [{ stationId: ownerA.stationId, adId: ads.live.adId }] });
      await at(cookie, 'post', '/auth/sign-out').expect(204);
      cookie = await signedIn(person);
      expect((await at(cookie, 'get', '/client/notification-settings').expect(200)).body).toMatchObject({ isPushOn: false, isEmailOn: true, leadMinutes: 30 });
      for (const invalid of [{ isPushOn: true, isEmailOn: true, leadMinutes: 10, mutedAds: [] }, { isPushOn: true, isEmailOn: true, leadMinutes: 15, mutedAds: [], extra: 1 }]) {
        const refused = await at(cookie, 'put', '/client/notification-settings').send(invalid);
        expect(refused.status).toBe(400);
        assertErrorEnvelope(refused.body);
      }
      // A station member who follows no client has no settings.
      expect((await at(await signedIn(ownerA), 'get', '/client/notification-settings')).status).toBe(404);
    });
  });

  // ---- what a client may never do ---------------------------------------------------------------------------------------

  describe('what a client may never do', () => {
    it('P5C-ACCESS-02, P5C-ACCESS-03, P5C-TESTS-02: every station and admin route answers 403 or 404 to a client, even at the station they follow; the client routes change only their own things', async () => {
      const cookie = await signedIn(follower);
      const express = testApplication.application.getHttpAdapter().getInstance() as { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } };
      const routes = express.router.stack.flatMap((layer) => (layer.route ? Object.keys(layer.route.methods).map((method) => ({ method, path: layer.route?.path as string })) : []));
      const stationAndAdminRoutes = routes.filter((route) => /^\/api\/v1\/(stations\/:stationId|admin)(\/|$)/.test(route.path));
      expect(stationAndAdminRoutes.length).toBeGreaterThan(40);
      for (const route of stationAndAdminRoutes) {
        const path = route.path
          .replace('/api/v1', '')
          .replace(':stationId', ownerA.stationId)
          .replace(':clientId', brandAAtA)
          .replace(':adId', ads.live.adId)
          .replace(/:[A-Za-z]+/g, () => randomUUID());
        const response = await at(cookie, route.method as 'get', path).send({});
        expect([403, 404], `${route.method.toUpperCase()} ${route.path} answered ${response.status}`).toContain(response.status);
      }
      // Under /client, the only routes that change anything are the person's own settings and devices.
      const clientWrites = routes.filter((route) => route.path.startsWith('/api/v1/client/') && route.method !== 'get').map((route) => `${route.method.toUpperCase()} ${route.path}`);
      for (const write of clientWrites) {
        expect(['PUT /api/v1/client/notification-settings', 'POST /api/v1/client/push-subscriptions', 'POST /api/v1/client/push-subscriptions/removal', 'POST /api/v1/client/test-notification']).toContain(write);
      }
      // And nothing at the station changed.
      const after = (await setupClient.query('SELECT title FROM app.ads WHERE id = $1', [ads.live.adId])).rows[0];
      expect(after.title).toBe('Summer service offer');
    });

    it('P5C-ACCESS-02: someone signed out reaches no client route', async () => {
      for (const path of ['/client/home', `/client/stations/${ownerA.stationId}/ads/${ads.live.adId}`, '/client/notification-settings']) {
        const response = await supertest(server()).get(`/api/v1${path}`).set('X-Forwarded-For', newClientAddress());
        expect(response.status, path).toBe(401);
        assertErrorEnvelope(response.body);
      }
    });
  });
});
