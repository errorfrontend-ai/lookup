import { randomUUID } from 'node:crypto';
import type { ActionCard } from '@lookup/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { giveSampleCardsSafeNumbers, type SampleStorage, SAMPLE_AD_TITLES, seedSampleAds } from '../scripts/sample-ads.js';
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

  const sampleStorage = (): SampleStorage => ({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT as string,
    region: process.env.OBJECT_STORAGE_REGION ?? 'auto',
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID as string,
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY as string,
    bucket: process.env.OBJECT_STORAGE_AD_UPLOADS_BUCKET as string,
  });

  /** Each sample ad's current card, by title. */
  async function currentCards(stationId: string): Promise<Record<string, { id: string; content: ActionCard }>> {
    const cards = await setupClient.query(
      `SELECT ads.title, card.id, card.content FROM app.ads JOIN app.action_cards AS card ON card.id = ads.current_action_card_id WHERE ads.station_id = $1`,
      [stationId],
    );
    return Object.fromEntries(cards.rows.map((row) => [row.title, { id: row.id, content: row.content }]));
  }
  const phoneNumbersOf = (card: ActionCard) => card.actions.flatMap((action) => (action.type === 'CALL' || action.type === 'WHATSAPP' ? [action.phone_number_e164] : []));

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
    const storage = sampleStorage();

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

  it('gives every sample card its own phone number from the drama range, +44 7700 900000 to 900999, never a realistic one', async () => {
    const setupUrl = process.env.DATABASE_SETUP_URL as string;
    const { stationId, ownerId } = await seedDevelopmentData(setupUrl, seed);
    await seedSampleAds(setupClient, stationId, sampleStorage(), ownerId);

    const cards = Object.values(await currentCards(stationId));
    expect(cards.length).toBe(5);
    const numberOfEachCard = cards.map(({ content }) => {
      const numbers = new Set(phoneNumbersOf(content));
      expect(numbers.size).toBe(1);
      return [...numbers][0];
    });
    for (const number of numberOfEachCard) expect(number).toMatch(/^\+447700900\d{3}$/);
    expect(new Set(numberOfEachCard).size).toBe(cards.length);
    expect(JSON.stringify(cards)).not.toContain('+260');
  });

  it('gives an older seed-made card a new version with its safe number, which its ad and live campaign show; a card saved in the portal is left alone', async () => {
    const setupUrl = process.env.DATABASE_SETUP_URL as string;
    const { stationId, ownerId } = await seedDevelopmentData(setupUrl, seed);
    await seedSampleAds(setupClient, stationId, sampleStorage(), ownerId);
    const before = await currentCards(stationId);
    // Not the drama range, and not anyone's number either: North America's 555-0100 to 555-0199 is kept for fiction.
    const numberOutsideTheDramaRange = '+12025550123';
    const withNumber = (card: ActionCard, phoneNumber: string): ActionCard => ({
      ...card,
      actions: card.actions.map((action) => (action.type === 'CALL' || action.type === 'WHATSAPP' ? { ...action, phone_number_e164: phoneNumber } : action)),
    });
    const addCurrentCard = async (title: string, content: ActionCard, createdBy: string | null) => {
      const cardId = randomUUID();
      await setupClient.query(
        `INSERT INTO app.action_cards (id, station_id, client_id, schema_version, content, created_by_portal_user_id)
         SELECT $1::uuid, $2::uuid, ads.client_id, 1, $4::jsonb, $5::uuid FROM app.ads WHERE ads.station_id = $2 AND ads.title = $3`,
        [cardId, stationId, title, JSON.stringify(content), createdBy],
      );
      await setupClient.query(`UPDATE app.ads SET current_action_card_id = $1 WHERE station_id = $2 AND title = $3`, [cardId, stationId, title]);
      await setupClient.query(
        `UPDATE app.campaigns SET action_card_id = $1 FROM app.ads WHERE ads.id = campaigns.ad_id AND ads.station_id = $2 AND ads.title = $3 AND campaigns.status = 'ACTIVE'`,
        [cardId, stationId, title],
      );
      return cardId;
    };
    // As the seed made cards before the safe numbers, and as a developer might save one in the portal.
    const olderSeedCard = withNumber((before['Summer service offer'] as { content: ActionCard }).content, numberOutsideTheDramaRange);
    const olderSeedCardId = await addCurrentCard('Summer service offer', olderSeedCard, null);
    const portalCardId = await addCurrentCard('Harvest festival', withNumber((before['Harvest festival'] as { content: ActionCard }).content, numberOutsideTheDramaRange), ownerId);

    expect(await giveSampleCardsSafeNumbers(setupClient, stationId, ownerId)).toBe(1);
    expect(await giveSampleCardsSafeNumbers(setupClient, stationId, ownerId)).toBe(0);

    const after = await currentCards(stationId);
    const replaced = after['Summer service offer'] as { id: string; content: ActionCard };
    expect(replaced.id).not.toBe(olderSeedCardId);
    expect(new Set(phoneNumbersOf(replaced.content))).toEqual(new Set(['+447700900001']));
    expect(replaced.content.actions.map((action) => action.id)).toEqual(olderSeedCard.actions.map((action) => action.id));
    const campaign = await setupClient.query(
      `SELECT campaigns.action_card_id FROM app.campaigns JOIN app.ads ON ads.id = campaigns.ad_id WHERE ads.station_id = $1 AND ads.title = 'Summer service offer'`,
      [stationId],
    );
    expect(campaign.rows[0].action_card_id).toBe(replaced.id);
    // Card versions are never edited: the older one is still as it was.
    const olderVersion = await setupClient.query(`SELECT content FROM app.action_cards WHERE id = $1`, [olderSeedCardId]);
    expect(olderVersion.rows[0].content).toEqual(olderSeedCard);
    // The history says which fields changed, never the numbers.
    const audit = await setupClient.query(`SELECT changes FROM app.audit_events WHERE action = 'action_card_saved' AND entity_id = $1`, [replaced.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].changes.previousActionCardId).toBe(olderSeedCardId);
    expect(audit.rows[0].changes.changedFields).toContainEqual({ path: `actions.${olderSeedCard.actions[0]?.id}.phone_number_e164`, change: 'changed' });
    expect(JSON.stringify(audit.rows[0].changes)).not.toMatch(/\+447700900|5550123/);
    expect((after['Harvest festival'] as { id: string }).id).toBe(portalCardId);
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
