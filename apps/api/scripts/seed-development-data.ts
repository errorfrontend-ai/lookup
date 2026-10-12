/**
 * Development data: two ACTIVE stations with one owner, so the portal can be used and judged straight away
 * and a listener's "Which station?" can be walked through (P4 design §5.15):
 *  - "Station A" (98.1 FM, Lusaka): two clients and sample ads in every state, each with a short generated
 *    jingle as its audio;
 *  - "Station B" (104.3 FM, Kitwe): Brand A's "Summer service offer" on the same jingle as Station A's, so
 *    the two share one recording, with its all-day schedule left as a draft to publish in the portal;
 *  - usual cards for Brand A at both stations and for Brand B at Station A.
 * Safe to run again (it updates rather than duplicates). Refuses to run in production. Self sign-up
 * replaces this for real stations (phase 5a).
 *
 *   npm run database:seed   (reads SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD from .env)
 */
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { PasswordPolicy } from '../src/features/authentication/password-policy.js';
import { loadDatabaseSetupConfig } from './database-setup-config.js';
import {
  giveSampleCardsSafeNumbers,
  SAMPLE_DEFAULT_CARDS,
  type SampleStorage,
  SECOND_STATION_SAMPLE_ADS,
  SECOND_STATION_SAMPLE_DEFAULT_CARDS,
  seedDefaultCards,
  seedSampleAds,
} from './sample-ads.js';

export interface DevelopmentSeed {
  stationName: string;
  frequencyLabel: string;
  /** Where the station is, as its profile says (Lusaka unless given). */
  province?: string;
  city?: string;
  ownerEmail: string;
  ownerPassword: string;
  ownerFullName: string;
  clientNames: string[];
}

export async function seedDevelopmentData(setupUrl: string, seed: DevelopmentSeed): Promise<{ stationId: string; ownerId: string }> {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed development data in production.');
  const refusalReason = new PasswordPolicy().check(seed.ownerPassword, {
    fullName: seed.ownerFullName,
    email: seed.ownerEmail,
    stationNames: [seed.stationName],
  });
  if (refusalReason) throw new Error(`SEED_OWNER_PASSWORD is not acceptable: ${refusalReason}`);
  const passwordHash = await new PasswordHasher().hashNewPassword(seed.ownerPassword);

  const client = new pg.Client({ connectionString: setupUrl, application_name: 'lookup-development-seed' });
  await client.connect();
  try {
    await client.query('BEGIN');
    const existingStation = await client.query(`SELECT id FROM app.stations WHERE name = $1 AND frequency_label = $2`, [
      seed.stationName,
      seed.frequencyLabel,
    ]);
    const stationId: string =
      existingStation.rows[0]?.id ??
      (
        await client.query(
          `INSERT INTO app.stations (name, frequency_label, province, city, status) VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id`,
          [seed.stationName, seed.frequencyLabel, seed.province ?? 'Lusaka', seed.city ?? 'Lusaka'],
        )
      ).rows[0].id;
    await client.query(`UPDATE app.stations SET status = 'ACTIVE' WHERE id = $1`, [stationId]);

    const owner = await client.query(
      `INSERT INTO app.portal_users (email, password_hash, full_name) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET password_hash = excluded.password_hash, full_name = excluded.full_name, status = 'ACTIVE',
                                         consecutive_failed_sign_in_count = 0, last_failed_sign_in_at = NULL
       RETURNING id`,
      [seed.ownerEmail, passwordHash, seed.ownerFullName],
    );
    const ownerId: string = owner.rows[0].id;
    await client.query(
      `INSERT INTO app.station_memberships (station_id, portal_user_id, role) VALUES ($1, $2, 'OWNER')
       ON CONFLICT (station_id, portal_user_id) DO UPDATE SET role = 'OWNER'`,
      [stationId, ownerId],
    );
    for (const clientName of seed.clientNames) {
      await client.query(`INSERT INTO app.clients (station_id, name) VALUES ($1, $2) ON CONFLICT (station_id, name) DO NOTHING`, [
        stationId,
        clientName,
      ]);
    }
    await client.query('COMMIT');
    return { stationId, ownerId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** The development object storage, from the same settings the API uses; null when they aren't all set. */
function sampleStorageFromEnvironment(): SampleStorage | null {
  const { OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_REGION, OBJECT_STORAGE_ACCESS_KEY_ID, OBJECT_STORAGE_SECRET_ACCESS_KEY, OBJECT_STORAGE_AD_UPLOADS_BUCKET } = process.env;
  if (!OBJECT_STORAGE_ENDPOINT || !OBJECT_STORAGE_ACCESS_KEY_ID || !OBJECT_STORAGE_SECRET_ACCESS_KEY || !OBJECT_STORAGE_AD_UPLOADS_BUCKET) return null;
  return {
    endpoint: OBJECT_STORAGE_ENDPOINT,
    region: OBJECT_STORAGE_REGION ?? 'auto',
    accessKeyId: OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: OBJECT_STORAGE_SECRET_ACCESS_KEY,
    bucket: OBJECT_STORAGE_AD_UPLOADS_BUCKET,
  };
}

/** Where a station's pages open in the portal: the first allowed browser origin (the portal), or the local one. */
function portalPageOf(stationId: string): string {
  const portalOrigin = (process.env.ALLOWED_BROWSER_ORIGINS ?? '').split(',')[0]?.trim() || 'http://localhost:5180';
  return `${portalOrigin}/stations/${stationId}/ads`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

async function seedFromEnvironment(): Promise<string> {
  const { setupUrl } = loadDatabaseSetupConfig();
  const ownerEmail = process.env.SEED_OWNER_EMAIL;
  const ownerPassword = process.env.SEED_OWNER_PASSWORD;
  if (!ownerEmail || !ownerPassword) throw new Error('Missing configuration: SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD');
  const owner = { ownerEmail, ownerPassword, ownerFullName: 'Station A Owner' };
  const { stationId, ownerId } = await seedDevelopmentData(setupUrl, { stationName: 'Station A', frequencyLabel: '98.1 FM', ...owner, clientNames: ['Brand A', 'Brand B'] });
  // The same owner is a member of Station B too, so one sign-in opens both stations' pages.
  const secondStation = await seedDevelopmentData(setupUrl, {
    stationName: 'Station B',
    frequencyLabel: '104.3 FM',
    province: 'Copperbelt',
    city: 'Kitwe',
    ...owner,
    clientNames: ['Brand A'],
  });
  const pages = [
    `  Station A (98.1 FM, Lusaka): ${portalPageOf(stationId)}`,
    `  Station B (104.3 FM, Kitwe): ${portalPageOf(secondStation.stationId)}`,
  ].join('\n');

  const client = new pg.Client({ connectionString: setupUrl, application_name: 'lookup-development-seed' });
  await client.connect();
  try {
    const defaultCardCount =
      (await seedDefaultCards(client, stationId, ownerId, SAMPLE_DEFAULT_CARDS)) +
      (await seedDefaultCards(client, secondStation.stationId, ownerId, SECOND_STATION_SAMPLE_DEFAULT_CARDS));
    const defaultCardsNote = defaultCardCount === 0 ? 'Usual cards: already there.' : `Usual cards: ${plural(defaultCardCount, 'client')} given one.`;
    const storage = sampleStorageFromEnvironment();
    if (!storage) return `Development data ready, one owner for both stations:\n${pages}\n${defaultCardsNote} Sample ads skipped: object storage settings are not set.`;
    const createdCount =
      (await seedSampleAds(client, stationId, storage, ownerId)) + (await seedSampleAds(client, secondStation.stationId, storage, ownerId, SECOND_STATION_SAMPLE_ADS));
    const safeNumberCount = await giveSampleCardsSafeNumbers(client, stationId, ownerId);
    const safeNumbersNote = safeNumberCount === 0 ? '' : ` ${plural(safeNumberCount, 'older sample card')} now have safe sample phone numbers.`;
    const adsNote = createdCount === 0 ? 'Sample ads: already there.' : `Sample ads: ${createdCount} new; the ingest worker prepares them for recognition within a minute or two of the API starting.`;
    return `Development data ready, one owner for both stations:\n${pages}\n${adsNote} ${defaultCardsNote}${safeNumbersNote}`;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedFromEnvironment()
    .then((message) => console.log(message))
    .catch((error: unknown) => {
      console.error('Could not seed development data:', error instanceof Error ? error.message : 'unknown error');
      process.exit(1);
    });
}
