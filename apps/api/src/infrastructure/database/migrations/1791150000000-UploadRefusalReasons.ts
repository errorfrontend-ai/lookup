import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * When the API refuses an uploaded file (wrong size, not really audio), it records why, so the portal
 * can say what went wrong. The reason is a short code, never free text, and the status guard still
 * decides which statuses the API may set.
 */
export class UploadRefusalReasons1791150000000 implements MigrationInterface {
  name = 'UploadRefusalReasons1791150000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE app.ads ADD CONSTRAINT ads_processing_error_code_check
        CHECK (processing_error_code ~ '^[a-z][a-z_]{0,63}$')`);
    await queryRunner.query(`GRANT UPDATE (processing_error_code) ON app.ads TO lookup_api`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`REVOKE UPDATE (processing_error_code) ON app.ads FROM lookup_api`);
    await queryRunner.query(`ALTER TABLE app.ads DROP CONSTRAINT IF EXISTS ads_processing_error_code_check`);
  }
}
