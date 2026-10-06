/**
 * Development data: one ACTIVE station ("Station A", 98.1 FM), its owner, two clients and sample ads in
 * every state (with a short generated jingle as their audio), so the portal can be used and judged
 * straight away. Safe to run again (it updates rather than duplicates). Refuses to run in production.
 * Self sign-up replaces this for real stations (phase 5a).
 *
 *   npm run database:seed   (reads SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD from .env)
 */
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { PasswordPolicy } from '../src/features/authentication/password-policy.js';
import { loadDatabaseSetupConfig } from './database-setup-config.js';
import { type SampleStorage, seedSampleAds } from './sample-ads.js';

export interface DevelopmentSeed {
  stationName: string;
  frequencyLabel: string;
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
          `INSERT INTO app.stations (name, frequency_label, province, city, status) VALUES ($1, $2, 'Lusaka', 'Lusaka', 'ACTIVE') RETURNING id`,
          [seed.stationName, seed.frequencyLabel],
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

async function seedFromEnvironment(): Promise<string> {
  const { setupUrl } = loadDatabaseSetupConfig();
  const ownerEmail = process.env.SEED_OWNER_EMAIL;
  const ownerPassword = process.env.SEED_OWNER_PASSWORD;
  if (!ownerEmail || !ownerPassword) throw new Error('Missing configuration: SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD');
  const { stationId } = await seedDevelopmentData(setupUrl, {
    stationName: 'Station A',
    frequencyLabel: '98.1 FM',
    ownerEmail,
    ownerPassword,
    ownerFullName: 'Station A Owner',
    clientNames: ['Brand A', 'Brand B'],
  });
  const storage = sampleStorageFromEnvironment();
  if (!storage) return `Development data ready: Station A (${stationId}), its owner and two clients. Sample ads skipped: object storage settings are not set.`;
  const client = new pg.Client({ connectionString: setupUrl, application_name: 'lookup-development-seed' });
  await client.connect();
  try {
    const createdCount = await seedSampleAds(client, stationId, storage);
    return `Development data ready: Station A (${stationId}), its owner, two clients and ${createdCount === 0 ? 'its sample ads (already there)' : `${createdCount} new sample ads`}.`;
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
