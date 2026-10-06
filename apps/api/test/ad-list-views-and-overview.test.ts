import { randomInt, randomUUID } from 'node:crypto';
import { type AdListSort, type AdListView, type AdSummary, ADS_PER_PAGE } from '@lookup/contracts';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

interface CampaignSeed {
  status: 'DRAFT' | 'ACTIVE' | 'ENDED';
  /** Hours from now to the campaign's first and last moment (negative: in the past). */
  startsInHours: number;
  endsInHours: number;
  /** Open at every hour of every day, so an ACTIVE campaign inside its dates is "Live now". */
  alwaysOnAir?: boolean;
  updatedAt?: string;
}

interface AdSeed {
  title: string;
  clientId: string;
  status?: 'AWAITING_UPLOAD' | 'PROCESSING' | 'READY' | 'NEEDS_REVIEW' | 'FAILED';
  uploadExpiresInMinutes?: number;
  processingErrorCode?: string;
  archived?: boolean;
  updatedAt?: string;
  actionCardId?: string;
  campaign?: CampaignSeed;
}

/**
 * The ads list with its tabs, search, client filter, sorts and paging, and the overview and clients
 * counts. Ads are written straight to the database so every state can be set up exactly; the
 * routes are then called as real signed-in people.
 */
describe('ad list views, search, sorting and the overview', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  let owner: PortalTestUser;
  let analyst: PortalTestUser;
  let otherStationOwner: PortalTestUser;
  let stationUnderReviewOwner: PortalTestUser;
  const clients = { brandX: randomUUID(), brandY: randomUUID(), foreign: randomUUID() };
  const sessions = new Map<string, Record<string, string>>();
  const client = () => supertest(testApplication.application.getHttpServer());
  const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

  async function cookiesFor(user: PortalTestUser) {
    const existing = sessions.get(user.userId);
    if (existing) return existing;
    const response = await client()
      .post('/api/v1/auth/sign-in')
      .set('Origin', PORTAL_ORIGIN)
      .set('X-Forwarded-For', newClientAddress())
      .send({ email: user.email, password: user.password });
    expect(response.status).toBe(200);
    const cookies = cookiesSetBy(response);
    sessions.set(user.userId, cookies);
    return cookies;
  }

  async function get(user: PortalTestUser, path: string) {
    // Sign in first: a supertest request built before an await can find the test server closed.
    const cookies = await cookiesFor(user);
    return client().get(path).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookieHeader(cookies));
  }

  const adsPath = (user: PortalTestUser) => `/api/v1/stations/${user.stationId}/ads`;

  async function listAds(user: PortalTestUser, query: Record<string, string> = {}) {
    const response = await get(user, `${adsPath(user)}?${new URLSearchParams(query).toString()}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as { ads: AdSummary[]; nextCursor: string | null };
  }

  const titlesOf = (ads: AdSummary[]) => ads.map((ad) => ad.title);

  async function insertClient(stationId: string, clientId: string, name: string) {
    await setupClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, $3)`, [clientId, stationId, name]);
  }

  async function insertCard(stationId: string, clientId: string) {
    const cardId = randomUUID();
    await setupClient.query(
      `INSERT INTO app.action_cards (id, station_id, client_id, schema_version, content) VALUES ($1, $2, $3, 1, '{"schema_version":1}')`,
      [cardId, stationId, clientId],
    );
    return cardId;
  }

  async function insertAd(stationId: string, seed: AdSeed): Promise<string> {
    const adId = randomUUID();
    await setupClient.query(
      `INSERT INTO app.ads (id, station_id, client_id, title, status, upload_expires_at, processing_error_code, archived_at, current_action_card_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, now() + $6 * interval '1 minute', $7, CASE WHEN $8 THEN now() END, $9, coalesce($10::timestamptz, now()))`,
      [
        adId,
        stationId,
        seed.clientId,
        seed.title,
        seed.status ?? 'READY',
        seed.uploadExpiresInMinutes ?? null,
        seed.processingErrorCode ?? null,
        seed.archived ?? false,
        seed.actionCardId ?? null,
        seed.updatedAt ?? null,
      ],
    );
    if (seed.campaign) {
      const campaignId = randomUUID();
      await setupClient.query(
        `INSERT INTO app.campaigns (id, station_id, ad_id, name, status, active_period, updated_at)
         VALUES ($1, $2, $3, $4, $5, tstzrange(now() + $6 * interval '1 hour', now() + $7 * interval '1 hour'), coalesce($8::timestamptz, now()))`,
        [campaignId, stationId, adId, seed.title, seed.campaign.status, seed.campaign.startsInHours, seed.campaign.endsInHours, seed.campaign.updatedAt ?? null],
      );
      if (seed.campaign.alwaysOnAir) {
        // 00:00–12:00 and 12:00–00:00 on every day: together, every moment of the week.
        for (const [start, end] of [['00:00', '12:00'], ['12:00', '00:00']]) {
          await setupClient.query(
            `INSERT INTO app.campaign_time_windows (campaign_id, station_id, days_of_week, local_start_time, local_end_time) VALUES ($1, $2, '{1,2,3,4,5,6,7}', $3, $4)`,
            [campaignId, stationId, start, end],
          );
        }
      }
    }
    return adId;
  }

  beforeAll(async () => {
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
    owner = await testUsers.create();
    analyst = await testUsers.create({ joinStationId: owner.stationId, role: 'ANALYST' });
    otherStationOwner = await testUsers.create();
    stationUnderReviewOwner = await testUsers.create({ stationStatus: 'PENDING_REVIEW' });

    await insertClient(owner.stationId, clients.brandX, 'Brand X');
    await insertClient(owner.stationId, clients.brandY, 'Brand Y');
    await insertClient(otherStationOwner.stationId, clients.foreign, 'Brand X');
    const cardId = await insertCard(owner.stationId, clients.brandX);

    const always = { alwaysOnAir: true } as const;
    await insertAd(owner.stationId, { title: 'Live ad', clientId: clients.brandX, actionCardId: cardId, campaign: { status: 'ACTIVE', startsInHours: -24, endsInHours: 24 * 30, ...always } });
    await insertAd(owner.stationId, { title: 'Ending soon ad', clientId: clients.brandX, campaign: { status: 'ACTIVE', startsInHours: -24, endsInHours: 25, ...always } });
    await insertAd(owner.stationId, { title: 'Scheduled ad', clientId: clients.brandY, campaign: { status: 'ACTIVE', startsInHours: 48, endsInHours: 240, ...always } });
    await insertAd(owner.stationId, { title: 'Plain draft', clientId: clients.brandY, status: 'PROCESSING' });
    await insertAd(owner.stationId, { title: 'Late draft', clientId: clients.brandY, campaign: { status: 'DRAFT', startsInHours: -48, endsInHours: 240 } });
    await insertAd(owner.stationId, { title: 'Future draft', clientId: clients.brandY, campaign: { status: 'DRAFT', startsInHours: 48, endsInHours: 240 } });
    await insertAd(owner.stationId, { title: 'Ended ad', clientId: clients.brandX, campaign: { status: 'ENDED', startsInHours: -480, endsInHours: -240 } });
    await insertAd(owner.stationId, { title: 'Refused ad', clientId: clients.brandX, status: 'FAILED', processingErrorCode: 'not_the_declared_audio_format' });
    await insertAd(owner.stationId, { title: 'Abandoned upload', clientId: clients.brandX, status: 'AWAITING_UPLOAD', uploadExpiresInMinutes: -60 });
    await insertAd(owner.stationId, { title: 'Still uploading', clientId: clients.brandX, status: 'AWAITING_UPLOAD', uploadExpiresInMinutes: 10 });
    await insertAd(owner.stationId, { title: 'Archived ad', clientId: clients.brandX, archived: true });
    await insertAd(otherStationOwner.stationId, { title: 'Live ad', clientId: clients.foreign, campaign: { status: 'ACTIVE', startsInHours: -24, endsInHours: 240, ...always } });
  });

  afterAll(async () => {
    const stationIds = [owner.stationId, otherStationOwner.stationId, stationUnderReviewOwner.stationId];
    await setupClient.query('DELETE FROM app.campaigns WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.ads WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.action_cards WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.clients WHERE station_id = ANY($1)', [stationIds]);
    await testUsers.cleanUp();
    await setupClient.end();
    await testApplication.close();
  });

  describe('tabs', () => {
    it.each<[AdListView, string[]]>([
      ['all', ['Abandoned upload', 'Ended ad', 'Ending soon ad', 'Future draft', 'Late draft', 'Live ad', 'Plain draft', 'Refused ad', 'Scheduled ad', 'Still uploading']],
      ['live', ['Ending soon ad', 'Live ad']],
      ['scheduled', ['Scheduled ad']],
      ['drafts', ['Abandoned upload', 'Future draft', 'Late draft', 'Plain draft', 'Refused ad', 'Still uploading']],
      ['attention', ['Abandoned upload', 'Ending soon ad', 'Late draft', 'Refused ad']],
      ['ended', ['Ended ad']],
    ])('%s shows exactly the right ads, never archived ones or another station\'s', async (view, expectedTitles) => {
      const page = await listAds(owner, { view });
      expect(titlesOf(page.ads).sort()).toEqual(expectedTitles);
    });

    it('says why each ad needs attention, and whether it has buttons', async () => {
      const page = await listAds(owner, { view: 'all', sort: 'title' });
      const byTitle = Object.fromEntries(page.ads.map((ad) => [ad.title, ad]));
      expect(byTitle['Refused ad']?.attentionReasons).toEqual(['upload_refused']);
      expect(byTitle['Abandoned upload']?.attentionReasons).toEqual(['upload_not_finished']);
      expect(byTitle['Late draft']?.attentionReasons).toEqual(['start_date_passed']);
      expect(byTitle['Ending soon ad']?.attentionReasons).toEqual(['ending_soon']);
      for (const title of ['Live ad', 'Scheduled ad', 'Ended ad', 'Future draft', 'Plain draft', 'Still uploading']) {
        expect(byTitle[title]?.attentionReasons, title).toEqual([]);
      }
      expect(byTitle['Live ad']?.hasActionCard).toBe(true);
      expect(byTitle['Scheduled ad']?.hasActionCard).toBe(false);
      expect(byTitle['Live ad']?.campaign?.displayStatus).toBe('LIVE_NOW');
    });

    it('an ad ending in four days or more is not "ending soon"', async () => {
      const page = await listAds(owner, { view: 'attention' });
      expect(titlesOf(page.ads)).not.toContain('Live ad');
    });
  });

  describe('search and client filter', () => {
    it('matches the title or the client\'s name, ignoring capitals', async () => {
      expect(titlesOf((await listAds(owner, { search: 'LIVE' })).ads).sort()).toEqual(['Live ad']);
      expect(titlesOf((await listAds(owner, { search: 'brand y' })).ads).sort()).toEqual(['Future draft', 'Late draft', 'Plain draft', 'Scheduled ad']);
    });

    it('treats %, _ and \\ as the characters themselves, not wildcards', async () => {
      const stationId = owner.stationId;
      await insertAd(stationId, { title: '100% Juice', clientId: clients.brandY });
      await insertAd(stationId, { title: 'under_score', clientId: clients.brandY });
      await insertAd(stationId, { title: 'back\\slash', clientId: clients.brandY });
      try {
        expect(titlesOf((await listAds(owner, { search: '%' })).ads)).toEqual(['100% Juice']);
        expect(titlesOf((await listAds(owner, { search: '_' })).ads)).toEqual(['under_score']);
        expect(titlesOf((await listAds(owner, { search: '\\' })).ads)).toEqual(['back\\slash']);
        expect(titlesOf((await listAds(owner, { search: 'under_score' })).ads)).toEqual(['under_score']);
      } finally {
        await setupClient.query(`DELETE FROM app.ads WHERE station_id = $1 AND title IN ('100% Juice', 'under_score', 'back\\slash')`, [stationId]);
      }
    });

    it('filters by client, and another station\'s client id finds nothing', async () => {
      expect(titlesOf((await listAds(owner, { clientId: clients.brandY, view: 'scheduled' })).ads)).toEqual(['Scheduled ad']);
      expect((await listAds(owner, { clientId: clients.foreign })).ads).toEqual([]);
    });

    it('refuses an over-long search, an unknown view or sort, and unknown parameters', async () => {
      for (const query of ['search=' + 'x'.repeat(81), 'view=everything', 'sort=loudest', 'clientId=not-a-uuid', 'page=2']) {
        const response = await get(owner, `${adsPath(owner)}?${query}`);
        expect(response.status, query).toBe(400);
        assertErrorEnvelope(response.body);
      }
    });
  });

  describe('sorting and paging', () => {
    it('"last updated" counts a rescheduled ad as updated, though only its campaign changed', async () => {
      const stationId = otherStationOwner.stationId;
      await insertAd(stationId, { title: 'Old but rescheduled', clientId: clients.foreign, updatedAt: '2020-01-01T00:00:00Z', campaign: { status: 'DRAFT', startsInHours: 24, endsInHours: 48 } });
      await insertAd(stationId, { title: 'Edited long ago', clientId: clients.foreign, updatedAt: '2025-01-01T00:00:00Z' });
      const page = await listAds(otherStationOwner, { sort: 'updated' });
      expect(titlesOf(page.ads).slice(0, 2)).toEqual(['Old but rescheduled', 'Live ad']);
      expect(titlesOf(page.ads).indexOf('Old but rescheduled')).toBeLessThan(titlesOf(page.ads).indexOf('Edited long ago'));
    });

    it('A to Z ignores capitals; newest start first puts unscheduled ads last', async () => {
      const byTitle = await listAds(owner, { sort: 'title' });
      expect(titlesOf(byTitle.ads)).toEqual([...titlesOf(byTitle.ads)].sort((first, second) => first.toLowerCase().localeCompare(second.toLowerCase())));
      const byStart = await listAds(owner, { sort: 'startDate' });
      const scheduledTitles = ['Scheduled ad', 'Future draft', 'Ending soon ad', 'Live ad', 'Late draft'];
      expect(titlesOf(byStart.ads).slice(0, 2).sort()).toEqual(['Future draft', 'Scheduled ad']);
      const lastScheduledPosition = Math.max(...scheduledTitles.map((title) => titlesOf(byStart.ads).indexOf(title)));
      const firstUnscheduledPosition = Math.min(...['Plain draft', 'Refused ad', 'Abandoned upload', 'Still uploading'].map((title) => titlesOf(byStart.ads).indexOf(title)));
      expect(lastScheduledPosition).toBeLessThan(firstUnscheduledPosition);
    });

    describe('25 ads with ties in every sort', () => {
      let pagerOwner: PortalTestUser;
      const pagerClient = randomUUID();

      beforeAll(async () => {
        pagerOwner = await testUsers.create();
        await insertClient(pagerOwner.stationId, pagerClient, 'Pager client');
        for (let index = 0; index < 25; index += 1) {
          const sharesStartWithOthers = index % 5 === 0;
          await insertAd(pagerOwner.stationId, {
            title: index % 5 === 0 ? 'Same title' : `Ad ${String(index).padStart(2, '0')}`,
            clientId: pagerClient,
            // Five ads share one change time; the rest are all different.
            updatedAt: index % 5 === 0 ? '2026-01-01T00:00:00Z' : `2026-01-${String(2 + index).padStart(2, '0')}T00:00:00Z`,
            campaign: index % 3 === 0
              ? { status: 'DRAFT', startsInHours: sharesStartWithOthers ? 100 : 100 + index, endsInHours: 500, updatedAt: '2019-01-01T00:00:00Z' }
              : undefined,
          });
        }
      });
      afterAll(async () => {
        await setupClient.query('DELETE FROM app.campaigns WHERE station_id = $1', [pagerOwner.stationId]);
        await setupClient.query('DELETE FROM app.ads WHERE station_id = $1', [pagerOwner.stationId]);
        await setupClient.query('DELETE FROM app.clients WHERE station_id = $1', [pagerOwner.stationId]);
      });

      it.each<AdListSort>(['updated', 'title', 'startDate'])('%s: two pages hold all 25 ads once each, in order, with no repeats or gaps', async (sort) => {
        const firstPage = await listAds(pagerOwner, { sort });
        expect(firstPage.ads).toHaveLength(ADS_PER_PAGE);
        expect(firstPage.nextCursor).not.toBeNull();
        const secondPage = await listAds(pagerOwner, { sort, cursor: firstPage.nextCursor as string });
        expect(secondPage.ads).toHaveLength(5);
        expect(secondPage.nextCursor).toBeNull();

        const allIds = [...firstPage.ads, ...secondPage.ads].map((ad) => ad.id);
        expect(new Set(allIds).size).toBe(25);
        const inDatabaseOrder = (
          await setupClient.query(
            `SELECT ads.id FROM app.ads LEFT JOIN LATERAL (SELECT lower(active_period) AS starts_at FROM app.campaigns WHERE ad_id = ads.id ORDER BY created_at DESC LIMIT 1) AS campaign ON true
              WHERE ads.station_id = $1
              ORDER BY ${{
                updated: 'greatest(ads.updated_at, (SELECT updated_at FROM app.campaigns WHERE ad_id = ads.id ORDER BY created_at DESC LIMIT 1)) DESC, ads.id DESC',
                title: 'lower(ads.title), ads.id',
                startDate: `coalesce(campaign.starts_at, '-infinity') DESC, ads.id DESC`,
              }[sort]}`,
            [pagerOwner.stationId],
          )
        ).rows.map((row) => row.id as string);
        expect(allIds).toEqual(inDatabaseOrder);
      });

      it('a cursor made for one sort is refused by another, and garbage is refused', async () => {
        const firstPage = await listAds(pagerOwner, { sort: 'updated' });
        for (const [sort, cursor] of [['title', firstPage.nextCursor as string], ['updated', 'not-a-cursor'], ['updated', Buffer.from('[1,2,3]').toString('base64url')]]) {
          const response = await get(pagerOwner, `${adsPath(pagerOwner)}?sort=${sort}&cursor=${cursor}`);
          expect(response.status, `${sort} ${cursor}`).toBe(400);
          expect(response.body.error.fields).toEqual([{ path: 'cursor', code: 'invalid_cursor' }]);
        }
      });
    });
  });

  describe('the overview', () => {
    it('counts every tab, lists what is on air A to Z, and ranks what needs attention by seriousness', async () => {
      const response = await get(owner, `/api/v1/stations/${owner.stationId}/overview`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.adCounts).toEqual({ all: 10, live: 2, scheduled: 1, drafts: 6, attention: 4, ended: 1 });
      expect(titlesOf(response.body.liveNowAds)).toEqual(['Ending soon ad', 'Live ad']);
      expect(titlesOf(response.body.attentionAds)).toEqual(['Refused ad', 'Abandoned upload', 'Late draft', 'Ending soon ad']);
    });

    it('the counts match what each tab lists', async () => {
      const overview = (await get(owner, `/api/v1/stations/${owner.stationId}/overview`)).body;
      for (const view of ['all', 'live', 'scheduled', 'drafts', 'attention', 'ended'] as const) {
        expect(overview.adCounts[view], view).toBe((await listAds(owner, { view })).ads.length);
      }
    });

    it('analysts can read it; another station\'s people cannot; a station under review is refused', async () => {
      expect((await get(analyst, `/api/v1/stations/${owner.stationId}/overview`)).status).toBe(200);
      const foreign = await get(otherStationOwner, `/api/v1/stations/${owner.stationId}/overview`);
      expect(foreign.status).toBe(404);
      assertErrorEnvelope(foreign.body);
      const underReview = await get(stationUnderReviewOwner, `/api/v1/stations/${stationUnderReviewOwner.stationId}/overview`);
      expect(underReview.status).toBe(403);
      expect(underReview.body.error.code).toBe('STATION_NOT_ACTIVE');
    });

    it('a station with no ads gets zeros and empty lists', async () => {
      const emptyOwner = await testUsers.create();
      const response = await get(emptyOwner, `/api/v1/stations/${emptyOwner.stationId}/overview`);
      expect(response.body).toEqual({ adCounts: { all: 0, live: 0, scheduled: 0, drafts: 0, attention: 0, ended: 0 }, liveNowAds: [], attentionAds: [] });
    });
  });

  describe('the clients list', () => {
    it('counts each client\'s ads (archived ones not) and how many are on air now', async () => {
      const response = await get(owner, `/api/v1/stations/${owner.stationId}/clients`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        { id: clients.brandX, name: 'Brand X', adCount: 6, liveNowAdCount: 2 },
        { id: clients.brandY, name: 'Brand Y', adCount: 4, liveNowAdCount: 0 },
      ]);
    });
  });
});
