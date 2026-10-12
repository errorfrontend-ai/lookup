import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseRoles } from '../scripts/create-database-roles.js';
import { loadDatabaseSetupConfig } from '../scripts/database-setup-config.js';
import { runMigrations } from '../scripts/run-migrations.js';
import { ALL_MIGRATIONS } from '../src/infrastructure/database/migrations/all-migrations.js';

/**
 * The fingerprint version 2 migration, 1791700000000-FingerprintVersionTwo (ADR-001, "Real captures, October 2026"),
 * run up and down as the migration script runs it, in a database of its own made for this test and dropped after it:
 * the down step refuses while a recording has hashes only for version 2, and otherwise removes version 2's table and
 * function and gives every recording back to version 1 with its version 1 hash count; up again brings both back with
 * the worker's rights only. Migrations released after it are reverted before it and
 * applied again after it, as revert-latest would.
 */
const MIGRATION_NAMES = ALL_MIGRATIONS.map((migration) => new migration().name);
const LATER_MIGRATION_NAMES = MIGRATION_NAMES.slice(MIGRATION_NAMES.indexOf('FingerprintVersionTwo1791700000000') + 1);

describe('the FingerprintVersionTwo migration, up and down', () => {
  const { setupUrl, rolePasswords } = loadDatabaseSetupConfig();
  const scratchDatabaseName = `lookup_migration_test_${randomBytes(4).toString('hex')}`;
  const scratchUrl = new URL(setupUrl);
  scratchUrl.pathname = `/${scratchDatabaseName}`;
  let scratchClient: pg.Client;
  const assetId = randomUUID();

  const onServer = async (sql: string) => {
    const serverClient = new pg.Client({ connectionString: setupUrl, application_name: 'lookup-tests-migration' });
    await serverClient.connect();
    try {
      await serverClient.query(sql);
    } finally {
      await serverClient.end();
    }
  };
  const rows = async <Row>(sql: string, parameters: unknown[] = []) => (await scratchClient.query(sql, parameters)).rows as Row[];
  const versionTwoObjects = async () =>
    (
      await rows<{ table_name: string | null; function_name: string | null }>(
        `SELECT to_regclass('fingerprints.hashes_version_2')::text AS table_name,
                to_regprocedure('fingerprints.record_asset_refingerprinted(integer, smallint)')::text AS function_name`,
      )
    )[0];

  beforeAll(async () => {
    await onServer(`CREATE DATABASE ${scratchDatabaseName}`);
    await createDatabaseRoles(scratchUrl.toString(), rolePasswords);
    await runMigrations(scratchUrl.toString());
    scratchClient = new pg.Client({ connectionString: scratchUrl.toString(), application_name: 'lookup-tests-migration' });
    await scratchClient.connect();
  }, 240_000);
  afterAll(async () => {
    await scratchClient?.end();
    await onServer(`DROP DATABASE IF EXISTS ${scratchDatabaseName} WITH (FORCE)`);
  }, 60_000);

  it('the down step refuses to strand a version 2 recording, otherwise removes version 2 and gives every recording back to version 1; up again gives the worker back its rights and nobody else any', async () => {
    // A recording moved to version 2, with hashes in both tables, as re-fingerprinting leaves it.
    const assetNumber = (
      await rows<{ asset_number: number }>(
        `INSERT INTO fingerprints.audio_assets (id, content_sha256, duration_milliseconds, fingerprint_version, hash_count) VALUES ($1, $2, 30000, 2, 1) RETURNING asset_number`,
        [assetId, randomBytes(32)],
      )
    )[0]?.asset_number as number;
    await scratchClient.query('INSERT INTO fingerprints.hashes_version_1 (hash, audio_asset_number, time_offset_frames) VALUES (11, $1, 0), (12, $1, 1)', [assetNumber]);
    await scratchClient.query('INSERT INTO fingerprints.hashes_version_2 (hash, audio_asset_number, time_offset_frames) VALUES (21, $1, 0)', [assetNumber]);

    // And one first stored on version 2: its hashes are only in version 2's table.
    const strandedId = randomUUID();
    const strandedNumber = (
      await rows<{ asset_number: number }>(
        `INSERT INTO fingerprints.audio_assets (id, content_sha256, duration_milliseconds, fingerprint_version, hash_count) VALUES ($1, $2, 30000, 2, 1) RETURNING asset_number`,
        [strandedId, randomBytes(32)],
      )
    )[0]?.asset_number as number;
    await scratchClient.query('INSERT INTO fingerprints.hashes_version_2 (hash, audio_asset_number, time_offset_frames) VALUES (31, $1, 0)', [strandedNumber]);

    // database:revert-latest: the later migrations first, once each; then FingerprintVersionTwo alone.
    for (const _later of LATER_MIGRATION_NAMES) await runMigrations(scratchUrl.toString(), { revertLatest: true });
    const revertVersionTwo = () => runMigrations(scratchUrl.toString(), { revertLatest: true });
    await expect(revertVersionTwo()).rejects.toThrow(/1 recording\(s\) have hashes only for fingerprint version 2/);
    expect(await versionTwoObjects()).toEqual({ table_name: 'fingerprints.hashes_version_2', function_name: 'fingerprints.record_asset_refingerprinted(integer,smallint)' });
    await scratchClient.query('DELETE FROM fingerprints.audio_assets WHERE id = $1', [strandedId]);

    await revertVersionTwo();
    expect((await rows<{ name: string }>('SELECT name FROM app.migrations ORDER BY id DESC LIMIT 1'))[0]?.name).toBe('StationResolution1791600000000');
    expect(await versionTwoObjects()).toEqual({ table_name: null, function_name: null });
    expect(await rows('SELECT count(*)::integer AS rows FROM fingerprints.hashes_version_1 WHERE audio_asset_number = $1', [assetNumber])).toEqual([{ rows: 2 }]);
    expect(await rows('SELECT fingerprint_version, hash_count FROM fingerprints.audio_assets WHERE id = $1', [assetId])).toEqual([{ fingerprint_version: 1, hash_count: 2 }]);

    // database:migrate, once more.
    expect(await runMigrations(scratchUrl.toString())).toEqual(['FingerprintVersionTwo1791700000000', ...LATER_MIGRATION_NAMES]);
    expect(await versionTwoObjects()).toEqual({ table_name: 'fingerprints.hashes_version_2', function_name: 'fingerprints.record_asset_refingerprinted(integer,smallint)' });
    const rights = await rows<{ role_name: string; can_read: boolean; can_record: boolean }>(
      `SELECT role_name, has_table_privilege(role_name, 'fingerprints.hashes_version_2', 'SELECT') AS can_read,
              has_function_privilege(role_name, 'fingerprints.record_asset_refingerprinted(integer, smallint)', 'EXECUTE') AS can_record
         FROM unnest(ARRAY['lookup_api', 'lookup_admin_api', 'lookup_fingerprint_worker']) AS role_name ORDER BY role_name`,
    );
    expect(rights).toEqual([
      { role_name: 'lookup_admin_api', can_read: false, can_record: false },
      { role_name: 'lookup_api', can_read: false, can_record: false },
      { role_name: 'lookup_fingerprint_worker', can_read: true, can_record: true },
    ]);
  }, 240_000);
});
