import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { ageBandOf, LISTENER_AGE_BANDS, LISTENER_GENDERS, ListenerMix, type ListenerGender } from '@lookup/contracts';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { StationResolutionTestData } from './support/station-resolution-test-data.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const DAY = 24 * 3_600_000;
const GENDER_GROUPS = [...LISTENER_GENDERS, 'OTHER_GROUPS'];
const BAND_GROUPS = [...LISTENER_AGE_BANDS, 'OTHER_GROUPS'];
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface Listener {
  accountId: string;
  emailHash: Buffer;
  installIds: string[];
}

/**
 * Who is listening (ADR-005, LA-STATS-01 to -06, LA-PRIVACY-05): distinct listeners by gender and age band, read from the
 * recognitions themselves through functions that return counts only, with the small-group rule applied on top. Accounts,
 * their installs and the recognitions are written straight to the database at chosen moments, then read as real
 * signed-in station members.
 */
describe('who is listening', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  let resolutionData: StationResolutionTestData;
  let owner: PortalTestUser;
  let analyst: PortalTestUser;
  let otherStationOwner: PortalTestUser;
  let currentYear: number;
  let todayStartedAt: number;
  let ads: Record<'evening' | 'morning' | 'foreign', { adId: string; campaignId: string }>;
  /** Station A's last male listener, whose phone signs out and in again (LA-STATS-06). */
  let lastMale: Listener;
  const client = () => supertest(testApplication.application.getHttpServer());
  const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  const sessions = new Map<string, Record<string, string>>();

  async function get(user: PortalTestUser | null, path: string) {
    let cookies = user ? sessions.get(user.userId) : undefined;
    if (user && !cookies) {
      const signedIn = await client().post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).send({ email: user.email, password: user.password });
      expect(signedIn.status).toBe(200);
      cookies = cookiesSetBy(signedIn);
      sessions.set(user.userId, cookies);
    }
    const request = client().get(path).set('X-Forwarded-For', newClientAddress());
    return cookies ? request.set('Cookie', cookieHeader(cookies)) : request;
  }
  const mixPath = (stationId: string, range?: string) => `/api/v1/stations/${stationId}/listener-mix${range ? `?range=${range}` : ''}`;
  const adMixPath = (stationId: string, adId: string, range?: string) => `/api/v1/stations/${stationId}/ads/${adId}/listener-mix${range ? `?range=${range}` : ''}`;
  async function mix(user: PortalTestUser, path: string): Promise<ListenerMix> {
    const response = await get(user, path);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as ListenerMix;
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
    return { adId, campaignId };
  }

  /** An account (with a throwaway sealed email), and one install linked to it unless told otherwise. */
  async function listener(gender: ListenerGender, age: number, installCount = 1): Promise<Listener> {
    const emailHash = randomBytes(32);
    const accountId = (
      await setupClient.query(
        `INSERT INTO app.listener_accounts (email_hash, email_sealed, gender, birth_year, consent_text_version) VALUES ($1, $2, $3, $4, 'listener-consent-2026-10') RETURNING id`,
        [emailHash, randomBytes(40), gender, currentYear - age],
      )
    ).rows[0].id as string;
    const installIds: string[] = [];
    for (let index = 0; index < installCount; index++) {
      const installId = await resolutionData.createInstall();
      await setupClient.query('UPDATE app.listener_installs SET listener_account_id = $2 WHERE id = $1', [installId, accountId]);
      installIds.push(installId);
    }
    return { accountId, emailHash, installIds };
  }

  /** A recognition of an ad's campaign by an install, heard a moment ago (never before the station's midnight) unless told otherwise. */
  async function heard(installId: string, stationId: string, ad: { campaignId: string }, options: { heardAt?: Date; outcome?: 'MATCH' | 'NO_MATCH' } = {}) {
    const heardAt = options.heardAt ?? new Date(Math.max(Date.now() - 60_000, todayStartedAt));
    const receivedAt = new Date(Math.min(heardAt.getTime() + 60_000, Date.now()));
    const outcome = options.outcome ?? 'MATCH';
    await setupClient.query(
      `INSERT INTO app.recognition_events (id, listener_install_id, idempotency_key, request_id, captured_at, received_at, is_deferred, outcome, resolution, station_id, campaign_id)
       VALUES ($1, $2, $3, 'mix-test', $4, $5, false, $6, $7, $8, $9)`,
      [randomUUID(), installId, randomUUID(), heardAt, receivedAt, outcome, outcome === 'MATCH' ? 'SINGLE_OWNER' : null, outcome === 'MATCH' ? stationId : null, outcome === 'MATCH' ? ad.campaignId : null],
    );
  }

  /** What the database functions return for a station, before any small-group rule: counts only, as the station would be served. */
  async function rawMix(stationId: string, options: { adId?: string; rangeDays?: number } = {}) {
    await setupClient.query('BEGIN');
    try {
      await setupClient.query(`SELECT set_config('app.current_station_id', $1, true)`, [stationId]);
      const result = options.adId
        ? await setupClient.query('SELECT * FROM app.read_listener_mix_for_ad($1, $2)', [options.adId, options.rangeDays ?? 30])
        : await setupClient.query('SELECT * FROM app.read_listener_mix_for_station($1)', [options.rangeDays ?? 30]);
      return result.rows as Array<{ first_day: string; last_day: string; known_listeners: number; not_known_yet_listeners: number; genders: Record<string, number>; age_bands: Record<string, number> }>;
    } finally {
      await setupClient.query('ROLLBACK');
    }
  }

  beforeAll(async () => {
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
    resolutionData = new StationResolutionTestData(setupClient);
    owner = await testUsers.create();
    analyst = await testUsers.create({ joinStationId: owner.stationId, role: 'ANALYST' });
    otherStationOwner = await testUsers.create();
    await setupClient.query(`UPDATE app.stations SET time_zone = 'Africa/Lusaka' WHERE id = ANY($1)`, [[owner.stationId, otherStationOwner.stationId]]);
    const clock = (await setupClient.query(`SELECT extract(year FROM now() AT TIME ZONE 'Africa/Lusaka')::integer AS current_year, ((now() AT TIME ZONE 'Africa/Lusaka')::date::timestamp AT TIME ZONE 'Africa/Lusaka') AS started_at`)).rows[0];
    currentYear = clock.current_year;
    todayStartedAt = clock.started_at.getTime();

    ads = {
      evening: await airedAd(owner.stationId, 'Evening offer'),
      morning: await airedAd(owner.stationId, 'Morning offer'),
      foreign: await airedAd(otherStationOwner.stationId, 'Foreign offer'),
    };

    // Station A: 25 known listeners (14 women, 10 men, 1 another), 5 phones with no account, all of whom heard the evening ad.
    const aged = (index: number) => (index % 2 === 0 ? 30 : 40);
    const known: Listener[] = [];
    for (let index = 0; index < 14; index++) known.push(await listener('FEMALE', aged(index), index === 0 ? 2 : 1));
    for (let index = 0; index < 10; index++) known.push(await listener('MALE', aged(index)));
    known.push(await listener('ANOTHER', 20));
    lastMale = known[23]!;
    for (const person of known) for (const installId of person.installIds) await heard(installId, owner.stationId, ads.evening);
    // A listener who identified the ad three times, and four more who did it once, none with an account.
    const anonymous = [await resolutionData.createInstall(), await resolutionData.createInstall(), await resolutionData.createInstall(), await resolutionData.createInstall(), await resolutionData.createInstall()];
    for (const installId of anonymous) await heard(installId, owner.stationId, ads.evening);
    await heard(anonymous[0]!, owner.stationId, ads.evening);
    await heard(anonymous[0]!, owner.stationId, ads.evening);
    // Three known listeners identified the morning ad too.
    for (const person of known.slice(0, 3)) await heard(person.installIds[0]!, owner.stationId, ads.morning);
    // Something that is not a counted recognition: a clip that matched nothing.
    await heard(anonymous[1]!, owner.stationId, ads.evening, { outcome: 'NO_MATCH' });

    // Station B: 9 known listeners and 2 phones with no account heard its ad.
    for (let index = 0; index < 9; index++) await heard((await listener(index < 5 ? 'FEMALE' : 'MALE', 30)).installIds[0]!, otherStationOwner.stationId, ads.foreign);
    for (let index = 0; index < 2; index++) await heard(await resolutionData.createInstall(), otherStationOwner.stationId, ads.foreign);
  }, 120_000);

  afterAll(async () => {
    await setupClient.end();
    await testApplication.close();
  });

  describe('the people counted (LA-STATS-01)', () => {
    it('LA-STATS-01: one count per listener: a person with two phones, and a phone that identified three times, each count once, and a clip that matched nothing counts for no one', async () => {
      const figures = await mix(owner, mixPath(owner.stationId));
      expect(figures.knownListeners).toBe(25);
      expect(figures.notKnownYetListeners).toBe(5);
      expect(figures.listeners).toBe(30);
    });

    it('LA-STATS-01: the same counts come from the database function before any rule is applied, with every group present', async () => {
      const [row] = await rawMix(owner.stationId);
      expect(row).toMatchObject({ known_listeners: 25, not_known_yet_listeners: 5 });
      expect(row!.genders).toEqual({ FEMALE: 14, MALE: 10, ANOTHER: 1, PREFER_NOT_TO_SAY: 0 });
      expect(row!.age_bands).toEqual({ UNDER_18: 0, AGE_18_TO_24: 1, AGE_25_TO_34: 12, AGE_35_TO_44: 12, AGE_45_TO_54: 0, AGE_55_AND_OVER: 0 });
    });

    it('LA-STATS-01: one ad counts only the listeners who identified that ad', async () => {
      const morning = await mix(owner, adMixPath(owner.stationId, ads.morning.adId));
      expect(morning).toMatchObject({ listeners: 3, knownListeners: 3, notKnownYetListeners: 0 });
      const evening = await mix(owner, adMixPath(owner.stationId, ads.evening.adId));
      expect(evening).toMatchObject({ listeners: 30, knownListeners: 25, notKnownYetListeners: 5 });
    });
  });

  describe('the age bands (LA-STATS-02)', () => {
    it('LA-STATS-02: every age from 13 to 99 lands in the band the contract gives it, at each boundary: 17 and 18, 24 and 25, 34 and 35, 44 and 45, 54 and 55', async () => {
      const boundaryOwner = await testUsers.create();
      await setupClient.query(`UPDATE app.stations SET time_zone = 'Africa/Lusaka' WHERE id = $1`, [boundaryOwner.stationId]);
      const ad = await airedAd(boundaryOwner.stationId, 'Boundary offer');
      const expected: Record<string, number> = Object.fromEntries(LISTENER_AGE_BANDS.map((band) => [band, 0]));
      for (let age = 13; age <= 99; age++) {
        await heard((await listener('FEMALE', age)).installIds[0]!, boundaryOwner.stationId, ad);
        expected[ageBandOf(currentYear - age, currentYear)]! += 1;
      }
      const [row] = await rawMix(boundaryOwner.stationId);
      expect(row!.age_bands).toEqual(expected);
      // Spelled out, so the contract's function cannot drift with the database's: 13-17, 18-24, 25-34, 35-44, 45-54, 55-99.
      expect(expected).toEqual({ UNDER_18: 5, AGE_18_TO_24: 7, AGE_25_TO_34: 10, AGE_35_TO_44: 10, AGE_45_TO_54: 10, AGE_55_AND_OVER: 45 });
    });
  });

  describe('what a station may see (LA-STATS-03, -04)', () => {
    it('LA-STATS-03: with 25 known listeners a lone small group takes the smallest group still shown in with it, in both breakdowns', async () => {
      const figures = await mix(owner, mixPath(owner.stationId));
      // 14 women, 10 men and 1 "another": the 1 would be found as 25 − 24, so the 10 men join it.
      expect(figures.genders).toEqual([
        { group: 'FEMALE', listeners: 14 },
        { group: 'PREFER_NOT_TO_SAY', listeners: 0 },
        { group: 'OTHER_GROUPS', listeners: 11 },
      ]);
      // One person aged 18 to 24, then twelve and twelve: the 1 takes the first 12 with it.
      expect(figures.ageBands).toEqual([
        { group: 'UNDER_18', listeners: 0 },
        { group: 'AGE_35_TO_44', listeners: 12 },
        { group: 'AGE_45_TO_54', listeners: 0 },
        { group: 'AGE_55_AND_OVER', listeners: 0 },
        { group: 'OTHER_GROUPS', listeners: 13 },
      ]);
    });

    it('LA-STATS-03: with fewer than 10 known listeners there is no breakdown, though the number of listeners is told', async () => {
      const figures = await mix(otherStationOwner, mixPath(otherStationOwner.stationId));
      expect(figures).toMatchObject({ listeners: 11, knownListeners: 9, notKnownYetListeners: 2, genders: null, ageBands: null });
      const morning = await mix(owner, adMixPath(owner.stationId, ads.morning.adId));
      expect(morning).toMatchObject({ knownListeners: 3, genders: null, ageBands: null });
    });

    it('LA-STATS-04: the answer is the contract\'s shape and nothing more: two breakdowns of groups, no grid, no row per listener', async () => {
      for (const path of [mixPath(owner.stationId), adMixPath(owner.stationId, ads.evening.adId), mixPath(otherStationOwner.stationId)]) {
        const response = (await get(owner.stationId === path.split('/')[4] ? owner : otherStationOwner, path)).body as unknown;
        const parsed = ListenerMix.parse(response);
        expect(Object.keys(parsed).sort()).toEqual(['ageBands', 'firstDay', 'genders', 'knownListeners', 'lastDay', 'listeners', 'notKnownYetListeners', 'range']);
        for (const group of [...(parsed.genders ?? []), ...(parsed.ageBands ?? [])]) {
          expect(Object.keys(group).sort()).toEqual(['group', 'listeners']);
          expect(group.listeners === 0 || group.listeners >= 10, path).toBe(true);
        }
        expect((parsed.genders ?? []).every((group) => GENDER_GROUPS.includes(group.group))).toBe(true);
        expect((parsed.ageBands ?? []).every((group) => BAND_GROUPS.includes(group.group))).toBe(true);
      }
    });

    it('LA-PRIVACY-05: no email, no gender or age of a person, and no id of any listener, account, phone or recognition is in any answer or in what the database function returns', async () => {
      const bodies = [
        JSON.stringify((await get(owner, mixPath(owner.stationId))).body),
        JSON.stringify((await get(owner, adMixPath(owner.stationId, ads.evening.adId))).body),
        JSON.stringify((await get(otherStationOwner, mixPath(otherStationOwner.stationId))).body),
        JSON.stringify(await rawMix(owner.stationId)),
        JSON.stringify(await rawMix(owner.stationId, { adId: ads.evening.adId })),
      ];
      for (const body of bodies) {
        expect(body).not.toMatch(UUID_ANYWHERE);
        expect(body).not.toContain('@');
        expect(body.toLowerCase()).not.toMatch(/email|birth|"age"|account|install|recogni/);
      }
    });
  });

  describe('whose recognitions, and which days (LA-STATS-05)', () => {
    it('LA-STATS-05: a station counts only its own recognitions: the other station\'s 11 listeners never reach it, and its own never reach the other', async () => {
      expect((await mix(owner, mixPath(owner.stationId))).listeners).toBe(30);
      expect((await mix(otherStationOwner, mixPath(otherStationOwner.stationId))).listeners).toBe(11);
    });

    it('LA-STATS-05: any member of the station may read it, an analyst too, and nobody who is not signed in', async () => {
      expect((await mix(analyst, mixPath(owner.stationId))).listeners).toBe(30);
      expect((await get(null, mixPath(owner.stationId))).status).toBe(401);
      expect((await get(null, adMixPath(owner.stationId, ads.evening.adId))).status).toBe(401);
    });

    it('LA-STATS-05: another station, and another station\'s ad, answer as a station that does not exist would', async () => {
      const otherStation = await get(otherStationOwner, mixPath(owner.stationId));
      expect(otherStation.status).toBe(404);
      assertErrorEnvelope(otherStation.body);
      const unknownStation = await get(otherStationOwner, mixPath(randomUUID()));
      expect(unknownStation.status).toBe(404);
      expect(unknownStation.body).toEqual({ error: { ...otherStation.body.error, request_id: unknownStation.body.error.request_id } });
      const foreignAd = await get(owner, adMixPath(owner.stationId, ads.foreign.adId));
      expect(foreignAd.status).toBe(404);
      assertErrorEnvelope(foreignAd.body);
      for (const adId of [randomUUID(), 'not-an-id']) {
        const missing = await get(owner, adMixPath(owner.stationId, adId));
        expect(missing.status, adId).toBe(404);
        assertErrorEnvelope(missing.body);
      }
    });

    it('LA-STATS-05: the ranges are today, the last 7 days (the default) and the last 30 days, counted on the days the station heard them', async () => {
      const rangeOwner = await testUsers.create();
      await setupClient.query(`UPDATE app.stations SET time_zone = 'Africa/Lusaka' WHERE id = $1`, [rangeOwner.stationId]);
      const ad = await airedAd(rangeOwner.stationId, 'Range offer');
      const now = Date.now();
      // 12 listeners today, 12 more three days ago, 12 more twenty days ago, and 12 forty days ago (outside every range).
      const moments = [new Date(Math.max(now - 60_000, todayStartedAt)), new Date(todayStartedAt - 3 * DAY + 12 * 3_600_000), new Date(todayStartedAt - 20 * DAY + 12 * 3_600_000), new Date(todayStartedAt - 40 * DAY + 12 * 3_600_000)];
      for (const heardAt of moments) for (let index = 0; index < 12; index++) await heard((await listener('FEMALE', 30)).installIds[0]!, rangeOwner.stationId, ad, { heardAt });
      expect((await mix(rangeOwner, mixPath(rangeOwner.stationId, 'today'))).listeners).toBe(12);
      expect((await mix(rangeOwner, mixPath(rangeOwner.stationId))).listeners).toBe(24);
      expect((await mix(rangeOwner, mixPath(rangeOwner.stationId, 'last7Days'))).listeners).toBe(24);
      expect((await mix(rangeOwner, mixPath(rangeOwner.stationId, 'last30Days'))).listeners).toBe(36);
      const today = await mix(rangeOwner, mixPath(rangeOwner.stationId, 'today'));
      expect(today.firstDay).toBe(today.lastDay);
      const month = await mix(rangeOwner, mixPath(rangeOwner.stationId, 'last30Days'));
      expect(month.range).toBe('last30Days');
      expect(month.firstDay < month.lastDay).toBe(true);
      const unknown = await get(rangeOwner, mixPath(rangeOwner.stationId, 'yesterday'));
      expect(unknown.status).toBe(400);
      assertErrorEnvelope(unknown.body);
    });
  });

  describe('signing out and deleting (LA-STATS-06)', () => {
    it('LA-STATS-06: a phone that signs out goes back to "not known yet", and signing in again puts it back', async () => {
      const call = (sql: string, parameters: unknown[]) => setupClient.query(sql, parameters);
      expect((await mix(owner, mixPath(owner.stationId))).knownListeners).toBe(25);

      await call('SELECT app.unlink_listener_install_from_account($1)', [lastMale.installIds[0]]);
      const signedOut = await mix(owner, mixPath(owner.stationId));
      expect(signedOut).toMatchObject({ knownListeners: 24, notKnownYetListeners: 6, listeners: 30 });
      const [raw] = await rawMix(owner.stationId);
      expect(raw!.genders).toEqual({ FEMALE: 14, MALE: 9, ANOTHER: 1, PREFER_NOT_TO_SAY: 0 });

      await call('SELECT app.link_listener_install_to_existing_account($1, $2)', [lastMale.installIds[0], lastMale.emailHash]);
      expect(await mix(owner, mixPath(owner.stationId))).toMatchObject({ knownListeners: 25, notKnownYetListeners: 5, listeners: 30 });
    });

    it('LA-STATS-06: deleting an account moves its phone\'s scans to "not known yet" for good, and the account itself is gone', async () => {
      const deleteOwner = await testUsers.create();
      await setupClient.query(`UPDATE app.stations SET time_zone = 'Africa/Lusaka' WHERE id = $1`, [deleteOwner.stationId]);
      const ad = await airedAd(deleteOwner.stationId, 'Deleted offer');
      const person = await listener('MALE', 41);
      await heard(person.installIds[0]!, deleteOwner.stationId, ad);
      expect(await rawMix(deleteOwner.stationId)).toMatchObject([{ known_listeners: 1, not_known_yet_listeners: 0 }]);
      await setupClient.query('SELECT app.delete_listener_account_of_install($1, $2)', [person.installIds[0], 'mix-test']);
      expect(await rawMix(deleteOwner.stationId)).toMatchObject([{ known_listeners: 0, not_known_yet_listeners: 1 }]);
      expect((await setupClient.query('SELECT 1 FROM app.listener_accounts WHERE id = $1', [person.accountId])).rows).toEqual([]);
    });
  });

  describe('the database functions', () => {
    it('LA-DATABASE-03: with no station set they return nothing, and for another station\'s ad they return nothing', async () => {
      await setupClient.query('BEGIN');
      try {
        await setupClient.query(`SELECT set_config('app.current_station_id', '', true)`);
        expect((await setupClient.query('SELECT * FROM app.read_listener_mix_for_station(7)')).rows).toEqual([]);
        expect((await setupClient.query('SELECT * FROM app.read_listener_mix_for_ad($1, 7)', [ads.evening.adId])).rows).toEqual([]);
      } finally {
        await setupClient.query('ROLLBACK');
      }
      expect(await rawMix(otherStationOwner.stationId, { adId: ads.evening.adId })).toEqual([]);
      expect(await rawMix(owner.stationId, { adId: randomUUID() })).toEqual([]);
    });
  });
});
