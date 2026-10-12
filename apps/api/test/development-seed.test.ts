import { createHash, randomUUID } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ActionCard } from '@lookup/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  giveSampleCardsSafeNumbers,
  SAMPLE_AD_TITLES,
  SAMPLE_DEFAULT_CARDS,
  type SampleStorage,
  SECOND_STATION_SAMPLE_ADS,
  SECOND_STATION_SAMPLE_DEFAULT_CARDS,
  seedDefaultCards,
  seedSampleAds,
} from '../scripts/sample-ads.js';
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
  /** The second station, as the seed makes Station B: the same owner, in Kitwe, with Brand A only. */
  const secondStationSeed = { ...seed, stationName: `Seed Station B ${runTag}`, frequencyLabel: '104.3 FM', province: 'Copperbelt', city: 'Kitwe', clientNames: ['Brand A'] };

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
    const station = await setupClient.query(`SELECT id FROM app.stations WHERE name = ANY($1)`, [[seed.stationName, secondStationSeed.stationName]]);
    const stationIds = station.rows.map((row) => row.id);
    await setupClient.query('DELETE FROM app.audit_events WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.campaigns WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('DELETE FROM app.ads WHERE station_id = ANY($1)', [stationIds]);
    await setupClient.query('UPDATE app.clients SET default_action_card_id = NULL WHERE station_id = ANY($1)', [stationIds]);
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

  /** The bytes of each ad's uploaded audio at the station, by title, as SHA-256 digests. */
  async function audioDigests(stationId: string): Promise<Record<string, string>> {
    const storage = sampleStorage();
    const storageClient = new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      forcePathStyle: true,
      credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    try {
      const ads = await setupClient.query(`SELECT title, upload_object_key FROM app.ads WHERE station_id = $1 AND upload_object_key IS NOT NULL`, [stationId]);
      const digests: Record<string, string> = {};
      for (const ad of ads.rows) {
        const object = await storageClient.send(new GetObjectCommand({ Bucket: storage.bucket, Key: ad.upload_object_key }));
        digests[ad.title as string] = createHash('sha256').update(await (object.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray()).digest('hex');
      }
      return digests;
    } finally {
      storageClient.destroy();
    }
  }

  it('adds a second station with the same owner as a member, its client and a draft of the shared ad on the same jingle, and running it again adds nothing', async () => {
    const setupUrl = process.env.DATABASE_SETUP_URL as string;
    const first = await seedDevelopmentData(setupUrl, seed);
    const second = await seedDevelopmentData(setupUrl, secondStationSeed);
    expect(second.ownerId).toBe(first.ownerId);
    expect(second.stationId).not.toBe(first.stationId);
    const station = await setupClient.query(
      `SELECT station.name, station.frequency_label, station.province, station.city, station.status, station.is_listed_in_app, membership.role
         FROM app.stations AS station JOIN app.station_memberships AS membership ON membership.station_id = station.id AND membership.portal_user_id = $2
        WHERE station.id = $1`,
      [second.stationId, second.ownerId],
    );
    expect(station.rows).toEqual([
      { name: secondStationSeed.stationName, frequency_label: '104.3 FM', province: 'Copperbelt', city: 'Kitwe', status: 'ACTIVE', is_listed_in_app: true, role: 'OWNER' },
    ]);

    await seedSampleAds(setupClient, first.stationId, sampleStorage(), first.ownerId);
    expect(await seedSampleAds(setupClient, second.stationId, sampleStorage(), second.ownerId, SECOND_STATION_SAMPLE_ADS)).toBe(1);
    expect(await seedSampleAds(setupClient, second.stationId, sampleStorage(), second.ownerId, SECOND_STATION_SAMPLE_ADS)).toBe(0);
    const draft = await setupClient.query(
      `SELECT ads.title, ads.status, ads.current_action_card_id IS NOT NULL AS has_buttons, campaign.status AS campaign_status, campaign.action_card_id,
              (SELECT json_agg(json_build_object('days', time_window.days_of_week, 'from', time_window.local_start_time::text, 'to', time_window.local_end_time::text)
                       ORDER BY time_window.local_start_time)
                 FROM app.campaign_time_windows AS time_window WHERE time_window.campaign_id = campaign.id) AS windows
         FROM app.ads JOIN app.campaigns AS campaign ON campaign.ad_id = ads.id WHERE ads.station_id = $1`,
      [second.stationId],
    );
    expect(draft.rows).toEqual([
      {
        title: 'Summer service offer',
        status: 'PROCESSING',
        has_buttons: true,
        campaign_status: 'DRAFT',
        action_card_id: null,
        windows: [
          { days: [1, 2, 3, 4, 5, 6, 7], from: '00:00:00', to: '12:00:00' },
          { days: [1, 2, 3, 4, 5, 6, 7], from: '12:00:00', to: '00:00:00' },
        ],
      },
    ]);

    // One recording for both stations' "Summer service offer", and a recording of its own for every other sample ad.
    const firstStationAudio = await audioDigests(first.stationId);
    const secondStationAudio = await audioDigests(second.stationId);
    expect(secondStationAudio['Summer service offer']).toBe(firstStationAudio['Summer service offer']);
    expect(new Set(Object.values(firstStationAudio)).size).toBe(Object.keys(firstStationAudio).length);
  });

  it('gives Brand A at both stations and Brand B at the first a usual card, each with its own number from the drama range, audited, and running it again sets none', async () => {
    const setupUrl = process.env.DATABASE_SETUP_URL as string;
    const first = await seedDevelopmentData(setupUrl, seed);
    const second = await seedDevelopmentData(setupUrl, secondStationSeed);
    await seedSampleAds(setupClient, first.stationId, sampleStorage(), first.ownerId);
    expect(await seedDefaultCards(setupClient, first.stationId, first.ownerId, SAMPLE_DEFAULT_CARDS)).toBe(2);
    expect(await seedDefaultCards(setupClient, second.stationId, second.ownerId, SECOND_STATION_SAMPLE_DEFAULT_CARDS)).toBe(1);
    expect(await seedDefaultCards(setupClient, first.stationId, first.ownerId, SAMPLE_DEFAULT_CARDS)).toBe(0);
    expect(await seedDefaultCards(setupClient, second.stationId, second.ownerId, SECOND_STATION_SAMPLE_DEFAULT_CARDS)).toBe(0);

    const usualCards = await setupClient.query(
      `SELECT station.name AS station_name, client.name AS client_name, card.client_id = client.id AS is_the_clients, card.content
         FROM app.clients AS client JOIN app.stations AS station ON station.id = client.station_id
         JOIN app.action_cards AS card ON card.id = client.default_action_card_id
        WHERE client.station_id = ANY($1) ORDER BY station.id = $2 DESC, client.name`,
      [[first.stationId, second.stationId], first.stationId],
    );
    expect(usualCards.rows.map((row) => [row.station_name, row.client_name, row.is_the_clients])).toEqual([
      [seed.stationName, 'Brand A', true],
      [seed.stationName, 'Brand B', true],
      [secondStationSeed.stationName, 'Brand A', true],
    ]);
    const numbers = usualCards.rows.map((row) => {
      expect(ActionCard.safeParse(row.content).success).toBe(true);
      return phoneNumbersOf(row.content as ActionCard);
    });
    for (const cardNumbers of numbers) {
      expect(cardNumbers).toHaveLength(1);
      expect(cardNumbers[0]).toMatch(/^\+447700900\d{3}$/);
    }
    // Each number is its own, also apart from the sample ads' cards.
    const adNumbers = Object.values(await currentCards(first.stationId)).flatMap(({ content }) => phoneNumbersOf(content));
    expect(new Set([...numbers.flat(), ...adNumbers]).size).toBe(numbers.length + new Set(adNumbers).size);
    expect(JSON.stringify(usualCards.rows)).not.toContain('+260');

    const audit = await setupClient.query(
      `SELECT entity_type, changes FROM app.audit_events WHERE station_id = ANY($1) AND action = 'client_default_card_changed'`,
      [[first.stationId, second.stationId]],
    );
    expect(audit.rows).toHaveLength(3);
    for (const row of audit.rows) {
      expect(row).toEqual({ entity_type: 'client', changes: { previousActionCardId: null, actionCardId: expect.any(String) } });
    }
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
