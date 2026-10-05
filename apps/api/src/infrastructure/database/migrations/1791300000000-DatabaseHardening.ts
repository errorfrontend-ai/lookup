import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gaps found by the Step 1–2 requirements audit:
 *  - every foreign key gets an index led by its first column, so deleting or changing a referenced
 *    row never scans the referencing table (nullable keys get partial indexes, which a key lookup
 *    can still use);
 *  - a time window's days of the week must be distinct in the database too, not only in the API;
 *  - partitions of recognition_events get readable index and constraint names derived from their
 *    parent's (recognition_events_2026_10_primary_key, not recognition_events_2026_10_pkey), now and
 *    for every partition created later; the migrations table's primary key gets a readable name;
 *  - each session refresh is recorded in the audit trail, not only refresh-token reuse.
 */
export class DatabaseHardening1791300000000 implements MigrationInterface {
  name = 'DatabaseHardening1791300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);

    // ---- an index for every foreign key -----------------------------------------------------
    await run(`CREATE INDEX clients_default_action_card_index ON app.clients (default_action_card_id) WHERE default_action_card_id IS NOT NULL`);
    await run(`CREATE INDEX action_cards_created_by_index ON app.action_cards (created_by_portal_user_id) WHERE created_by_portal_user_id IS NOT NULL`);
    await run(`CREATE INDEX ads_client_index ON app.ads (client_id)`);
    await run(`CREATE INDEX ads_current_action_card_index ON app.ads (current_action_card_id) WHERE current_action_card_id IS NOT NULL`);
    await run(`CREATE INDEX campaigns_action_card_index ON app.campaigns (action_card_id)`);
    await run(`CREATE INDEX audit_events_actor_index ON app.audit_events (actor_portal_user_id) WHERE actor_portal_user_id IS NOT NULL`);
    await run(`CREATE INDEX recognition_events_listener_install_index ON app.recognition_events (listener_install_id)`);
    await run(`CREATE INDEX recognition_events_audio_asset_index ON app.recognition_events (audio_asset_id) WHERE audio_asset_id IS NOT NULL`);
    await run(`CREATE INDEX recognition_events_hinted_station_index ON app.recognition_events (hinted_station_id) WHERE hinted_station_id IS NOT NULL`);

    // ---- distinct days of the week ----------------------------------------------------------
    // A CHECK can't hold a subquery, but it can call an IMMUTABLE function that has one.
    await run(`
      CREATE FUNCTION app.has_distinct_elements(elements smallint[]) RETURNS boolean
        LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
        AS $$ SELECT count(*) = count(DISTINCT element) FROM unnest(elements) AS element $$`);
    // Whoever writes a row runs its checks, so the roles that write time windows need EXECUTE.
    await run(`GRANT EXECUTE ON FUNCTION app.has_distinct_elements(smallint[]) TO lookup_api, lookup_admin_api`);
    await run(`ALTER TABLE app.campaign_time_windows DROP CONSTRAINT campaign_time_windows_days_of_week_check`);
    await run(`
      ALTER TABLE app.campaign_time_windows ADD CONSTRAINT campaign_time_windows_days_of_week_check
        CHECK (days_of_week <@ '{1,2,3,4,5,6,7}'::smallint[] AND cardinality(days_of_week) BETWEEN 1 AND 7
               AND app.has_distinct_elements(days_of_week))`);

    // ---- readable names for partition indexes and constraints ------------------------------
    await run(`
      CREATE FUNCTION app.name_recognition_event_partition_indexes(partition_name text) RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        child_index_name  text;
        parent_index_name text;
        readable_name     text;
      BEGIN
        FOR child_index_name, parent_index_name IN
          SELECT child_index.relname, parent_index.relname
            FROM pg_index AS index_entry
            JOIN pg_class AS child_index ON child_index.oid = index_entry.indexrelid
            JOIN pg_inherits AS inheritance ON inheritance.inhrelid = index_entry.indexrelid
            JOIN pg_class AS parent_index ON parent_index.oid = inheritance.inhparent
           WHERE index_entry.indrelid = to_regclass('app.' || quote_ident(partition_name))
        LOOP
          -- recognition_events_primary_key on the parent becomes <partition>_primary_key; renaming an
          -- index that backs a constraint renames the constraint too.
          readable_name := partition_name || substr(parent_index_name, length('recognition_events') + 1);
          IF child_index_name <> readable_name THEN
            EXECUTE format('ALTER INDEX app.%I RENAME TO %I', child_index_name, readable_name);
          END IF;
        END LOOP;
      END $$`);
    await run(PARTITION_FUNCTION_NAMING_ITS_INDEXES);
    await run(`
      SELECT app.name_recognition_event_partition_indexes(partition_table.relname)
        FROM pg_inherits AS inheritance
        JOIN pg_class AS partition_table ON partition_table.oid = inheritance.inhrelid
       WHERE inheritance.inhparent = 'app.recognition_events'::regclass`);
    await run(`
      DO $$
      DECLARE generated_name text;
      BEGIN
        SELECT conname INTO generated_name FROM pg_constraint WHERE conrelid = 'app.migrations'::regclass AND contype = 'p';
        IF generated_name IS DISTINCT FROM 'migrations_primary_key' THEN
          EXECUTE format('ALTER TABLE app.migrations RENAME CONSTRAINT %I TO migrations_primary_key', generated_name);
        END IF;
      END $$`);

    // ---- audit each refresh ------------------------------------------------------------------
    await run(rotateRefreshTokenFunction({ auditsEachRefresh: true }));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);
    await run(rotateRefreshTokenFunction({ auditsEachRefresh: false }));
    // TypeORM's own name for this key; nothing depends on either name.
    await run(`ALTER TABLE app.migrations RENAME CONSTRAINT migrations_primary_key TO "PK_8c82d7f526340ab734260ea46be"`);
    // Partition index names stay readable: names change nothing about behaviour.
    await run(PARTITION_FUNCTION_ORIGINAL);
    await run(`DROP FUNCTION app.name_recognition_event_partition_indexes(text)`);
    await run(`ALTER TABLE app.campaign_time_windows DROP CONSTRAINT campaign_time_windows_days_of_week_check`);
    await run(`
      ALTER TABLE app.campaign_time_windows ADD CONSTRAINT campaign_time_windows_days_of_week_check
        CHECK (days_of_week <@ '{1,2,3,4,5,6,7}'::smallint[] AND cardinality(days_of_week) BETWEEN 1 AND 7)`);
    await run(`DROP FUNCTION app.has_distinct_elements(smallint[])`);
    for (const indexName of [
      'recognition_events_hinted_station_index',
      'recognition_events_audio_asset_index',
      'recognition_events_listener_install_index',
      'audit_events_actor_index',
      'campaigns_action_card_index',
      'ads_current_action_card_index',
      'ads_client_index',
      'action_cards_created_by_index',
      'clients_default_action_card_index',
    ]) {
      await run(`DROP INDEX app.${indexName}`);
    }
  }
}

/** The partition function from the Foundation migration, with or without naming the new partition's indexes. */
function partitionFunction(namesItsIndexes: boolean): string {
  return `
      CREATE OR REPLACE FUNCTION app.create_recognition_event_partitions(months_ahead integer) RETURNS integer
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        first_month    timestamp := date_trunc('month', now() AT TIME ZONE 'UTC');
        month_start    timestamp;
        partition_name text;
        created_count  integer := 0;
      BEGIN
        IF months_ahead IS NULL OR months_ahead < 0 OR months_ahead > 24 THEN
          RAISE EXCEPTION 'months_ahead must be between 0 and 24';
        END IF;
        FOR month_offset IN 0..months_ahead LOOP
          month_start := first_month + make_interval(months => month_offset);
          partition_name := 'recognition_events_' || to_char(month_start, 'YYYY_MM');
          IF to_regclass('app.' || partition_name) IS NULL THEN
            EXECUTE format(
              'CREATE TABLE app.%I PARTITION OF app.recognition_events FOR VALUES FROM (%L) TO (%L)',
              partition_name,
              month_start AT TIME ZONE 'UTC',
              (month_start + interval '1 month') AT TIME ZONE 'UTC');${
                namesItsIndexes ? '\n            PERFORM app.name_recognition_event_partition_indexes(partition_name);' : ''
              }
            created_count := created_count + 1;
          END IF;
        END LOOP;
        RETURN created_count;
      END $$`;
}

const PARTITION_FUNCTION_NAMING_ITS_INDEXES = partitionFunction(true);
const PARTITION_FUNCTION_ORIGINAL = partitionFunction(false);

/** The refresh function from the StationPortal migration; this migration adds one audit row per refresh. */
function rotateRefreshTokenFunction(options: { auditsEachRefresh: boolean }): string {
  const auditRefresh = options.auditsEachRefresh
    ? `
        INSERT INTO app.audit_events (actor_portal_user_id, action, entity_type, entity_id, request_id)
        VALUES (presented_token.portal_user_id, 'session_refreshed', 'portal_session', owning_session.id, request_id);`
    : '';
  return `
      CREATE OR REPLACE FUNCTION app.rotate_portal_refresh_token(presented_token_hash bytea, new_refresh_token_hash bytea, request_id text)
        RETURNS TABLE (outcome text, portal_user_id uuid, portal_session_id uuid, refresh_token_expires_at timestamptz)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      #variable_conflict use_column
      DECLARE
        presented_token app.refresh_tokens%ROWTYPE;
        owning_session app.portal_sessions%ROWTYPE;
        owner_status text;
        new_expires_at timestamptz;
      BEGIN
        SELECT * INTO presented_token FROM app.refresh_tokens WHERE token_hash = presented_token_hash FOR UPDATE;
        IF NOT FOUND THEN
          RETURN QUERY SELECT 'INVALID'::text, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        SELECT * INTO owning_session FROM app.portal_sessions WHERE id = presented_token.portal_session_id FOR UPDATE;
        SELECT status INTO owner_status FROM app.portal_users WHERE id = presented_token.portal_user_id;
        IF owning_session.revoked_at IS NOT NULL OR owning_session.expires_at <= now()
           OR presented_token.revoked_at IS NOT NULL OR presented_token.expires_at <= now()
           OR owner_status IS DISTINCT FROM 'ACTIVE' THEN
          RETURN QUERY SELECT 'INVALID'::text, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;

        IF presented_token.used_at IS NOT NULL
           AND NOT (presented_token.used_at > now() - interval '30 seconds' AND presented_token.successor_count < 3) THEN
          -- A used token came back: someone else has a copy. End the whole session.
          UPDATE app.portal_sessions SET revoked_at = now(), revocation_reason = 'REFRESH_TOKEN_REUSED' WHERE id = owning_session.id;
          UPDATE app.refresh_tokens AS tokens SET revoked_at = now()
           WHERE tokens.portal_session_id = owning_session.id AND tokens.revoked_at IS NULL;
          INSERT INTO app.audit_events (actor_portal_user_id, action, entity_type, entity_id, request_id)
          VALUES (presented_token.portal_user_id, 'refresh_token_reused', 'portal_session', owning_session.id, request_id);
          RETURN QUERY SELECT 'REUSE_DETECTED'::text, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;

        UPDATE app.refresh_tokens
           SET used_at = coalesce(used_at, now()), successor_count = successor_count + 1
         WHERE id = presented_token.id;
        new_expires_at := least(now() + interval '7 days', owning_session.expires_at);
        INSERT INTO app.refresh_tokens (portal_user_id, portal_session_id, token_hash, expires_at)
        VALUES (presented_token.portal_user_id, owning_session.id, new_refresh_token_hash, new_expires_at);
        UPDATE app.portal_sessions SET last_refreshed_at = now() WHERE id = owning_session.id;${auditRefresh}
        RETURN QUERY SELECT 'ROTATED'::text, presented_token.portal_user_id, owning_session.id, new_expires_at;
      END $$`;
}
