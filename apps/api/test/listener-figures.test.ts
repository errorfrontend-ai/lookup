import { randomInt, randomUUID } from 'node:crypto';
import type { AdSummary, ListenerFigures } from '@lookup/contracts';
import type pg from 'pg';
import supertest from 'supertest';
import { QueryFailedError } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { ListenerFiguresService } from '../src/features/station-overview/listener-figures.service.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { waitForLogWrites } from './support/log-capture.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { StationResolutionTestData } from './support/station-resolution-test-data.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Lusaka is two hours ahead of UTC all year (Zambia keeps no summer time). */
const LUSAKA_OFFSET = 2 * HOUR;

interface HeardSeed {
  stationId: string | null;
  campaignId: string | null;
  outcome: 'MATCH' | 'MATCH_DEFAULT' | 'CHOOSE_STATION' | 'NO_MATCH';
  resolution: 'SINGLE_OWNER' | 'LISTENER_CHOICE' | 'UNRESOLVED' | null;
  heardAt: Date;
  isDeferred?: boolean;
}

/**
 * The station's listener figures (P5B-OVERVIEW-04 to -16) and each ad's last 7 days (P5B-ADS-LIST-11, P5B-AD-DETAIL-06),
 * counted from recognitions and taps written straight to the database at chosen moments of the station's days, then
 * read as real signed-in people. Only the station's own recognitions count: never another station's, never a chooser
 * nobody answered, never a clip that matched nothing.
 */
describe('listener figures', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  let resolutionData: StationResolutionTestData;
  let owner: PortalTestUser;
  let analyst: PortalTestUser;
  let otherStationOwner: PortalTestUser;
  let stationUnderReviewOwner: PortalTestUser;
  let installId: string;
  /** Midnight at the start of the station's today (Lusaka), as an instant. */
  let todayStartedAt: number;
  let ads: Record<'evening' | 'morning' | 'foreign', { adId: string; campaignId: string; cardId: string }>;
  const heardMoments: number[] = [];
  const client = () => supertest(testApplication.application.getHttpServer());
  const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  const sessions = new Map<string, Record<string, string>>();

  async function get(user: PortalTestUser, path: string) {
    let cookies = sessions.get(user.userId);
    if (!cookies) {
      const signedIn = await client().post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).send({ email: user.email, password: user.password });
      expect(signedIn.status).toBe(200);
      cookies = cookiesSetBy(signedIn);
      sessions.set(user.userId, cookies);
    }
    return client().get(path).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookieHeader(cookies));
  }
  const figuresPath = (stationId: string, range?: string) => `/api/v1/stations/${stationId}/listener-figures${range ? `?range=${range}` : ''}`;
  async function figures(range?: string): Promise<ListenerFigures> {
    const response = await get(owner, figuresPath(owner.stationId, range));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as ListenerFigures;
  }

  async function airedAd(stationId: string, title: string) {
    const clientId = randomUUID();
    const adId = randomUUID();
    const cardId = randomUUID();
    const campaignId = randomUUID();
    await setupClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, $3)`, [clientId, stationId, `${title} client`]);
    await setupClient.query(`INSERT INTO app.action_cards (id, station_id, client_id, schema_version, content) VALUES ($1, $2, $3, 1, '{"schema_version":1}')`, [cardId, stationId, clientId]);
    await setupClient.query(`INSERT INTO app.ads (id, station_id, client_id, title, status, current_action_card_id) VALUES ($1, $2, $3, $4, 'READY', $5)`, [adId, stationId, clientId, title, cardId]);
    await setupClient.query(
      `INSERT INTO app.campaigns (id, station_id, ad_id, action_card_id, name, status, active_period) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', tstzrange(now() - interval '40 days', now() + interval '40 days'))`,
      [campaignId, stationId, adId, cardId, title],
    );
    return { adId, campaignId, cardId };
  }

  /** A recognition heard at a moment; received a minute later, or up to 3 hours later when sent from the phone's saved clips (never after now). */
  async function heard(seed: HeardSeed): Promise<{ id: string; receivedAt: Date }> {
    const id = randomUUID();
    const receivedAt = new Date(Math.min(seed.heardAt.getTime() + (seed.isDeferred ? 3 * HOUR : 60_000), Date.now()));
    await setupClient.query(
      `INSERT INTO app.recognition_events (id, listener_install_id, idempotency_key, request_id, captured_at, received_at, is_deferred, outcome, resolution, station_id, campaign_id)
       VALUES ($1, $2, $3, 'figures-test', $4, $5, $6, $7, $8, $9, $10)`,
      [id, installId, randomUUID(), seed.heardAt, receivedAt, seed.isDeferred ?? false, seed.outcome, seed.resolution, seed.stationId, seed.campaignId],
    );
    return { id, receivedAt };
  }

  async function tapped(stationId: string, ad: { campaignId: string; cardId: string }, recognition: { id: string; receivedAt: Date }, tappedAt: Date) {
    await setupClient.query(
      `INSERT INTO app.engagement_events (id, received_at, recognition_id, recognition_received_at, station_id, campaign_id, action_card_id, card_kind,
                                          action_id, action_type, occurred_at, client_occurred_at, clock_skew_milliseconds, is_counted, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'CAMPAIGN', $8, 'CALL', $2, $2, 0, true, 'figures-test')`,
      // A tap comes after its recognition was received (engagement_events_occurred_at_check).
      [randomUUID(), new Date(Math.max(tappedAt.getTime(), recognition.receivedAt.getTime())), recognition.id, recognition.receivedAt, stationId, ad.campaignId, ad.cardId, randomUUID()],
    );
  }

  /** The hour of the day, Lusaka time, of an instant. */
  const lusakaHour = (instant: number) => new Date(instant + LUSAKA_OFFSET).getUTCHours();

  beforeAll(async () => {
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
    resolutionData = new StationResolutionTestData(setupClient);
    owner = await testUsers.create();
    analyst = await testUsers.create({ joinStationId: owner.stationId, role: 'ANALYST' });
    otherStationOwner = await testUsers.create();
    stationUnderReviewOwner = await testUsers.create({ stationStatus: 'PENDING_REVIEW' });
    await setupClient.query(`UPDATE app.stations SET time_zone = 'Africa/Lusaka' WHERE id = ANY($1)`, [[owner.stationId, otherStationOwner.stationId]]);
    installId = await resolutionData.createInstall();
    todayStartedAt = (
      await setupClient.query(`SELECT ((now() AT TIME ZONE 'Africa/Lusaka')::date::timestamp AT TIME ZONE 'Africa/Lusaka') AS started_at`)
    ).rows[0].started_at.getTime();

    ads = {
      evening: await airedAd(owner.stationId, 'Evening offer'),
      morning: await airedAd(owner.stationId, 'Morning offer'),
      foreign: await airedAd(otherStationOwner.stationId, 'Foreign offer'),
    };

    const now = Date.now();
    // Today, a moment ago (never before the station's midnight).
    const earlierToday = new Date(Math.max(now - 60_000, todayStartedAt));
    const alsoToday = new Date(Math.max(now - 120_000, todayStartedAt));
    // Yesterday at 07:30 Lusaka time, and two days ago at 19:15.
    const yesterdayMorning = new Date(todayStartedAt - DAY + 7.5 * HOUR);
    const twoDaysAgoEvening = new Date(todayStartedAt - 2 * DAY + 19.25 * HOUR);
    // Eight days ago: outside the last 7 days, inside the last 30.
    const eightDaysAgo = new Date(todayStartedAt - 8 * DAY + 10 * HOUR);

    const ofOwner = (campaignId: string) => ({ stationId: owner.stationId, campaignId });
    const matchToday = await heard({ ...ofOwner(ads.evening.campaignId), outcome: 'MATCH', resolution: 'SINGLE_OWNER', heardAt: earlierToday });
    const sentLaterToday = await heard({ ...ofOwner(ads.morning.campaignId), outcome: 'MATCH', resolution: 'SINGLE_OWNER', heardAt: alsoToday, isDeferred: true });
    const usualCard = await heard({ ...ofOwner(ads.evening.campaignId), outcome: 'MATCH_DEFAULT', resolution: 'SINGLE_OWNER', heardAt: twoDaysAgoEvening });
    await heard({ ...ofOwner(ads.morning.campaignId), outcome: 'CHOOSE_STATION', resolution: 'LISTENER_CHOICE', heardAt: yesterdayMorning });
    const lastWeek = await heard({ ...ofOwner(ads.evening.campaignId), outcome: 'MATCH', resolution: 'SINGLE_OWNER', heardAt: eightDaysAgo });
    heardMoments.push(earlierToday.getTime(), alsoToday.getTime(), twoDaysAgoEvening.getTime(), yesterdayMorning.getTime());

    // Never counted: a chooser nobody answered, a clip that matched nothing, and another station's match.
    await heard({ stationId: null, campaignId: null, outcome: 'CHOOSE_STATION', resolution: 'UNRESOLVED', heardAt: earlierToday });
    await heard({ stationId: null, campaignId: null, outcome: 'NO_MATCH', resolution: null, heardAt: earlierToday });
    const foreignMatch = await heard({ stationId: otherStationOwner.stationId, campaignId: ads.foreign.campaignId, outcome: 'MATCH', resolution: 'SINGLE_OWNER', heardAt: earlierToday });

    // Three taps in the last 7 days (two today, one two days ago), and one 8 days ago.
    await tapped(owner.stationId, ads.evening, matchToday, new Date(Math.max(now - 30_000, todayStartedAt)));
    await tapped(owner.stationId, ads.evening, usualCard, new Date(twoDaysAgoEvening.getTime() + 2 * 60_000));
    await tapped(owner.stationId, ads.morning, sentLaterToday, new Date(Math.max(now - 20_000, todayStartedAt)));
    await tapped(owner.stationId, ads.evening, lastWeek, new Date(eightDaysAgo.getTime() + 2 * 60_000));
    await tapped(otherStationOwner.stationId, ads.foreign, foreignMatch, new Date(Math.max(now - 10_000, todayStartedAt)));
  });

  afterAll(async () => {
    const stationIds = [owner.stationId, otherStationOwner.stationId];
    await setupClient.query('DELETE FROM app.engagement_events WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = $1', [installId]);
    await setupClient.query('DELETE FROM app.campaigns WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.ads WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.action_cards WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.clients WHERE station_id = ANY($1)', [stationIds]);
    await resolutionData.removeAll();
    await testUsers.cleanUp();
    await setupClient.end();
    await testApplication.close();
  });

  it('P5B-OVERVIEW-04, -06: over the last 7 days a station counts its own recognitions, those sent later and its button taps, and today’s recognitions', async () => {
    const lastSevenDays = await figures('last7Days');
    expect(lastSevenDays).toMatchObject({ range: 'last7Days', recognitionsToday: 2, recognitions: 4, recognitionsSentLater: 1, buttonTaps: 3 });
    // 7 is the default range.
    expect(await figures()).toEqual(lastSevenDays);
  });

  it('P5B-OVERVIEW-02: today and the last 30 days count over their own days, today’s count staying today’s', async () => {
    expect(await figures('today')).toMatchObject({ range: 'today', recognitionsToday: 2, recognitions: 2, recognitionsSentLater: 1, buttonTaps: 2 });
    expect(await figures('last30Days')).toMatchObject({ range: 'last30Days', recognitionsToday: 2, recognitions: 5, recognitionsSentLater: 1, buttonTaps: 4 });
  });

  it('names the first and last of the station’s days counted, today last', async () => {
    const lusakaDay = (instant: number) => new Date(instant + LUSAKA_OFFSET).toISOString().slice(0, 10);
    expect(await figures('last7Days')).toMatchObject({ firstDay: lusakaDay(todayStartedAt - 6 * DAY), lastDay: lusakaDay(todayStartedAt) });
    expect(await figures('today')).toMatchObject({ firstDay: lusakaDay(todayStartedAt), lastDay: lusakaDay(todayStartedAt) });
  });

  it('P5B-OVERVIEW-13: recognitions by hour are counted in the station’s time zone: heard at 07:30 Lusaka time lands in the 07:00 hour', async () => {
    const { recognitionsByHour } = await figures('last7Days');
    expect(recognitionsByHour).toHaveLength(24);
    const expected = Array<number>(24).fill(0);
    for (const moment of heardMoments) expected[lusakaHour(moment)] = (expected[lusakaHour(moment)] ?? 0) + 1;
    expect(recognitionsByHour).toEqual(expected);
    expect(recognitionsByHour[7]).toBeGreaterThanOrEqual(1);
  });

  it('P5B-ADS-LIST-11, P5B-AD-DETAIL-06: each ad carries what listeners did with it over the last 7 days, in the list and on its own page', async () => {
    const listed = await get(owner, `/api/v1/stations/${owner.stationId}/ads?sort=title`);
    expect(listed.status).toBe(200);
    const byTitle = Object.fromEntries((listed.body.ads as AdSummary[]).map((ad) => [ad.title, ad.lastSevenDays]));
    expect(byTitle).toEqual({
      'Evening offer': { heard: 2, heardSentLater: 0, buttonTaps: 2 },
      'Morning offer': { heard: 2, heardSentLater: 1, buttonTaps: 1 },
    });
    const detail = await get(owner, `/api/v1/stations/${owner.stationId}/ads/${ads.morning.adId}`);
    expect(detail.body.lastSevenDays).toEqual({ heard: 2, heardSentLater: 1, buttonTaps: 1 });
    // The other station sees only its own.
    const foreignList = await get(otherStationOwner, `/api/v1/stations/${otherStationOwner.stationId}/ads`);
    expect((foreignList.body.ads as AdSummary[]).map((ad) => ad.lastSevenDays)).toEqual([{ heard: 1, heardSentLater: 0, buttonTaps: 1 }]);
  });

  it('a station with no listeners yet gets zeros, and every hour at 0', async () => {
    const quietOwner = await testUsers.create();
    const response = await get(quietOwner, figuresPath(quietOwner.stationId));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ recognitionsToday: 0, recognitions: 0, recognitionsSentLater: 0, buttonTaps: 0, recognitionsByHour: Array(24).fill(0) });
  });

  it('analysts can read it; another station’s people cannot; a station under review is refused; an unknown range is refused', async () => {
    expect((await get(analyst, figuresPath(owner.stationId))).status).toBe(200);
    const foreign = await get(otherStationOwner, figuresPath(owner.stationId));
    expect(foreign.status).toBe(404);
    assertErrorEnvelope(foreign.body);
    const underReview = await get(stationUnderReviewOwner, figuresPath(stationUnderReviewOwner.stationId));
    expect(underReview.status).toBe(403);
    expect(underReview.body.error.code).toBe('STATION_NOT_ACTIVE');
    const unknownRange = await get(owner, figuresPath(owner.stationId, 'yesterday'));
    expect(unknownRange.status).toBe(400);
    expect(unknownRange.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('P5B-TESTS-13, ALL-ERRORS-02 to -04: a database failure or a programming error underneath is a generic 500, with the stack in the log under the request id', async () => {
    const service = testApplication.application.get(ListenerFiguresService);
    const driverError = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014', severity: 'ERROR' });
    const failures = [new QueryFailedError('SELECT count(*) FROM app.recognition_events', [], driverError), new TypeError("Cannot read properties of undefined (reading 'recognitions')")];
    for (const failure of failures) {
      const spy = vi.spyOn(service, 'read').mockRejectedValueOnce(failure);
      try {
        const response = await get(owner, figuresPath(owner.stationId));
        expect(response.status).toBe(500);
        expect(assertErrorEnvelope(response.body).error).toMatchObject({ code: 'INTERNAL', request_id: response.headers['x-request-id'] });
        await waitForLogWrites();
        const logLine = testApplication.logs.find((line) => line.requestId === response.headers['x-request-id'] && line.level === 50);
        expect((logLine?.err as { stack?: string } | undefined)?.stack, failure.name).toContain(failure.name);
      } finally {
        spy.mockRestore();
      }
    }
  });
});
