import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SampleStorage, SAMPLE_AD_TITLES, seedSampleAds } from '../scripts/sample-ads.js';
import { seedDevelopmentData } from '../scripts/seed-development-data.js';
import { databaseSetupClient } from './support/database-clients.js';

describe('development seed', () => {
  let setupClient: pg.Client;
  const runTag = randomUUID().slice(0, 8);
  const seed = {
    stationName: `Seed Station ${runTag}`,
    frequencyLabel: '98.1 FM',
    ownerEmail: `seed-owner-${runTag}@example.test`,
    // Not containing the run tag: it is part of the station name, which the policy rightly refuses.
    ownerPassword: 'amber kettle rainy harbour 7461',
    ownerFullName: 'Seed Owner',
    clientNames: ['Brand A', 'Brand B'],
  };

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    await setupClient.connect();
  });
  afterAll(async () => {
    const station = await setupClient.query(`SELECT id FROM app.stations WHERE name = $1`, [seed.stationName]);
    const stationIds = station.rows.map((row) => row.id);
    await setupClient.query('DELETE FROM app.audit_events WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.campaigns WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.ads WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.action_cards WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.clients WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.station_memberships WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.portal_users WHERE email = $1', [seed.ownerEmail]);
    await setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [stationIds]);
    await setupClient.end();
  });

  it('creates an active station, its owner and two clients, and running it again changes nothing', async () => {
    const setupUrl = process.env.DATABASE_SETUP_URL as string;
    const first = await seedDevelopmentData(setupUrl, seed);
    const second = await seedDevelopmentData(setupUrl, seed);
    expect(second).toEqual(first);
    const counts = await setupClient.query(
      `SELECT (SELECT count(*) FROM app.stations WHERE name = $1)::integer AS stations,
              (SELECT status FROM app.stations WHERE id = $2) AS station_status,
              (SELECT count(*) FROM app.clients WHERE station_id = $2)::integer AS clients,
              (SELECT role FROM app.station_memberships WHERE station_id = $2 AND portal_user_id = $3) AS role,
              (SELECT password_hash FROM app.portal_users WHERE id = $3) AS password_hash`,
      [seed.stationName, first.stationId, first.ownerId],
    );
    expect(counts.rows[0]).toMatchObject({ stations: 1, station_status: 'ACTIVE', clients: 2, role: 'OWNER' });
    expect(counts.rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it('adds sample ads in every state, with real audio and a history, and running it again adds none', async () => {
    const setupUrl = process.env.DATABASE_SETUP_URL as string;
    const { stationId, ownerId } = await seedDevelopmentData(setupUrl, seed);
    const storage: SampleStorage = {
      endpoint: process.env.OBJECT_STORAGE_ENDPOINT as string,
      region: process.env.OBJECT_STORAGE_REGION ?? 'auto',
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY as string,
      bucket: process.env.OBJECT_STORAGE_AD_UPLOADS_BUCKET as string,
    };

    expect(await seedSampleAds(setupClient, stationId, storage, ownerId)).toBe(SAMPLE_AD_TITLES.length);
    expect(await seedSampleAds(setupClient, stationId, storage, ownerId)).toBe(0);

    const ads = await setupClient.query(
      `SELECT ads.title, ads.status, ads.upload_object_key IS NOT NULL AS has_audio, ads.current_action_card_id IS NOT NULL AS has_buttons,
              app.campaign_display_status(campaign.id, now()) AS display_status
         FROM app.ads LEFT JOIN app.campaigns AS campaign ON campaign.ad_id = ads.id WHERE ads.station_id = $1 ORDER BY ads.title`,
      [stationId],
    );
    const byTitle = Object.fromEntries(ads.rows.map((row) => [row.title, row]));
    expect(Object.keys(byTitle).sort()).toEqual([...SAMPLE_AD_TITLES].sort());
    expect(byTitle['Summer service offer']).toMatchObject({ status: 'PROCESSING', has_audio: true, has_buttons: true, display_status: 'LIVE_NOW' });
    expect(byTitle['Weekend sale']).toMatchObject({ display_status: 'SCHEDULED' });
    expect(byTitle['Spring promo']).toMatchObject({ display_status: 'ENDED' });
    expect(byTitle['New menu launch']).toMatchObject({ display_status: 'DRAFT' });
    expect(byTitle['Back to school offer']).toMatchObject({ has_buttons: false, display_status: null });
    expect(byTitle['Festive greetings']).toMatchObject({ status: 'FAILED', has_audio: false });

    const history = await setupClient.query(
      `SELECT ads.title, array_agg(audit.action ORDER BY audit.occurred_at) AS actions
         FROM app.ads JOIN app.audit_events AS audit ON audit.entity_id = ads.id OR audit.changes ->> 'adId' = ads.id::text
        WHERE ads.station_id = $1 GROUP BY ads.title`,
      [stationId],
    );
    const actionsByTitle = Object.fromEntries(history.rows.map((row) => [row.title, row.actions]));
    expect(actionsByTitle['Summer service offer']).toEqual(['ad_created', 'ad_upload_verified', 'action_card_saved', 'campaign_schedule_saved', 'campaign_published']);
    expect(actionsByTitle['Festive greetings']).toEqual(['ad_created', 'ad_upload_refused']);
  });

  it('refuses a weak owner password and refuses to run in production', async () => {
    const setupUrl = process.env.DATABASE_SETUP_URL as string;
    await expect(seedDevelopmentData(setupUrl, { ...seed, ownerPassword: 'short' })).rejects.toThrow(/too_short/);
    const previousEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(seedDevelopmentData(setupUrl, seed)).rejects.toThrow(/Refusing to seed development data in production/);
    } finally {
      process.env.NODE_ENV = previousEnvironment;
    }
  });
});
