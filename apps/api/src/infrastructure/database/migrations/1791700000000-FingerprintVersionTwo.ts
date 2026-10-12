import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fingerprint version 2 (ADR-001, "Real captures, October 2026"): denser landmarks chosen from real phone
 * recordings, so every hash changes and they live in a table of their own. Version 1's table stays, untouched,
 * until P8 drops it; the workers read and write only the table of the version they run.
 *
 *  - fingerprints.hashes_version_2: the same shape, foreign key and indexes as version 1, and the same rights
 *    for lookup_fingerprint_worker (read, add, remove); nothing for either API role.
 *  - fingerprints.record_asset_refingerprinted: the worker has no UPDATE on audio_assets, so after writing an
 *    asset's new hashes it records the new version through this function, which counts the hashes itself rather
 *    than trusting the caller, and changes only an asset still on an older version. It is SECURITY DEFINER with
 *    its search path pinned, and executable by lookup_fingerprint_worker only.
 *
 * Down gives every recording back to version 1, with version 1's own hash count, and refuses while any recording has
 * hashes only in version 2's table (one first stored after the switch): dropping them would leave its ads unrecognisable
 * for good, as the de-duplication would link any new upload of the same file to it.
 */
export class FingerprintVersionTwo1791700000000 implements MigrationInterface {
  name = 'FingerprintVersionTwo1791700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);

    await run(`
      CREATE TABLE fingerprints.hashes_version_2 (
        hash               bigint  NOT NULL,
        audio_asset_number integer NOT NULL,
        time_offset_frames integer NOT NULL,
        CONSTRAINT hashes_version_2_audio_asset_foreign_key
          FOREIGN KEY (audio_asset_number) REFERENCES fingerprints.audio_assets (asset_number) ON DELETE CASCADE
      )`);
    await run(`
      CREATE INDEX hashes_version_2_hash_index ON fingerprints.hashes_version_2 (hash)
        INCLUDE (audio_asset_number, time_offset_frames)`);
    await run(`CREATE INDEX hashes_version_2_audio_asset_index ON fingerprints.hashes_version_2 (audio_asset_number)`);
    await run(`GRANT SELECT, INSERT, DELETE ON fingerprints.hashes_version_2 TO lookup_fingerprint_worker`);

    // Returns true when the asset moved to the new version, false when it was already there (or newer) or does
    // not exist, so a repeated or a second, concurrent job changes nothing and its caller rolls its rows back.
    await run(`
      CREATE FUNCTION fingerprints.record_asset_refingerprinted(refingerprinted_asset_number integer, new_fingerprint_version smallint)
        RETURNS boolean
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, fingerprints, pg_temp
      AS $$
      DECLARE
        version_table_name text := 'hashes_version_' || new_fingerprint_version;
        counted_hashes integer;
      BEGIN
        IF refingerprinted_asset_number IS NULL OR new_fingerprint_version IS NULL OR new_fingerprint_version < 1 THEN
          RAISE EXCEPTION 'give an asset number and a fingerprint version of at least 1' USING ERRCODE = '22023';
        END IF;
        IF to_regclass(format('fingerprints.%I', version_table_name)) IS NULL THEN
          RAISE EXCEPTION 'there is no hash table for that fingerprint version' USING ERRCODE = '22023';
        END IF;
        EXECUTE format('SELECT count(*)::integer FROM fingerprints.%I WHERE audio_asset_number = $1', version_table_name)
          INTO counted_hashes USING refingerprinted_asset_number;
        UPDATE fingerprints.audio_assets
           SET fingerprint_version = new_fingerprint_version, hash_count = counted_hashes
         WHERE asset_number = refingerprinted_asset_number AND fingerprint_version < new_fingerprint_version;
        RETURN FOUND;
      END
      $$`);
    await run(`REVOKE ALL ON FUNCTION fingerprints.record_asset_refingerprinted(integer, smallint) FROM PUBLIC`);
    await run(`GRANT EXECUTE ON FUNCTION fingerprints.record_asset_refingerprinted(integer, smallint) TO lookup_fingerprint_worker`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);
    await run(`
      DO $$
      DECLARE
        version_two_only integer;
      BEGIN
        SELECT count(*) INTO version_two_only FROM fingerprints.audio_assets AS asset
         WHERE asset.fingerprint_version >= 2
           AND NOT EXISTS (SELECT 1 FROM fingerprints.hashes_version_1 AS hash WHERE hash.audio_asset_number = asset.asset_number);
        IF version_two_only > 0 THEN
          RAISE EXCEPTION '% recording(s) have hashes only for fingerprint version 2; reverting would leave their ads unrecognisable. Remove them, or fingerprint them for version 1, first.', version_two_only
            USING ERRCODE = '55000';
        END IF;
      END
      $$`);
    await run(`
      UPDATE fingerprints.audio_assets AS asset
         SET fingerprint_version = 1,
             hash_count = (SELECT count(*)::integer FROM fingerprints.hashes_version_1 AS hash WHERE hash.audio_asset_number = asset.asset_number)
       WHERE asset.fingerprint_version >= 2`);
    await run(`DROP FUNCTION fingerprints.record_asset_refingerprinted(integer, smallint)`);
    await run(`DROP TABLE fingerprints.hashes_version_2`);
  }
}
