import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An ad's history reads the audit trail for one ad: the rows about the ad itself (entity id) and the
 * rows about its buttons and schedule (which carry the ad's id inside their changes). Without these two
 * indexes that would scan the station's whole trail; with them it reads only that ad's rows, newest first.
 */
export class AdHistoryIndexes1791400000000 implements MigrationInterface {
  name = 'AdHistoryIndexes1791400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX audit_events_entity_id_index ON app.audit_events (entity_id, id DESC) WHERE entity_id IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX audit_events_changes_ad_id_index ON app.audit_events ((changes ->> 'adId'), id DESC) WHERE changes ? 'adId'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX app.audit_events_changes_ad_id_index`);
    await queryRunner.query(`DROP INDEX app.audit_events_entity_id_index`);
  }
}
