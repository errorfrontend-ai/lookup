import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Step 2 — buttons and schedules.
 *
 * - An ad points to its current action card version (ads.current_action_card_id); every save adds a
 *   new immutable version, and publishing hands the current one to the live campaign.
 * - app.is_time_window_open decides whether a weekly time window is open at a given moment, in the
 *   station's local time. A window whose end is before its start runs past midnight and belongs to
 *   the day it starts (Friday 22:00–02:00 is open at 01:00 on Saturday). Days are ISO (1 = Monday).
 *   The portal's "Live now" badge and, in Step 3, recognition both use this one definition.
 * - app.campaign_display_status turns a campaign's stored status and its windows into what a
 *   station sees: DRAFT, SCHEDULED, LIVE_NOW, PAUSED or ENDED.
 */
export class AdCardsAndSchedules1791200000000 implements MigrationInterface {
  name = 'AdCardsAndSchedules1791200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);

    await run(`
      ALTER TABLE app.ads
        ADD COLUMN current_action_card_id uuid,
        ADD CONSTRAINT ads_current_action_card_foreign_key
          FOREIGN KEY (current_action_card_id, station_id) REFERENCES app.action_cards (id, station_id)`);
    await run(`GRANT UPDATE (current_action_card_id) ON app.ads TO lookup_api`);
    await run(`
      ALTER TABLE app.action_cards ADD CONSTRAINT action_cards_schema_version_matches_content_check
        CHECK ((content ->> 'schema_version') = schema_version::text)`);
    await run(`CREATE INDEX campaigns_ad_index ON app.campaigns (ad_id)`);
    await run(`CREATE INDEX action_cards_client_index ON app.action_cards (client_id)`);

    await run(`
      CREATE FUNCTION app.is_time_window_open(days_of_week smallint[], local_start_time time, local_end_time time,
                                              local_moment timestamp) RETURNS boolean
        LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp
      AS $$
        SELECT CASE
          WHEN local_start_time < local_end_time THEN
            extract(isodow FROM local_moment)::smallint = ANY (days_of_week)
            AND local_moment::time >= local_start_time AND local_moment::time < local_end_time
          ELSE
            (extract(isodow FROM local_moment)::smallint = ANY (days_of_week) AND local_moment::time >= local_start_time)
            OR (extract(isodow FROM local_moment - interval '1 day')::smallint = ANY (days_of_week)
                AND local_moment::time < local_end_time)
        END
      $$`);

    // SECURITY INVOKER: it reads through the caller's row-level security, so a station only ever gets
    // answers about its own campaigns.
    await run(`
      CREATE FUNCTION app.campaign_display_status(for_campaign_id uuid, at_moment timestamptz) RETURNS text
        LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
      AS $$
        SELECT CASE
          WHEN campaign.status IN ('DRAFT', 'PAUSED', 'ENDED') THEN campaign.status
          WHEN upper(campaign.active_period) <= at_moment THEN 'ENDED'
          WHEN lower(campaign.active_period) > at_moment THEN 'SCHEDULED'
          WHEN EXISTS (
            SELECT 1 FROM app.campaign_time_windows AS time_window
             WHERE time_window.campaign_id = campaign.id
               AND app.is_time_window_open(time_window.days_of_week, time_window.local_start_time,
                                           time_window.local_end_time, at_moment AT TIME ZONE station.time_zone)
          ) THEN 'LIVE_NOW'
          ELSE 'SCHEDULED'
        END
          FROM app.campaigns AS campaign
          JOIN app.stations AS station ON station.id = campaign.station_id
         WHERE campaign.id = for_campaign_id
      $$`);
    await run(`
      GRANT EXECUTE ON FUNCTION app.is_time_window_open(smallint[], time, time, timestamp),
                                app.campaign_display_status(uuid, timestamptz)
        TO lookup_api, lookup_admin_api`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);
    await run(`DROP FUNCTION IF EXISTS app.campaign_display_status(uuid, timestamptz)`);
    await run(`DROP FUNCTION IF EXISTS app.is_time_window_open(smallint[], time, time, timestamp)`);
    await run(`DROP INDEX IF EXISTS app.action_cards_client_index`);
    await run(`DROP INDEX IF EXISTS app.campaigns_ad_index`);
    await run(`ALTER TABLE app.action_cards DROP CONSTRAINT IF EXISTS action_cards_schema_version_matches_content_check`);
    await run(`REVOKE UPDATE (current_action_card_id) ON app.ads FROM lookup_api`);
    await run(`ALTER TABLE app.ads DROP CONSTRAINT IF EXISTS ads_current_action_card_foreign_key, DROP COLUMN IF EXISTS current_action_card_id`);
  }
}
