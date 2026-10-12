import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 4 (docs/design/phase-4-station-resolution-and-engagements.md §4; ADR-003): whose buttons a matched
 * recording gets when several stations air it, the listener's station choice, button taps and their limits,
 * and "Report this". One migration holds every schema change of the phase, the tables and functions only
 * later pieces use included (P4-D2), so no released migration is ever edited.
 *
 *  - recognition_events: how the station was resolved (resolution); the clock skew is a bigint, so it is
 *    always stored exactly; the API role's table-wide read becomes a column grant without the listener's
 *    install, their "My station" hint, the phone's idempotency key, capture time and clock skew (P4-D30).
 *  - campaigns: when the status last changed, so a campaign paused after a clip was heard still answers with
 *    the client's default card (O13, P4-D4); a grace period of 0 to 60 minutes.
 *  - stations: a city of 1 to 80 characters or none, because it now reaches every listener (P4-D27).
 *  - recognition_candidates (the stations weighed for one recognition), engagement_events (one row per
 *    distinct button tap), engagement_deduplication_keys, campaign_counters (taps counted toward a campaign's
 *    limit) and recognition_reports.
 *  - Functions for the API, each SECURITY DEFINER with its search path pinned and EXECUTE for lookup_api
 *    only: claim_recognition (created again with a bigint skew), find_station_candidates (replaces
 *    find_stations_for_audio), finish_recognition (created again, with the resolution, the hint and the
 *    candidates), describe_recognition_for_replay (replaces describe_recognition),
 *    count_recognition_attempts, record_station_choice, list_stations_for_listeners, record_engagement,
 *    record_recognition_report, delete_expired_recognition_idempotency_keys and
 *    app.create_listener_traffic_partitions (replaces app.create_recognition_event_partitions). Their
 *    helpers are executable by no service role.
 *
 * Scaling (each choice also has its comment where it is made):
 *  - recognition_candidates and engagement_events grow with listener traffic, so each is range-partitioned by
 *    month on its arrival column (candidates on their recognition's receipt time, taps on their own arrival),
 *    with a default partition and the months ahead kept in place; old months are detached whole, never
 *    deleted row by row (ADR-003 holds the order to detach them in).
 *  - One tap per (recognition, action) must hold across months, so that uniqueness lives in a small
 *    unpartitioned table, removed together with its recognition's month.
 *  - Taps name their recognition but hold no foreign key to it (A8): a tap arrives up to 30 days after its
 *    recognition, and such a key would stop old months of recognitions from being detached.
 *  - A recognition is found by its id between two bounds read from the id itself, with ordering operators
 *    only, so a lookup reads one or two monthly partitions (P4-D32).
 *  - Counters are one row per campaign, changed by one atomic statement with the limit in its WHERE clause.
 *  - Reports are few, so they are not partitioned, and hold no foreign key to recognitions either.
 */
export class StationResolution1791600000000 implements MigrationInterface {
  name = 'StationResolution1791600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);

    // ---- recognition_events: how the station was resolved ------------------------------------------------
    // A plain check cannot exempt older rows, so the rows finished before this migration first get the
    // resolution Step 3 decided for them (P4-D33): Step 3 gave a default card only when one station owned the
    // recording, and answered MATCH only when exactly one station had it on air. Step 3 never answered
    // CHOOSE_STATION; such a row could only be test data, and it is unresolved. Development data only:
    // nothing is deployed yet.
    await run(`
      ALTER TABLE app.recognition_events
        ADD COLUMN resolution text,
        ADD CONSTRAINT recognition_events_resolution_check CHECK (resolution IN (${RESOLUTIONS}))`);
    await run(`UPDATE app.recognition_events SET resolution = 'SINGLE_OWNER' WHERE outcome = 'MATCH_DEFAULT'`);
    await run(`UPDATE app.recognition_events SET resolution = 'SCHEDULE_UNIQUE' WHERE outcome = 'MATCH'`);
    await run(`UPDATE app.recognition_events SET resolution = 'UNRESOLVED' WHERE outcome = 'CHOOSE_STATION'`);
    // A chooser stays CHOOSE_STATION after the listener's choice (that is the answer that was given), so it
    // holds UNRESOLVED or LISTENER_CHOICE; a match holds how its one station was found; nothing else holds any.
    await run(`
      ALTER TABLE app.recognition_events ADD CONSTRAINT recognition_events_resolution_outcome_check CHECK (
        CASE WHEN outcome = 'CHOOSE_STATION' THEN coalesce(resolution IN ('UNRESOLVED', 'LISTENER_CHOICE'), false)
             WHEN outcome IN ('MATCH', 'MATCH_DEFAULT') THEN coalesce(resolution IN ('SINGLE_OWNER', 'SCHEDULE_UNIQUE', 'HINT'), false)
             ELSE resolution IS NULL
        END)`);
    // An integer holds a phone clock off by at most 24.8 days; a bigint holds any skew exactly (P4-D18). The
    // claim, its only writer, is created again below with a bigint parameter.
    await run(`ALTER TABLE app.recognition_events ALTER COLUMN clock_skew_milliseconds TYPE bigint`);

    // ---- campaigns: when the status last changed --------------------------------------------------------
    // Existing rows take their last change as the best time known; the update trigger is held off meanwhile so
    // their own updated_at does not move.
    await run(`ALTER TABLE app.campaigns ADD COLUMN status_changed_at timestamptz`);
    await run(`ALTER TABLE app.campaigns DISABLE TRIGGER campaigns_set_updated_at`);
    await run(`UPDATE app.campaigns SET status_changed_at = updated_at`);
    await run(`ALTER TABLE app.campaigns ENABLE TRIGGER campaigns_set_updated_at`);
    // Grace widens each slot on both sides (P4-D3); the slot arithmetic looks one day around the moment, and
    // the portal offers 0 to 20 minutes.
    await run(`
      ALTER TABLE app.campaigns
        ALTER COLUMN status_changed_at SET DEFAULT now(),
        ALTER COLUMN status_changed_at SET NOT NULL,
        ADD CONSTRAINT campaigns_time_window_grace_period_check
          CHECK (time_window_grace_period >= interval '0 minutes' AND time_window_grace_period <= interval '60 minutes')`);
    // The time is the database's own: set when a campaign is made and whenever its status changes, and kept
    // otherwise, so no caller can move it to a time of its choosing (it decides who answers a listener).
    await run(`
      CREATE FUNCTION app.set_campaign_status_changed_at() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
      AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          NEW.status_changed_at := now();
        ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
          NEW.status_changed_at := now();
        ELSE
          NEW.status_changed_at := OLD.status_changed_at;
        END IF;
        RETURN NEW;
      END $$`);
    await run(`
      CREATE TRIGGER campaigns_set_status_changed_at BEFORE INSERT OR UPDATE ON app.campaigns
        FOR EACH ROW EXECUTE FUNCTION app.set_campaign_status_changed_at()`);

    // ---- stations: the city now reaches every listener -------------------------------------------------
    await run(`ALTER TABLE app.stations DISABLE TRIGGER stations_set_updated_at`);
    await run(`UPDATE app.stations SET city = NULL WHERE btrim(city) = ''`);
    await run(`ALTER TABLE app.stations ENABLE TRIGGER stations_set_updated_at`);
    await run(`ALTER TABLE app.stations ADD CONSTRAINT stations_city_check CHECK (char_length(city) BETWEEN 1 AND 80 AND btrim(city) <> '')`);

    // ---- the Step 3 functions this migration replaces ----------------------------------------------------
    await run(`DROP FUNCTION recognition.describe_recognition(uuid, timestamptz, uuid)`);
    await run(`DROP FUNCTION recognition.find_stations_for_audio(integer, timestamptz)`);
    await run(`DROP FUNCTION recognition.finish_recognition(${STEP_3_FINISH_ARGUMENTS})`);
    await run(`DROP FUNCTION recognition.claim_recognition(${STEP_3_CLAIM_ARGUMENTS})`);
    await run(`DROP FUNCTION app.create_recognition_event_partitions(integer)`);
    await run(`DROP FUNCTION app.name_recognition_event_partition_indexes(text)`);

    // ---- partitions of the tables that grow with listener traffic --------------------------------------
    await run(NAME_LISTENER_TRAFFIC_PARTITION_OBJECTS);
    await run(CREATE_LISTENER_TRAFFIC_PARTITIONS);

    // ---- recognition_candidates ------------------------------------------------------------------------
    // One row for every station that owns the matched recording and can show a card, whatever the outcome
    // (P4-D8): its campaign, the card version sent inline (the replay snapshot), whether it was on air at the
    // capture moment, its place in a chooser, and the listener's choice. Partitioned with its recognition, on
    // the recognition's first receipt time, so a month of candidates is detached with its month of
    // recognitions; the foreign key to them is kept (the detach order is in ADR-003).
    await run(`
      CREATE TABLE app.recognition_candidates (
        recognition_id          uuid NOT NULL,
        recognition_received_at timestamptz NOT NULL,
        station_id              uuid NOT NULL,
        campaign_id             uuid NOT NULL,
        action_card_id          uuid NOT NULL,
        card_kind               text NOT NULL,
        is_in_window            boolean NOT NULL,
        display_position        smallint,
        is_chosen               boolean NOT NULL DEFAULT false,
        chosen_at               timestamptz,
        created_at              timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT recognition_candidates_primary_key PRIMARY KEY (recognition_id, recognition_received_at, station_id),
        CONSTRAINT recognition_candidates_recognition_foreign_key
          FOREIGN KEY (recognition_id, recognition_received_at) REFERENCES app.recognition_events (id, received_at),
        CONSTRAINT recognition_candidates_station_foreign_key FOREIGN KEY (station_id) REFERENCES app.stations (id) ON DELETE RESTRICT,
        CONSTRAINT recognition_candidates_campaign_foreign_key
          FOREIGN KEY (campaign_id, station_id) REFERENCES app.campaigns (id, station_id),
        CONSTRAINT recognition_candidates_action_card_foreign_key
          FOREIGN KEY (action_card_id, station_id) REFERENCES app.action_cards (id, station_id),
        CONSTRAINT recognition_candidates_card_kind_check CHECK (card_kind IN ('CAMPAIGN', 'CLIENT_DEFAULT')),
        CONSTRAINT recognition_candidates_display_position_check CHECK (display_position BETWEEN 1 AND 4),
        CONSTRAINT recognition_candidates_chosen_is_shown_check CHECK (NOT is_chosen OR display_position IS NOT NULL),
        CONSTRAINT recognition_candidates_chosen_at_check CHECK (is_chosen = (chosen_at IS NOT NULL))
      ) PARTITION BY RANGE (recognition_received_at)`);
    // A unique constraint cannot be partial, so these two rules are partial unique indexes (P4-D34); on a
    // partitioned table each must hold the partition key.
    await run(`
      CREATE UNIQUE INDEX recognition_candidates_one_chosen_unique_index
        ON app.recognition_candidates (recognition_id, recognition_received_at) WHERE is_chosen`);
    await run(`
      CREATE UNIQUE INDEX recognition_candidates_display_position_unique_index
        ON app.recognition_candidates (recognition_id, recognition_received_at, display_position) WHERE display_position IS NOT NULL`);
    // A station's own candidates by month (P7's "possible" counts), and an index for each foreign key.
    await run(`CREATE INDEX recognition_candidates_station_received_at_index ON app.recognition_candidates (station_id, recognition_received_at)`);
    await run(`CREATE INDEX recognition_candidates_campaign_index ON app.recognition_candidates (campaign_id)`);
    await run(`CREATE INDEX recognition_candidates_action_card_index ON app.recognition_candidates (action_card_id)`);
    await run(`CREATE TABLE app.recognition_candidates_default PARTITION OF app.recognition_candidates DEFAULT`);

    // ---- engagement_events -------------------------------------------------------------------------------
    // One row per distinct button tap, on the card version shown, with the action's type taken from that card
    // (a new type needs no migration). Partitioned on the tap's arrival: its corrected time is clamped, so it
    // is not an arrival time. No foreign key to recognition_events (A8): record_engagement checks the
    // recognition itself, and a month of recognitions stays detachable while later taps name it.
    await run(`
      CREATE TABLE app.engagement_events (
        id                      uuid NOT NULL,
        received_at             timestamptz NOT NULL,
        recognition_id          uuid NOT NULL,
        recognition_received_at timestamptz NOT NULL,
        station_id              uuid NOT NULL,
        campaign_id             uuid NOT NULL,
        action_card_id          uuid NOT NULL,
        card_kind               text NOT NULL,
        action_id               uuid NOT NULL,
        action_type             text NOT NULL,
        occurred_at             timestamptz NOT NULL,
        client_occurred_at      timestamptz NOT NULL,
        clock_skew_milliseconds bigint NOT NULL,
        is_counted              boolean NOT NULL,
        request_id              text NOT NULL,
        CONSTRAINT engagement_events_primary_key PRIMARY KEY (id, received_at),
        CONSTRAINT engagement_events_station_foreign_key FOREIGN KEY (station_id) REFERENCES app.stations (id) ON DELETE RESTRICT,
        CONSTRAINT engagement_events_campaign_foreign_key FOREIGN KEY (campaign_id, station_id) REFERENCES app.campaigns (id, station_id),
        CONSTRAINT engagement_events_action_card_foreign_key
          FOREIGN KEY (action_card_id, station_id) REFERENCES app.action_cards (id, station_id),
        CONSTRAINT engagement_events_card_kind_check CHECK (card_kind IN ('CAMPAIGN', 'CLIENT_DEFAULT')),
        CONSTRAINT engagement_events_action_type_check CHECK (action_type ~ '^[A-Z][A-Z_]{0,31}$'),
        CONSTRAINT engagement_events_occurred_at_check CHECK (occurred_at >= recognition_received_at AND occurred_at <= received_at),
        CONSTRAINT engagement_events_counted_card_check CHECK (NOT is_counted OR card_kind = 'CAMPAIGN')
      ) PARTITION BY RANGE (received_at)`);
    await run(`CREATE INDEX engagement_events_station_occurred_at_index ON app.engagement_events (station_id, occurred_at)`);
    await run(`CREATE INDEX engagement_events_recognition_index ON app.engagement_events (recognition_id, recognition_received_at)`);
    // Serves the foreign key to campaigns, and the per-install count of a campaign's last 24 hours (P4-D10).
    await run(`CREATE INDEX engagement_events_campaign_received_at_index ON app.engagement_events (campaign_id, received_at)`);
    await run(`CREATE INDEX engagement_events_action_card_index ON app.engagement_events (action_card_id)`);
    // Rows arrive in time order, so a block-range index finds a period cheaply at a tiny size.
    await run(`CREATE INDEX engagement_events_received_at_index ON app.engagement_events USING brin (received_at)`);
    await run(`CREATE TABLE app.engagement_events_default PARTITION OF app.engagement_events DEFAULT`);

    // ---- engagement_deduplication_keys -------------------------------------------------------------------
    // One tap per (recognition, action) across every month of engagement_events (P4-ENGAGEMENTS-12), in a
    // small unpartitioned table. A key lives as long as a tap on its recognition can be accepted: the keys of a
    // month of recognitions are deleted when that month is detached (ADR-003).
    await run(`
      CREATE TABLE app.engagement_deduplication_keys (
        recognition_id          uuid NOT NULL,
        action_id               uuid NOT NULL,
        recognition_received_at timestamptz NOT NULL,
        engagement_event_id     uuid NOT NULL,
        engagement_received_at  timestamptz NOT NULL,
        created_at              timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT engagement_deduplication_keys_primary_key PRIMARY KEY (recognition_id, action_id)
      )`);
    await run(`
      CREATE INDEX engagement_deduplication_keys_recognition_received_at_index
        ON app.engagement_deduplication_keys (recognition_received_at)`);

    // ---- campaign_counters -------------------------------------------------------------------------------
    // Taps counted toward a campaign's limit: one row per campaign, unpartitioned, made at the first counted
    // tap (the API role cannot make rows when campaigns are made) and changed by one atomic statement.
    await run(`
      CREATE TABLE app.campaign_counters (
        campaign_id              uuid NOT NULL,
        station_id               uuid NOT NULL,
        counted_engagement_count integer NOT NULL DEFAULT 0,
        created_at               timestamptz NOT NULL DEFAULT now(),
        updated_at               timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT campaign_counters_primary_key PRIMARY KEY (campaign_id),
        CONSTRAINT campaign_counters_campaign_foreign_key FOREIGN KEY (campaign_id, station_id) REFERENCES app.campaigns (id, station_id),
        CONSTRAINT campaign_counters_station_foreign_key FOREIGN KEY (station_id) REFERENCES app.stations (id) ON DELETE RESTRICT,
        CONSTRAINT campaign_counters_counted_engagement_count_check CHECK (counted_engagement_count >= 0)
      )`);
    await run(`CREATE INDEX campaign_counters_station_index ON app.campaign_counters (station_id)`);
    await run(`
      CREATE TRIGGER campaign_counters_set_updated_at BEFORE UPDATE ON app.campaign_counters
        FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()`);

    // ---- recognition_reports ("Report this", approved 11 October 2026) -----------------------------------
    // One report per recognition, one of four reasons and no free text. The listener is kept only as the
    // API's keyed hash of the install (the logs' actor), never the install id, so super admins can tell many
    // reports from one phone from many listeners (P4-D28). No foreign key to recognition_events: a report kept
    // for moderation never stops an old month of recognitions from being detached.
    await run(`
      CREATE TABLE app.recognition_reports (
        id                      uuid NOT NULL DEFAULT gen_random_uuid(),
        recognition_id          uuid NOT NULL,
        recognition_received_at timestamptz NOT NULL,
        station_id              uuid NOT NULL,
        reason                  text NOT NULL,
        listener_install_hash   text NOT NULL,
        received_at             timestamptz NOT NULL,
        request_id              text NOT NULL,
        created_at              timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT recognition_reports_primary_key PRIMARY KEY (id),
        CONSTRAINT recognition_reports_recognition_id_unique UNIQUE (recognition_id),
        CONSTRAINT recognition_reports_station_foreign_key FOREIGN KEY (station_id) REFERENCES app.stations (id) ON DELETE RESTRICT,
        CONSTRAINT recognition_reports_reason_check CHECK (reason IN (${REPORT_REASONS})),
        CONSTRAINT recognition_reports_listener_install_hash_check CHECK (listener_install_hash ~ '^[A-Za-z0-9_-]{22}$')
      )`);
    await run(`CREATE INDEX recognition_reports_station_received_at_index ON app.recognition_reports (station_id, received_at)`);
    await run(`CREATE INDEX recognition_reports_listener_install_hash_received_at_index ON app.recognition_reports (listener_install_hash, received_at)`);

    // The months ahead for the new tables (recognition_events has its own already), then readable names for
    // every partition's indexes and for the foreign keys candidates hold on each month of recognitions.
    await run(`SELECT app.create_listener_traffic_partitions(3)`);
    await run(`
      SELECT app.name_listener_traffic_partition_objects(parent_table.relname, partition_table.relname)
        FROM pg_inherits AS inheritance
        JOIN pg_class AS partition_table ON partition_table.oid = inheritance.inhrelid
        JOIN pg_class AS parent_table ON parent_table.oid = inheritance.inhparent
       WHERE inheritance.inhparent IN ('app.recognition_events'::regclass, 'app.recognition_candidates'::regclass, 'app.engagement_events'::regclass)
         AND partition_table.relkind = 'r'`);

    // ---- time windows with grace (§4.3) ------------------------------------------------------------------
    await run(LIST_TIME_WINDOW_SLOTS);
    await run(LIST_TIME_WINDOW_SLOTS_ON_AIR);
    await run(IS_TIME_WINDOW_OPEN_WITH_GRACE);

    // ---- finding a recognition by its id (P4-D32) --------------------------------------------------------
    await run(receiptTimeBound('compute_earliest_receipt_time', '- 300000', 'five minutes before'));
    await run(receiptTimeBound('compute_latest_receipt_time', '+ 60000', 'one minute after'));

    // ---- the API's recognition functions -----------------------------------------------------------------
    await run(CLAIM_RECOGNITION);
    await run(FIND_STATION_CANDIDATES);
    await run(FINISH_RECOGNITION);
    await run(DESCRIBE_RECOGNITION_FOR_REPLAY);
    await run(COUNT_RECOGNITION_ATTEMPTS);
    await run(RECORD_CHOICE_ON_LOCKED_RECOGNITION);
    await run(RECORD_STATION_CHOICE);
    await run(LIST_STATIONS_FOR_LISTENERS);
    await run(RECORD_ENGAGEMENT);
    await run(RECORD_RECOGNITION_REPORT);
    await run(DELETE_EXPIRED_RECOGNITION_IDEMPOTENCY_KEYS);

    // ---- row-level security --------------------------------------------------------------------------------
    // A station sees only its own candidates, taps and counters, so it can never tell which other stations
    // were offered for the same recognition, nor who the listener was.
    for (const table of ['recognition_candidates', 'engagement_events', 'campaign_counters']) {
      await run(`ALTER TABLE app.${table} ENABLE ROW LEVEL SECURITY`);
      await run(`
        CREATE POLICY ${table}_visible_to_station ON app.${table} FOR SELECT TO lookup_api
          USING (station_id = app.current_station_id())`);
      await run(`
        CREATE POLICY ${table}_admin_full_access ON app.${table} FOR ALL TO lookup_admin_api
          USING (true) WITH CHECK (true)`);
    }
    // Deliberately no policy: only the functions above touch the keys.
    await run(`ALTER TABLE app.engagement_deduplication_keys ENABLE ROW LEVEL SECURITY`);
    // Reports are for super admins (the 5a console) only; no station ever reads them.
    await run(`ALTER TABLE app.recognition_reports ENABLE ROW LEVEL SECURITY`);
    await run(`
      CREATE POLICY recognition_reports_admin_full_access ON app.recognition_reports FOR ALL TO lookup_admin_api
        USING (true) WITH CHECK (true)`);

    // ---- privileges --------------------------------------------------------------------------------------
    // Every write goes through the functions; the API role and super admins only read, through the policies.
    await run(`GRANT SELECT ON app.recognition_candidates, app.engagement_events, app.campaign_counters TO lookup_api, lookup_admin_api`);
    await run(`GRANT SELECT ON app.recognition_reports TO lookup_admin_api`);
    // The API role reads recognitions without the listener's install, their hint (another station's id when it
    // was ignored), the phone's own key, and the phone's capture time and skew, which together fingerprint one
    // phone's clock (P4-D30). No API code reads the table directly; super admins keep every column.
    await run(`REVOKE SELECT ON app.recognition_events FROM lookup_api`);
    await run(`GRANT SELECT (${API_READABLE_RECOGNITION_EVENT_COLUMNS}) ON app.recognition_events TO lookup_api`);

    for (const signature of [...API_FUNCTIONS, ...INTERNAL_FUNCTIONS]) {
      await run(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
    }
    await run(`GRANT EXECUTE ON FUNCTION ${API_FUNCTIONS.join(', ')} TO lookup_api`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);

    // ---- privileges on recognition_events, as before ------------------------------------------------------
    await run(`REVOKE SELECT (${API_READABLE_RECOGNITION_EVENT_COLUMNS}) ON app.recognition_events FROM lookup_api`);
    await run(`GRANT SELECT ON app.recognition_events TO lookup_api`);

    // ---- this migration's functions and tables ------------------------------------------------------------
    for (const signature of [...API_FUNCTIONS, ...INTERNAL_FUNCTIONS]) {
      if (signature === 'app.set_campaign_status_changed_at()') continue;
      await run(`DROP FUNCTION ${signature}`);
    }
    for (const table of ['recognition_reports', 'campaign_counters', 'engagement_deduplication_keys', 'engagement_events', 'recognition_candidates']) {
      await run(`DROP TABLE app.${table}`);
    }

    // ---- the Step 3 functions, as they were ---------------------------------------------------------------
    await run(STEP_3_NAME_RECOGNITION_EVENT_PARTITION_INDEXES);
    await run(STEP_3_CREATE_RECOGNITION_EVENT_PARTITIONS);
    await run(`REVOKE ALL ON FUNCTION app.name_recognition_event_partition_indexes(text) FROM PUBLIC`);
    await run(`REVOKE ALL ON FUNCTION app.create_recognition_event_partitions(integer) FROM PUBLIC`);
    await run(`GRANT EXECUTE ON FUNCTION app.create_recognition_event_partitions(integer) TO lookup_api`);
    await run(STEP_3_CLAIM_RECOGNITION);
    await run(STEP_3_FINISH_RECOGNITION);
    await run(STEP_3_FIND_STATIONS_FOR_AUDIO);
    await run(STEP_3_DESCRIBE_RECOGNITION);
    const step3Functions = [
      `recognition.claim_recognition(${STEP_3_CLAIM_ARGUMENTS})`,
      `recognition.finish_recognition(${STEP_3_FINISH_ARGUMENTS})`,
      'recognition.find_stations_for_audio(integer, timestamptz)',
      'recognition.describe_recognition(uuid, timestamptz, uuid)',
    ];
    for (const signature of step3Functions) {
      await run(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
    }
    await run(`GRANT EXECUTE ON FUNCTION ${step3Functions.join(', ')} TO lookup_api`);

    // ---- stations, campaigns and recognition_events, as before ------------------------------------------
    // Blank cities made NULL stay NULL: nothing told a blank city from none.
    await run(`ALTER TABLE app.stations DROP CONSTRAINT stations_city_check`);
    await run(`DROP TRIGGER campaigns_set_status_changed_at ON app.campaigns`);
    await run(`DROP FUNCTION app.set_campaign_status_changed_at()`);
    await run(`ALTER TABLE app.campaigns DROP CONSTRAINT campaigns_time_window_grace_period_check, DROP COLUMN status_changed_at`);
    await run(`
      ALTER TABLE app.recognition_events
        DROP CONSTRAINT recognition_events_resolution_outcome_check,
        DROP CONSTRAINT recognition_events_resolution_check,
        DROP COLUMN resolution`);
    // A skew beyond the integer's range was never storable before this migration: it becomes unknown again.
    await run(`
      ALTER TABLE app.recognition_events ALTER COLUMN clock_skew_milliseconds TYPE integer
        USING CASE WHEN clock_skew_milliseconds BETWEEN -2147483648 AND 2147483647 THEN clock_skew_milliseconds::integer END`);
  }
}

// ---- values ------------------------------------------------------------------------------------------------

const RESOLUTIONS = `'SINGLE_OWNER', 'SCHEDULE_UNIQUE', 'HINT', 'LISTENER_CHOICE', 'UNRESOLVED'`;
const REPORT_REASONS = `'WRONG_OR_MISLEADING_BUTTONS', 'NUMBER_OR_LINK_DOES_NOT_WORK', 'LOOKS_LIKE_A_SCAM', 'SOMETHING_ELSE'`;

/** Every column of recognition_events but listener_install_id, hinted_station_id, idempotency_key, client_captured_at and clock_skew_milliseconds. */
const API_READABLE_RECOGNITION_EVENT_COLUMNS = [
  'id', 'request_id', 'captured_at', 'received_at', 'is_deferred', 'attempt_count', 'completed_at', 'outcome', 'fallback_reason',
  'audio_asset_id', 'station_id', 'campaign_id', 'action_card_id', 'aligned_hash_count', 'match_margin', 'match_offset_milliseconds',
  'clip_duration_milliseconds', 'latency_milliseconds', 'fingerprint_version', 'last_claimed_at', 'resolution',
].join(', ');

const API_FUNCTIONS = [
  'recognition.claim_recognition(uuid, uuid, uuid, text, timestamptz, timestamptz, bigint, timestamptz, boolean, integer)',
  'recognition.find_station_candidates(integer, timestamptz)',
  'recognition.finish_recognition(uuid, timestamptz, integer, text, text, integer, uuid, uuid, uuid, text, uuid, jsonb, integer, real, integer, integer, smallint)',
  'recognition.describe_recognition_for_replay(uuid, timestamptz, uuid)',
  'recognition.count_recognition_attempts(uuid, uuid)',
  'recognition.record_station_choice(uuid, uuid, uuid)',
  'recognition.list_stations_for_listeners(integer)',
  'recognition.record_engagement(uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, bigint, timestamptz, text, integer)',
  'recognition.record_recognition_report(uuid, uuid, text, uuid, text, timestamptz, text)',
  'recognition.delete_expired_recognition_idempotency_keys(interval, integer)',
  'app.create_listener_traffic_partitions(integer)',
];

/** Called only by the functions above (as their owner) or by the database itself: no service role may run them. */
const INTERNAL_FUNCTIONS = [
  'recognition.record_choice_on_locked_recognition(uuid, timestamptz, uuid)',
  'recognition.compute_earliest_receipt_time(uuid)',
  'recognition.compute_latest_receipt_time(uuid)',
  'app.is_time_window_open_with_grace(smallint[], time, time, timestamp, interval)',
  'app.list_time_window_slots_on_air(smallint[], time, time, timestamp, interval)',
  'app.list_time_window_slots(smallint[], time, time, timestamp, timestamp)',
  'app.name_listener_traffic_partition_objects(text, text)',
  'app.set_campaign_status_changed_at()',
];

// ---- partitions ----------------------------------------------------------------------------------------------

/**
 * Readable names for one new partition: each index (and the constraint an index backs) after its parent's
 * (recognition_candidates_primary_key becomes recognition_candidates_2026_10_primary_key, not …_pkey), and each
 * foreign key that a partitioned table holds on this partition (PostgreSQL adds one per partition of the table
 * it refers to, named …_fkey1) as <referencing table>_<partition>_foreign_key. A name longer than PostgreSQL
 * keeps is refused rather than cut short. Called only by app.create_listener_traffic_partitions and migrations.
 */
const NAME_LISTENER_TRAFFIC_PARTITION_OBJECTS = `
      CREATE FUNCTION app.name_listener_traffic_partition_objects(parent_table_name text, partition_name text) RETURNS void
        LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        partition_index_name   text;
        parent_index_name      text;
        referencing_table_name text;
        foreign_key_name       text;
        readable_name          text;
      BEGIN
        FOR partition_index_name, parent_index_name IN
          SELECT partition_index.relname, parent_index.relname
            FROM pg_index AS index_entry
            JOIN pg_class AS partition_index ON partition_index.oid = index_entry.indexrelid
            JOIN pg_inherits AS inheritance ON inheritance.inhrelid = index_entry.indexrelid
            JOIN pg_class AS parent_index ON parent_index.oid = inheritance.inhparent
           WHERE index_entry.indrelid = to_regclass('app.' || quote_ident(partition_name))
        LOOP
          IF left(parent_index_name, length(parent_table_name)) <> parent_table_name THEN
            RAISE EXCEPTION 'index % is not named after its table %', parent_index_name, parent_table_name;
          END IF;
          readable_name := partition_name || substr(parent_index_name, length(parent_table_name) + 1);
          IF length(readable_name) > 63 THEN
            RAISE EXCEPTION 'the name % is longer than PostgreSQL keeps', readable_name;
          END IF;
          IF partition_index_name <> readable_name THEN
            EXECUTE format('ALTER INDEX app.%I RENAME TO %I', partition_index_name, readable_name);
          END IF;
        END LOOP;
        FOR referencing_table_name, foreign_key_name IN
          SELECT referencing_table.relname, constraint_entry.conname
            FROM pg_constraint AS constraint_entry
            JOIN pg_class AS referencing_table ON referencing_table.oid = constraint_entry.conrelid
           WHERE constraint_entry.contype = 'f' AND constraint_entry.conparentid <> 0 AND referencing_table.relkind = 'p'
             AND referencing_table.relnamespace = 'app'::regnamespace
             AND constraint_entry.confrelid = to_regclass('app.' || quote_ident(partition_name))
        LOOP
          readable_name := referencing_table_name || '_' || partition_name || '_foreign_key';
          IF length(readable_name) > 63 THEN
            RAISE EXCEPTION 'the name % is longer than PostgreSQL keeps', readable_name;
          END IF;
          IF foreign_key_name <> readable_name THEN
            EXECUTE format('ALTER TABLE app.%I RENAME CONSTRAINT %I TO %I', referencing_table_name, foreign_key_name, readable_name);
          END IF;
        END LOOP;
      END $$`;

/**
 * Creates the missing monthly partitions of the three tables that grow with listener traffic, this month and
 * months_ahead more, from a fixed list (never a table name from the caller). Recognitions come first in each
 * month, because candidates refer to them. Run by the API at start-up and daily (P4-D19).
 */
const CREATE_LISTENER_TRAFFIC_PARTITIONS = `
      CREATE FUNCTION app.create_listener_traffic_partitions(months_ahead integer) RETURNS integer
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
      AS $$
      DECLARE
        first_month       timestamp := date_trunc('month', now() AT TIME ZONE 'UTC');
        month_start       timestamp;
        parent_table_name text;
        partition_name    text;
        created_count     integer := 0;
      BEGIN
        IF months_ahead IS NULL OR months_ahead < 0 OR months_ahead > 24 THEN
          RAISE EXCEPTION 'months_ahead must be between 0 and 24' USING ERRCODE = '22023';
        END IF;
        FOR month_offset IN 0..months_ahead LOOP
          month_start := first_month + make_interval(months => month_offset);
          FOREACH parent_table_name IN ARRAY ARRAY['recognition_events', 'recognition_candidates', 'engagement_events'] LOOP
            partition_name := parent_table_name || '_' || to_char(month_start, 'YYYY_MM');
            IF to_regclass('app.' || partition_name) IS NULL THEN
              EXECUTE format(
                'CREATE TABLE app.%I PARTITION OF app.%I FOR VALUES FROM (%L) TO (%L)',
                partition_name,
                parent_table_name,
                month_start AT TIME ZONE 'UTC',
                (month_start + interval '1 month') AT TIME ZONE 'UTC');
              PERFORM app.name_listener_traffic_partition_objects(parent_table_name, partition_name);
              created_count := created_count + 1;
            END IF;
          END LOOP;
        END LOOP;
        RETURN created_count;
      END $$`;

// ---- time windows with grace ---------------------------------------------------------------------------------

/**
 * Every slot of one weekly window that starts on a day from the day before local_from to the day of local_to,
 * in the station's wall-clock time. A window whose end is not after its start runs past midnight: its slot
 * ends the next day and belongs to the day it starts (as app.is_time_window_open says). Immutable: dates,
 * times and intervals only, no time zone.
 */
const LIST_TIME_WINDOW_SLOTS = `
      CREATE FUNCTION app.list_time_window_slots(days_of_week smallint[], local_start_time time, local_end_time time,
                                                 local_from timestamp, local_to timestamp)
        RETURNS TABLE (slot_start timestamp, slot_end timestamp)
        LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp
      AS $$
        SELECT slot_day + local_start_time::interval,
               slot_day + local_end_time::interval
                 + CASE WHEN local_end_time <= local_start_time THEN interval '1 day' ELSE interval '0 days' END
          FROM generate_series(date_trunc('day', local_from) - interval '1 day', date_trunc('day', local_to), interval '1 day') AS slot_day
         WHERE extract(isodow FROM slot_day)::smallint = ANY (days_of_week)
      $$`;

/**
 * The rule, in one place: the slots of a weekly window that have a clip heard at local_moment on air, the slot
 * widened by the grace on both sides, slot_start − grace ≤ local_moment < slot_end + grace (P4-D3). Grace is at
 * most an hour (campaigns_time_window_grace_period_check), well inside the day the slots are listed around.
 * recognition.find_station_candidates reads the latest of these slots' starts.
 */
const LIST_TIME_WINDOW_SLOTS_ON_AIR = `
      CREATE FUNCTION app.list_time_window_slots_on_air(days_of_week smallint[], local_start_time time, local_end_time time,
                                                        local_moment timestamp, grace interval)
        RETURNS TABLE (slot_start timestamp, slot_end timestamp)
        LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp
      AS $$
        SELECT slot.slot_start, slot.slot_end
          FROM app.list_time_window_slots(days_of_week, local_start_time, local_end_time, local_moment - grace, local_moment + grace) AS slot
         WHERE slot.slot_start - grace <= local_moment AND local_moment < slot.slot_end + grace
      $$`;

/**
 * Whether a clip heard at local_moment is on air in a weekly window, grace included on both sides. With a grace
 * of 0 this is exactly app.is_time_window_open, which the portal's "Live now" badge keeps using.
 */
const IS_TIME_WINDOW_OPEN_WITH_GRACE = `
      CREATE FUNCTION app.is_time_window_open_with_grace(days_of_week smallint[], local_start_time time, local_end_time time,
                                                         local_moment timestamp, grace interval) RETURNS boolean
        LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp
      AS $$
        SELECT EXISTS (SELECT 1 FROM app.list_time_window_slots_on_air(days_of_week, local_start_time, local_end_time, local_moment, grace))
      $$`;

// ---- finding a recognition by its id --------------------------------------------------------------------------

/**
 * The API makes a recognition's UUID version 7 id after the clip has been read, so the recognition's receipt
 * time lies within a minute or so before the id's own time (its first 48 bits, in milliseconds). These bound it
 * from the id alone, with millisecond arithmetic before one conversion, so they stay truly immutable and a
 * lookup written `received_at >= earliest AND received_at <= latest` prunes to one or two monthly partitions.
 */
function receiptTimeBound(functionName: string, millisecondsOffset: string, description: string): string {
  return `
      CREATE FUNCTION recognition.${functionName}(recognition_id uuid) RETURNS timestamptz
        LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, pg_temp
      AS $$
        -- ${description} the time the id was made
        SELECT to_timestamp(((('x' || left(replace(recognition_id::text, '-', ''), 12))::bit(48)::bigint ${millisecondsOffset}) / 1000.0)::double precision)
      $$`;
}

// ---- the API's recognition functions -----------------------------------------------------------------------------

/**
 * Claims an idempotency key for one install (the Step 3 rules): a new key makes a PENDING recognition; a key
 * seen before answers IN_PROGRESS (claimed under 30 seconds ago), RECLAIMED (its last attempt timed out, was
 * refused as busy, failed, or was abandoned: a new attempt on the same recognition, keeping its first receipt
 * and capture times) or FINISHED (replay it). Created again in P4 (P4-D2): the skew is a bigint, so it is always
 * stored exactly; a re-claim stores is_deferred as the stored value or this attempt's, so a clip that went busy
 * live and was then sent from the outbox is deferred; and the stored capture time and is_deferred are returned,
 * so a retry is resolved at the first capture moment.
 */
const CLAIM_RECOGNITION = `
      CREATE FUNCTION recognition.claim_recognition(
          claiming_listener_install_id uuid, claimed_idempotency_key uuid, new_recognition_id uuid, request_id text,
          effective_captured_at timestamptz, client_captured_at timestamptz, clock_skew_milliseconds bigint,
          received_at timestamptz, is_attempt_deferred boolean, clip_duration_milliseconds integer)
        RETURNS TABLE (recognition_id uuid, recognition_received_at timestamptz, recognition_captured_at timestamptz,
                       attempt_number integer, claim_outcome text, previous_outcome text, is_deferred boolean)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      #variable_conflict use_column
      DECLARE
        existing_key   app.recognition_idempotency_keys%ROWTYPE;
        existing_event record;
      BEGIN
        INSERT INTO app.recognition_idempotency_keys (listener_install_id, idempotency_key, recognition_event_id, recognition_received_at)
          VALUES (claiming_listener_install_id, claimed_idempotency_key, new_recognition_id, claim_recognition.received_at)
          ON CONFLICT DO NOTHING;
        IF FOUND THEN
          INSERT INTO app.recognition_events (id, listener_install_id, idempotency_key, request_id, captured_at, received_at,
                                              client_captured_at, clock_skew_milliseconds, is_deferred, attempt_count,
                                              outcome, clip_duration_milliseconds, last_claimed_at)
            VALUES (new_recognition_id, claiming_listener_install_id, claimed_idempotency_key, claim_recognition.request_id,
                    effective_captured_at, claim_recognition.received_at, claim_recognition.client_captured_at,
                    claim_recognition.clock_skew_milliseconds, is_attempt_deferred, 1, 'PENDING',
                    claim_recognition.clip_duration_milliseconds, now());
          RETURN QUERY SELECT new_recognition_id, claim_recognition.received_at, effective_captured_at, 1, 'CLAIMED'::text, NULL::text,
                              is_attempt_deferred;
          RETURN;
        END IF;

        SELECT * INTO existing_key FROM app.recognition_idempotency_keys AS held_key
         WHERE held_key.listener_install_id = claiming_listener_install_id AND held_key.idempotency_key = claimed_idempotency_key
           FOR UPDATE;
        SELECT event.outcome, event.last_claimed_at, event.attempt_count::integer AS attempt_count, event.captured_at, event.is_deferred
          INTO existing_event
          FROM app.recognition_events AS event
         WHERE event.id = existing_key.recognition_event_id AND event.received_at = existing_key.recognition_received_at
           FOR UPDATE;

        IF existing_event.outcome = 'PENDING' AND existing_event.last_claimed_at > now() - interval '30 seconds' THEN
          RETURN QUERY SELECT existing_key.recognition_event_id, existing_key.recognition_received_at, existing_event.captured_at,
                              existing_event.attempt_count, 'IN_PROGRESS'::text, existing_event.outcome, existing_event.is_deferred;
        ELSIF existing_event.outcome IN ('PENDING', 'TIMEOUT', 'BUSY', 'ERROR') THEN
          UPDATE app.recognition_events AS event
             SET outcome = 'PENDING', attempt_count = event.attempt_count + 1, request_id = claim_recognition.request_id,
                 last_claimed_at = now(), completed_at = NULL, is_deferred = event.is_deferred OR is_attempt_deferred
           WHERE event.id = existing_key.recognition_event_id AND event.received_at = existing_key.recognition_received_at;
          RETURN QUERY SELECT existing_key.recognition_event_id, existing_key.recognition_received_at, existing_event.captured_at,
                              existing_event.attempt_count + 1, 'RECLAIMED'::text, existing_event.outcome,
                              existing_event.is_deferred OR is_attempt_deferred;
        ELSE
          RETURN QUERY SELECT existing_key.recognition_event_id, existing_key.recognition_received_at, existing_event.captured_at,
                              existing_event.attempt_count, 'FINISHED'::text, existing_event.outcome, existing_event.is_deferred;
        END IF;
      END
      $$`;

/**
 * One row per campaign that makes its station an owner of the matched recording (P4-D4): an ACTIVE station, a
 * non-archived ad on the recording, and a campaign that is ACTIVE, or PAUSED or ENDED after the capture
 * (is_campaign_active false; it shows the client's default card, O13). Unlisted stations are owners like any
 * other (Correction 3). The capture moment decides the period, the windows with grace, the slot that started
 * last (matched_slot_started_at, set only in window) and the slot that ended last within 7 days, started in the
 * period (last_slot_ended_at); the moment of the call decides the statuses, the card versions and the tap limit
 * (P4-D5). Only what a listener may see leaves, and of the limit only whether it is reached.
 */
const FIND_STATION_CANDIDATES = `
      CREATE FUNCTION recognition.find_station_candidates(matched_audio_asset_number integer, effective_captured_at timestamptz)
        RETURNS TABLE (station_id uuid, station_name text, station_frequency_label text, station_city text, ad_title text,
                       client_name text, campaign_id uuid, campaign_period_started_at timestamptz, is_campaign_active boolean,
                       campaign_action_card_id uuid, campaign_card jsonb, client_default_action_card_id uuid,
                       client_default_card jsonb, is_in_window boolean, matched_slot_started_at timestamptz,
                       last_slot_ended_at timestamptz, is_at_engagement_limit boolean)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, fingerprints, app, pg_temp
      AS $$
        SELECT station.id, station.name, station.frequency_label, station.city, ad.title, client.name,
               campaign.id, lower(campaign.active_period), campaign.status = 'ACTIVE',
               campaign.action_card_id, campaign_card.content, client.default_action_card_id, default_card.content,
               matched_slot.slot_started_at IS NOT NULL, matched_slot.slot_started_at, last_slot.slot_ended_at,
               campaign.engagement_limit IS NOT NULL AND coalesce(counter.counted_engagement_count, 0) >= campaign.engagement_limit
          FROM fingerprints.audio_assets AS asset
          JOIN app.ads AS ad ON ad.audio_asset_id = asset.id AND ad.archived_at IS NULL
          JOIN app.stations AS station ON station.id = ad.station_id AND station.status = 'ACTIVE'
          JOIN app.campaigns AS campaign ON campaign.ad_id = ad.id AND campaign.station_id = ad.station_id
           AND (campaign.status = 'ACTIVE'
                OR (campaign.status IN ('PAUSED', 'ENDED') AND campaign.status_changed_at > effective_captured_at))
          JOIN app.clients AS client ON client.id = ad.client_id AND client.station_id = ad.station_id
          LEFT JOIN app.action_cards AS campaign_card ON campaign_card.id = campaign.action_card_id
          LEFT JOIN app.action_cards AS default_card ON default_card.id = client.default_action_card_id
          LEFT JOIN app.campaign_counters AS counter ON counter.campaign_id = campaign.id
          CROSS JOIN LATERAL (SELECT effective_captured_at AT TIME ZONE station.time_zone AS local_moment) AS capture
          CROSS JOIN LATERAL (
            SELECT max(slot.slot_start AT TIME ZONE station.time_zone) AS slot_started_at
              FROM app.campaign_time_windows AS time_window
             CROSS JOIN LATERAL app.list_time_window_slots_on_air(
                     time_window.days_of_week, time_window.local_start_time, time_window.local_end_time,
                     capture.local_moment, campaign.time_window_grace_period) AS slot
             WHERE time_window.campaign_id = campaign.id
               AND campaign.active_period @> effective_captured_at
          ) AS matched_slot
          CROSS JOIN LATERAL (
            SELECT max(slot.slot_end AT TIME ZONE station.time_zone) AS slot_ended_at
              FROM app.campaign_time_windows AS time_window
             CROSS JOIN LATERAL app.list_time_window_slots(
                     time_window.days_of_week, time_window.local_start_time, time_window.local_end_time,
                     capture.local_moment - interval '7 days', capture.local_moment) AS slot
             WHERE time_window.campaign_id = campaign.id
               AND slot.slot_end <= capture.local_moment
               AND slot.slot_end >= capture.local_moment - interval '7 days'
               AND campaign.active_period @> (slot.slot_start AT TIME ZONE station.time_zone)
          ) AS last_slot
         WHERE asset.asset_number = matched_audio_asset_number
         ORDER BY station.id, lower(campaign.active_period) DESC, campaign.id
      $$`;

/**
 * Ends an attempt: its outcome, what matched, how the station was resolved, the listener's hint (kept only when
 * that station exists, P4-D9) and one candidate row for every station that could show a card (P4-D8). Only the
 * attempt still PENDING changes, so a late call from an attempt a retry overtook, or a repeated call, changes
 * nothing and returns false. Everything it is given must fit together, or nothing is stored: the resolution fits
 * the outcome; a match names a weighed station with the card it would show; each weighed station's campaign and
 * card belong together; a chooser shows 2 to 4 stations at positions 1 to n, and nothing else shows any.
 */
const FINISH_RECOGNITION = `
      CREATE FUNCTION recognition.finish_recognition(
          finished_recognition_id uuid, recognition_received_at timestamptz, finished_attempt_number integer,
          final_outcome text, fallback_reason text,
          matched_audio_asset_number integer, resolved_station_id uuid, resolved_campaign_id uuid, shown_action_card_id uuid,
          resolution text, hinted_station_id uuid, weighed_candidates jsonb,
          aligned_hash_count integer, match_margin real, match_offset_milliseconds integer, latency_milliseconds integer,
          fingerprint_version smallint)
        RETURNS boolean
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, fingerprints, app, pg_temp
      AS $$
      #variable_conflict use_column
      DECLARE
        given_candidates         jsonb := coalesce(weighed_candidates, '[]'::jsonb);
        matched_audio_asset_id   uuid;
        stored_hinted_station_id uuid;
        candidate_count          integer;
        station_count            integer;
        shown_count              integer;
        distinct_position_count  integer;
        highest_position         integer;
      BEGIN
        IF final_outcome IS NULL OR final_outcome NOT IN
            ('MATCH', 'MATCH_DEFAULT', 'CHOOSE_STATION', 'NO_MATCH', 'AMBIGUOUS', 'INVALID_AUDIO', 'TIMEOUT', 'BUSY', 'ERROR') THEN
          RAISE EXCEPTION 'unknown outcome' USING ERRCODE = '22023';
        END IF;
        IF finish_recognition.resolution IS NOT NULL AND finish_recognition.resolution NOT IN (${RESOLUTIONS}) THEN
          RAISE EXCEPTION 'unknown resolution' USING ERRCODE = '22023';
        END IF;
        -- In brackets: PL/pgSQL would otherwise end the condition at the CASE's own THEN.
        IF NOT (CASE WHEN final_outcome IN ('MATCH', 'MATCH_DEFAULT')
                       THEN coalesce(finish_recognition.resolution IN ('SINGLE_OWNER', 'SCHEDULE_UNIQUE', 'HINT'), false)
                     WHEN final_outcome = 'CHOOSE_STATION' THEN coalesce(finish_recognition.resolution = 'UNRESOLVED', false)
                     ELSE finish_recognition.resolution IS NULL
                END) THEN
          RAISE EXCEPTION 'the resolution does not fit the outcome' USING ERRCODE = '22023';
        END IF;
        IF (resolved_station_id IS NULL) <> (resolved_campaign_id IS NULL) OR (resolved_campaign_id IS NULL) <> (shown_action_card_id IS NULL) THEN
          RAISE EXCEPTION 'a station, its campaign and the card shown come together' USING ERRCODE = '22023';
        END IF;
        IF (resolved_station_id IS NOT NULL) <> (final_outcome IN ('MATCH', 'MATCH_DEFAULT')) THEN
          RAISE EXCEPTION 'a match names its station, and nothing else does' USING ERRCODE = '22023';
        END IF;
        IF resolved_campaign_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM app.campaigns AS campaign
              JOIN app.ads AS ad ON ad.id = campaign.ad_id
              JOIN app.clients AS client ON client.id = ad.client_id
             WHERE campaign.id = resolved_campaign_id AND campaign.station_id = resolved_station_id
               AND ((final_outcome = 'MATCH' AND shown_action_card_id = campaign.action_card_id)
                    OR (final_outcome = 'MATCH_DEFAULT' AND shown_action_card_id = client.default_action_card_id))) THEN
          RAISE EXCEPTION 'the station, campaign and card do not belong together' USING ERRCODE = '22023';
        END IF;

        IF jsonb_typeof(given_candidates) <> 'array' THEN
          RAISE EXCEPTION 'the weighed candidates are a list' USING ERRCODE = '22023';
        END IF;
        SELECT count(*), count(DISTINCT candidate.station_id), count(candidate.display_position),
               count(DISTINCT candidate.display_position), coalesce(max(candidate.display_position), 0)
          INTO candidate_count, station_count, shown_count, distinct_position_count, highest_position
          FROM jsonb_to_recordset(given_candidates) AS candidate(station_id uuid, campaign_id uuid, action_card_id uuid, card_kind text,
                                                                 is_in_window boolean, display_position smallint);
        IF EXISTS (
            SELECT 1 FROM jsonb_to_recordset(given_candidates) AS candidate(station_id uuid, campaign_id uuid, action_card_id uuid,
                                                                           card_kind text, is_in_window boolean, display_position smallint)
             WHERE candidate.station_id IS NULL OR candidate.campaign_id IS NULL OR candidate.action_card_id IS NULL
                OR candidate.is_in_window IS NULL OR candidate.card_kind IS NULL OR candidate.card_kind NOT IN ('CAMPAIGN', 'CLIENT_DEFAULT')) THEN
          RAISE EXCEPTION 'each weighed station names its campaign, its card, the card''s kind and whether it was on air' USING ERRCODE = '22023';
        END IF;
        IF station_count <> candidate_count THEN
          RAISE EXCEPTION 'a station is weighed once' USING ERRCODE = '22023';
        END IF;
        IF final_outcome NOT IN ('MATCH', 'MATCH_DEFAULT', 'CHOOSE_STATION') AND candidate_count > 0 THEN
          RAISE EXCEPTION 'only a match or a chooser weighs stations' USING ERRCODE = '22023';
        END IF;
        IF final_outcome = 'CHOOSE_STATION' THEN
          IF shown_count NOT BETWEEN 2 AND 4 OR distinct_position_count <> shown_count OR highest_position <> shown_count THEN
            RAISE EXCEPTION 'a chooser shows 2 to 4 stations at positions 1 to n' USING ERRCODE = '22023';
          END IF;
        ELSIF shown_count > 0 THEN
          RAISE EXCEPTION 'only a chooser shows stations in an order' USING ERRCODE = '22023';
        END IF;
        IF EXISTS (
            SELECT 1 FROM jsonb_to_recordset(given_candidates) AS candidate(station_id uuid, campaign_id uuid, action_card_id uuid,
                                                                           card_kind text, is_in_window boolean, display_position smallint)
             WHERE NOT EXISTS (
                     SELECT 1 FROM app.campaigns AS campaign
                       JOIN app.ads AS ad ON ad.id = campaign.ad_id
                       JOIN app.clients AS client ON client.id = ad.client_id
                      WHERE campaign.id = candidate.campaign_id AND campaign.station_id = candidate.station_id
                        AND ((candidate.card_kind = 'CAMPAIGN' AND candidate.action_card_id = campaign.action_card_id)
                             OR (candidate.card_kind = 'CLIENT_DEFAULT' AND candidate.action_card_id = client.default_action_card_id)))) THEN
          RAISE EXCEPTION 'a weighed station, its campaign and its card do not belong together' USING ERRCODE = '22023';
        END IF;
        IF final_outcome IN ('MATCH', 'MATCH_DEFAULT') AND NOT EXISTS (
            SELECT 1 FROM jsonb_to_recordset(given_candidates) AS candidate(station_id uuid, campaign_id uuid, action_card_id uuid,
                                                                           card_kind text, is_in_window boolean, display_position smallint)
             WHERE candidate.station_id = resolved_station_id AND candidate.campaign_id = resolved_campaign_id
               AND candidate.action_card_id = shown_action_card_id
               AND candidate.card_kind = CASE final_outcome WHEN 'MATCH' THEN 'CAMPAIGN' ELSE 'CLIENT_DEFAULT' END) THEN
          RAISE EXCEPTION 'a match is one of the weighed stations, with the card it shows' USING ERRCODE = '22023';
        END IF;

        IF matched_audio_asset_number IS NOT NULL THEN
          SELECT asset.id INTO matched_audio_asset_id FROM fingerprints.audio_assets AS asset WHERE asset.asset_number = matched_audio_asset_number;
        END IF;
        SELECT station.id INTO stored_hinted_station_id FROM app.stations AS station WHERE station.id = finish_recognition.hinted_station_id;

        UPDATE app.recognition_events AS event
           SET outcome = final_outcome, fallback_reason = finish_recognition.fallback_reason, completed_at = now(),
               audio_asset_id = matched_audio_asset_id, station_id = resolved_station_id, campaign_id = resolved_campaign_id,
               action_card_id = shown_action_card_id, resolution = finish_recognition.resolution,
               hinted_station_id = stored_hinted_station_id, aligned_hash_count = finish_recognition.aligned_hash_count,
               match_margin = finish_recognition.match_margin, match_offset_milliseconds = finish_recognition.match_offset_milliseconds,
               latency_milliseconds = finish_recognition.latency_milliseconds, fingerprint_version = finish_recognition.fingerprint_version
         WHERE event.id = finished_recognition_id AND event.received_at = finish_recognition.recognition_received_at
           AND event.outcome = 'PENDING' AND event.attempt_count = finished_attempt_number;
        IF NOT FOUND THEN
          RETURN false;
        END IF;
        INSERT INTO app.recognition_candidates (recognition_id, recognition_received_at, station_id, campaign_id, action_card_id,
                                                card_kind, is_in_window, display_position)
        SELECT finished_recognition_id, finish_recognition.recognition_received_at, candidate.station_id, candidate.campaign_id,
               candidate.action_card_id, candidate.card_kind, candidate.is_in_window, candidate.display_position
          FROM jsonb_to_recordset(given_candidates) AS candidate(station_id uuid, campaign_id uuid, action_card_id uuid, card_kind text,
                                                                 is_in_window boolean, display_position smallint);
        RETURN true;
      END
      $$`;

/**
 * What a finished recognition showed, for replaying it to the install that made it, and to no other: one row for
 * a match; one row per shown candidate, in display order, for a chooser, before or after the listener's choice;
 * one row without a station otherwise. The cards are the versions shown then (card versions never change), and
 * is_station_active lets the API withhold a station suspended since (P4-D13).
 */
const DESCRIBE_RECOGNITION_FOR_REPLAY = `
      CREATE FUNCTION recognition.describe_recognition_for_replay(described_recognition_id uuid, recognition_received_at timestamptz,
                                                                  asking_listener_install_id uuid)
        RETURNS TABLE (outcome text, is_deferred boolean, captured_at timestamptz, display_position smallint, card_kind text,
                       station_id uuid, station_name text, station_frequency_label text, station_city text, is_station_active boolean,
                       client_name text, ad_title text, action_card jsonb)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
        SELECT event.outcome, event.is_deferred, event.captured_at, shown.display_position, shown.card_kind,
               station.id, station.name, station.frequency_label, station.city, station.status = 'ACTIVE',
               client.name, ad.title, card.content
          FROM app.recognition_events AS event
          LEFT JOIN LATERAL (
            SELECT NULL::smallint AS display_position,
                   CASE event.outcome WHEN 'MATCH' THEN 'CAMPAIGN' ELSE 'CLIENT_DEFAULT' END AS card_kind,
                   event.station_id AS shown_station_id, event.campaign_id AS shown_campaign_id, event.action_card_id AS shown_action_card_id
             WHERE event.outcome IN ('MATCH', 'MATCH_DEFAULT')
            UNION ALL
            SELECT candidate.display_position, candidate.card_kind, candidate.station_id, candidate.campaign_id, candidate.action_card_id
              FROM app.recognition_candidates AS candidate
             WHERE event.outcome = 'CHOOSE_STATION' AND candidate.recognition_id = event.id
               AND candidate.recognition_received_at = event.received_at AND candidate.display_position IS NOT NULL
          ) AS shown ON true
          LEFT JOIN app.stations AS station ON station.id = shown.shown_station_id
          LEFT JOIN app.campaigns AS campaign ON campaign.id = shown.shown_campaign_id
          LEFT JOIN app.ads AS ad ON ad.id = campaign.ad_id
          LEFT JOIN app.clients AS client ON client.id = ad.client_id
          LEFT JOIN app.action_cards AS card ON card.id = shown.shown_action_card_id
         WHERE event.id = described_recognition_id
           AND event.received_at = describe_recognition_for_replay.recognition_received_at
           AND event.listener_install_id = asking_listener_install_id
         ORDER BY shown.display_position NULLS FIRST
      $$`;

/**
 * How many attempts a key this install already holds has had, or NULL for a key it does not hold (unknown, or
 * another install's). Read when a recognize request's fields arrive: a held key under 5 attempts is counted
 * against the replay allowance instead of the live or deferred one (P4-D14).
 */
const COUNT_RECOGNITION_ATTEMPTS = `
      CREATE FUNCTION recognition.count_recognition_attempts(asking_listener_install_id uuid, asked_idempotency_key uuid) RETURNS integer
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
        SELECT event.attempt_count::integer
          FROM app.recognition_idempotency_keys AS held_key
          JOIN app.recognition_events AS event
            ON event.id = held_key.recognition_event_id AND event.received_at = held_key.recognition_received_at
         WHERE held_key.listener_install_id = asking_listener_install_id AND held_key.idempotency_key = asked_idempotency_key
      $$`;

/**
 * The listener's choice on a chooser recognition its caller has already found and locked (FOR UPDATE) as the
 * install's own: NOT_A_CANDIDATE (the station was not shown), ALREADY_CHOSEN (this station was), ANOTHER_STATION_CHOSEN,
 * or CHOSEN: the candidate is chosen, and the recognition takes LISTENER_CHOICE with the candidate's station,
 * campaign and card. No counter moves. Shared by record_station_choice and record_engagement (A4), so both
 * decide alike under the same lock.
 */
const RECORD_CHOICE_ON_LOCKED_RECOGNITION = `
      CREATE FUNCTION recognition.record_choice_on_locked_recognition(chosen_recognition_id uuid, chosen_recognition_received_at timestamptz,
                                                                      chosen_station_id uuid) RETURNS text
        LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        named_candidate           app.recognition_candidates%ROWTYPE;
        previously_chosen_station uuid;
      BEGIN
        SELECT * INTO named_candidate FROM app.recognition_candidates AS candidate
         WHERE candidate.recognition_id = chosen_recognition_id AND candidate.recognition_received_at = chosen_recognition_received_at
           AND candidate.station_id = chosen_station_id AND candidate.display_position IS NOT NULL;
        IF NOT FOUND THEN
          RETURN 'NOT_A_CANDIDATE';
        END IF;
        SELECT candidate.station_id INTO previously_chosen_station FROM app.recognition_candidates AS candidate
         WHERE candidate.recognition_id = chosen_recognition_id AND candidate.recognition_received_at = chosen_recognition_received_at
           AND candidate.is_chosen;
        IF previously_chosen_station IS NOT NULL THEN
          RETURN CASE WHEN previously_chosen_station = chosen_station_id THEN 'ALREADY_CHOSEN' ELSE 'ANOTHER_STATION_CHOSEN' END;
        END IF;
        UPDATE app.recognition_candidates AS candidate SET is_chosen = true, chosen_at = now()
         WHERE candidate.recognition_id = chosen_recognition_id AND candidate.recognition_received_at = chosen_recognition_received_at
           AND candidate.station_id = chosen_station_id;
        UPDATE app.recognition_events AS event
           SET resolution = 'LISTENER_CHOICE', station_id = named_candidate.station_id, campaign_id = named_candidate.campaign_id,
               action_card_id = named_candidate.action_card_id
         WHERE event.id = chosen_recognition_id AND event.received_at = chosen_recognition_received_at;
        RETURN 'CHOSEN';
      END
      $$`;

/**
 * The listener's answer to a chooser: CHOSEN or ALREADY_CHOSEN (the same station again changes nothing),
 * NOT_FOUND (an unknown id, another install's recognition, or one that is not a chooser look the same),
 * NOT_A_CANDIDATE or ANOTHER_STATION_CHOSEN. The recognition is found by its id between the bounds its id gives,
 * so the lookup reads one or two months, and its row is locked while the choice is made.
 */
const RECORD_STATION_CHOICE = `
      CREATE FUNCTION recognition.record_station_choice(chosen_recognition_id uuid, choosing_listener_install_id uuid, chosen_station_id uuid)
        RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        chosen_event record;
      BEGIN
        SELECT event.id, event.received_at, event.outcome INTO chosen_event
          FROM app.recognition_events AS event
         WHERE event.id = chosen_recognition_id
           AND event.received_at >= recognition.compute_earliest_receipt_time(chosen_recognition_id)
           AND event.received_at <= recognition.compute_latest_receipt_time(chosen_recognition_id)
           AND event.listener_install_id = choosing_listener_install_id
           FOR UPDATE;
        IF NOT FOUND OR chosen_event.outcome <> 'CHOOSE_STATION' THEN
          RETURN 'NOT_FOUND';
        END IF;
        RETURN recognition.record_choice_on_locked_recognition(chosen_event.id, chosen_event.received_at, chosen_station_id);
      END
      $$`;

/** The stations a listener may pick as "My station": ACTIVE and listed, in a stable order, at most 1,000 (P4-D17). */
const LIST_STATIONS_FOR_LISTENERS = `
      CREATE FUNCTION recognition.list_stations_for_listeners(maximum_count integer)
        RETURNS TABLE (station_id uuid, station_name text, station_frequency_label text, station_city text)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
        SELECT station.id, station.name, station.frequency_label, station.city
          FROM app.stations AS station
         WHERE station.status = 'ACTIVE' AND station.is_listed_in_app
         ORDER BY lower(station.name) COLLATE "C", station.frequency_label COLLATE "C", station.id
         LIMIT least(greatest(coalesce(maximum_count, 0), 0), 1000)
      $$`;

/**
 * One button tap (§5.8): RECORDED or ALREADY_RECORDED (the first tap of a recognition and action wins; the answer
 * never says whether it counted), NOT_FOUND (unknown, another install's, or not finished), NOT_A_CANDIDATE (the
 * station's card was not shown, or no card was), ANOTHER_STATION_CHOSEN, or ACTION_NOT_ON_CARD. The recognition is
 * checked here, with no foreign key to lean on (A8), and locked as record_station_choice locks it: a tap on a
 * chooser nobody has answered records that station as the choice (A4). The tap's time is the phone's, corrected
 * by its clock, clamped between the recognition's receipt and the tap's arrival. A tap on the campaign's own card
 * counts toward the limit once, unless this install already has maximum_counted_taps_per_install counted taps on
 * the campaign in the last 24 hours (NULL: no cap, P4-D10); the counter statement holds the limit in its WHERE
 * clause, so two taps can never both pass a full limit.
 */
const RECORD_ENGAGEMENT = `
      CREATE FUNCTION recognition.record_engagement(
          new_engagement_id uuid, engaged_recognition_id uuid, engaging_listener_install_id uuid, engaged_station_id uuid,
          tapped_action_id uuid, corrected_occurred_at timestamptz, client_occurred_at timestamptz, clock_skew_milliseconds bigint,
          received_at timestamptz, request_id text, maximum_counted_taps_per_install integer)
        RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      #variable_conflict use_column
      DECLARE
        engaged_event             record;
        shown_campaign_id         uuid;
        shown_action_card_id      uuid;
        shown_card_kind           text;
        previously_chosen_station uuid;
        tapped_action_type        text;
        arrived_at                timestamptz;
        counted_tap_count         integer := 0;
        campaign_engagement_limit integer;
        is_tap_counted            boolean;
      BEGIN
        IF maximum_counted_taps_per_install IS NOT NULL AND maximum_counted_taps_per_install < 1 THEN
          RAISE EXCEPTION 'the per-install cap is NULL (no cap) or at least 1' USING ERRCODE = '22023';
        END IF;
        SELECT event.id, event.received_at, event.outcome, event.station_id, event.campaign_id, event.action_card_id INTO engaged_event
          FROM app.recognition_events AS event
         WHERE event.id = engaged_recognition_id
           AND event.received_at >= recognition.compute_earliest_receipt_time(engaged_recognition_id)
           AND event.received_at <= recognition.compute_latest_receipt_time(engaged_recognition_id)
           AND event.listener_install_id = engaging_listener_install_id
           FOR UPDATE;
        IF NOT FOUND OR engaged_event.outcome IN ('PENDING', 'TIMEOUT', 'BUSY', 'ERROR') THEN
          RETURN 'NOT_FOUND';
        END IF;

        IF engaged_event.outcome IN ('MATCH', 'MATCH_DEFAULT') THEN
          IF engaged_event.station_id IS DISTINCT FROM engaged_station_id THEN
            RETURN 'NOT_A_CANDIDATE';
          END IF;
          shown_campaign_id := engaged_event.campaign_id;
          shown_action_card_id := engaged_event.action_card_id;
          shown_card_kind := CASE engaged_event.outcome WHEN 'MATCH' THEN 'CAMPAIGN' ELSE 'CLIENT_DEFAULT' END;
        ELSIF engaged_event.outcome = 'CHOOSE_STATION' THEN
          SELECT candidate.campaign_id, candidate.action_card_id, candidate.card_kind
            INTO shown_campaign_id, shown_action_card_id, shown_card_kind
            FROM app.recognition_candidates AS candidate
           WHERE candidate.recognition_id = engaged_event.id AND candidate.recognition_received_at = engaged_event.received_at
             AND candidate.station_id = engaged_station_id AND candidate.display_position IS NOT NULL;
          IF NOT FOUND THEN
            RETURN 'NOT_A_CANDIDATE';
          END IF;
          SELECT candidate.station_id INTO previously_chosen_station FROM app.recognition_candidates AS candidate
           WHERE candidate.recognition_id = engaged_event.id AND candidate.recognition_received_at = engaged_event.received_at
             AND candidate.is_chosen;
          IF previously_chosen_station IS NOT NULL AND previously_chosen_station <> engaged_station_id THEN
            RETURN 'ANOTHER_STATION_CHOSEN';
          END IF;
        ELSE
          -- NO_MATCH, AMBIGUOUS and INVALID_AUDIO showed no card.
          RETURN 'NOT_A_CANDIDATE';
        END IF;

        SELECT shown_action ->> 'type' INTO tapped_action_type
          FROM app.action_cards AS card
         CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(card.content -> 'actions') = 'array' THEN card.content -> 'actions' ELSE '[]'::jsonb END) AS shown_action
         WHERE card.id = shown_action_card_id AND lower(shown_action ->> 'id') = tapped_action_id::text;
        IF tapped_action_type IS NULL THEN
          RETURN 'ACTION_NOT_ON_CARD';
        END IF;

        IF engaged_event.outcome = 'CHOOSE_STATION' AND previously_chosen_station IS NULL THEN
          PERFORM recognition.record_choice_on_locked_recognition(engaged_event.id, engaged_event.received_at, engaged_station_id);
        END IF;

        -- A tap never arrives before its recognition, even if two API instances' clocks disagree a little.
        arrived_at := greatest(record_engagement.received_at, engaged_event.received_at);
        INSERT INTO app.engagement_deduplication_keys (recognition_id, action_id, recognition_received_at, engagement_event_id, engagement_received_at)
          VALUES (engaged_event.id, tapped_action_id, engaged_event.received_at, new_engagement_id, arrived_at)
          ON CONFLICT DO NOTHING;
        IF NOT FOUND THEN
          RETURN 'ALREADY_RECORDED';
        END IF;

        IF shown_card_kind = 'CAMPAIGN' THEN
          -- One install's taps on one campaign are counted one at a time, so its cap cannot be passed by taps at once.
          PERFORM pg_advisory_xact_lock(hashtext(engaging_listener_install_id::text), hashtext(shown_campaign_id::text));
          IF maximum_counted_taps_per_install IS NOT NULL THEN
            SELECT count(*) INTO counted_tap_count
              FROM app.engagement_events AS engagement
              JOIN app.recognition_events AS tapped_recognition
                ON tapped_recognition.id = engagement.recognition_id AND tapped_recognition.received_at = engagement.recognition_received_at
             WHERE engagement.campaign_id = shown_campaign_id AND engagement.is_counted
               AND engagement.received_at > arrived_at - interval '24 hours'
               AND tapped_recognition.listener_install_id = engaging_listener_install_id;
          END IF;
          IF maximum_counted_taps_per_install IS NULL OR counted_tap_count < maximum_counted_taps_per_install THEN
            SELECT campaign.engagement_limit INTO campaign_engagement_limit FROM app.campaigns AS campaign WHERE campaign.id = shown_campaign_id;
            INSERT INTO app.campaign_counters AS counter (campaign_id, station_id, counted_engagement_count)
              VALUES (shown_campaign_id, engaged_station_id, 1)
              ON CONFLICT (campaign_id) DO UPDATE
                 SET counted_engagement_count = counter.counted_engagement_count + 1
               WHERE campaign_engagement_limit IS NULL OR counter.counted_engagement_count < campaign_engagement_limit
              RETURNING true INTO is_tap_counted;
          END IF;
        END IF;

        INSERT INTO app.engagement_events (id, received_at, recognition_id, recognition_received_at, station_id, campaign_id, action_card_id,
                                           card_kind, action_id, action_type, occurred_at, client_occurred_at, clock_skew_milliseconds,
                                           is_counted, request_id)
          VALUES (new_engagement_id, arrived_at, engaged_event.id, engaged_event.received_at, engaged_station_id, shown_campaign_id,
                  shown_action_card_id, shown_card_kind, tapped_action_id, tapped_action_type,
                  least(greatest(corrected_occurred_at, engaged_event.received_at), arrived_at), record_engagement.client_occurred_at,
                  record_engagement.clock_skew_milliseconds, coalesce(is_tap_counted, false), record_engagement.request_id);
        RETURN 'RECORDED';
      END
      $$`;

/**
 * "Report this": the same checks as a tap, without the action, and it never records a choice (P4-D28). One report
 * per recognition: the first wins, and a repeat, even with another reason, is ALREADY_RECORDED. The listener is
 * kept only as the API's keyed hash of the install; the install id is used to check the recognition is theirs and
 * is never stored.
 */
const RECORD_RECOGNITION_REPORT = `
      CREATE FUNCTION recognition.record_recognition_report(
          reported_recognition_id uuid, reporting_listener_install_id uuid, reporting_listener_install_hash text,
          reported_station_id uuid, reason text, received_at timestamptz, request_id text)
        RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      #variable_conflict use_column
      DECLARE
        reported_event            record;
        previously_chosen_station uuid;
      BEGIN
        IF record_recognition_report.reason IS NULL OR record_recognition_report.reason NOT IN (${REPORT_REASONS}) THEN
          RAISE EXCEPTION 'unknown report reason' USING ERRCODE = '22023';
        END IF;
        SELECT event.id, event.received_at, event.outcome, event.station_id INTO reported_event
          FROM app.recognition_events AS event
         WHERE event.id = reported_recognition_id
           AND event.received_at >= recognition.compute_earliest_receipt_time(reported_recognition_id)
           AND event.received_at <= recognition.compute_latest_receipt_time(reported_recognition_id)
           AND event.listener_install_id = reporting_listener_install_id
           FOR UPDATE;
        IF NOT FOUND OR reported_event.outcome IN ('PENDING', 'TIMEOUT', 'BUSY', 'ERROR') THEN
          RETURN 'NOT_FOUND';
        END IF;
        IF reported_event.outcome IN ('MATCH', 'MATCH_DEFAULT') THEN
          IF reported_event.station_id IS DISTINCT FROM reported_station_id THEN
            RETURN 'NOT_A_CANDIDATE';
          END IF;
        ELSIF reported_event.outcome = 'CHOOSE_STATION' THEN
          IF NOT EXISTS (
              SELECT 1 FROM app.recognition_candidates AS candidate
               WHERE candidate.recognition_id = reported_event.id AND candidate.recognition_received_at = reported_event.received_at
                 AND candidate.station_id = reported_station_id AND candidate.display_position IS NOT NULL) THEN
            RETURN 'NOT_A_CANDIDATE';
          END IF;
          SELECT candidate.station_id INTO previously_chosen_station FROM app.recognition_candidates AS candidate
           WHERE candidate.recognition_id = reported_event.id AND candidate.recognition_received_at = reported_event.received_at
             AND candidate.is_chosen;
          IF previously_chosen_station IS NOT NULL AND previously_chosen_station <> reported_station_id THEN
            RETURN 'ANOTHER_STATION_CHOSEN';
          END IF;
        ELSE
          RETURN 'NOT_A_CANDIDATE';
        END IF;
        INSERT INTO app.recognition_reports (recognition_id, recognition_received_at, station_id, reason, listener_install_hash, received_at, request_id)
          VALUES (reported_event.id, reported_event.received_at, reported_station_id, record_recognition_report.reason,
                  reporting_listener_install_hash, record_recognition_report.received_at, record_recognition_report.request_id)
          ON CONFLICT (recognition_id) DO NOTHING;
        IF NOT FOUND THEN
          RETURN 'ALREADY_RECORDED';
        END IF;
        RETURN 'RECORDED';
      END
      $$`;

/**
 * Deletes up to maximum_count recognition idempotency keys made more than older_than ago, oldest first, skipping
 * any a claim holds locked, and says how many went. A capture older than 24 hours is refused before any claim, so
 * a key older than that can never be needed again; anything under 25 hours is refused (P4-IDEMPOTENCY-19).
 */
const DELETE_EXPIRED_RECOGNITION_IDEMPOTENCY_KEYS = `
      CREATE FUNCTION recognition.delete_expired_recognition_idempotency_keys(older_than interval, maximum_count integer) RETURNS integer
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        deleted_count integer;
      BEGIN
        IF older_than IS NULL OR older_than < interval '25 hours' THEN
          RAISE EXCEPTION 'a key younger than 25 hours may still be retried' USING ERRCODE = '22023';
        END IF;
        IF maximum_count IS NULL OR maximum_count < 1 OR maximum_count > 10000 THEN
          RAISE EXCEPTION 'maximum_count must be between 1 and 10000' USING ERRCODE = '22023';
        END IF;
        WITH expired_keys AS (
          SELECT held_key.listener_install_id, held_key.idempotency_key
            FROM app.recognition_idempotency_keys AS held_key
           WHERE held_key.created_at < now() - older_than
           ORDER BY held_key.created_at
           LIMIT maximum_count
             FOR UPDATE SKIP LOCKED
        )
        DELETE FROM app.recognition_idempotency_keys AS held_key
         USING expired_keys
         WHERE held_key.listener_install_id = expired_keys.listener_install_id AND held_key.idempotency_key = expired_keys.idempotency_key;
        GET DIAGNOSTICS deleted_count = ROW_COUNT;
        RETURN deleted_count;
      END
      $$`;

// ---- the Step 3 functions, for the down step (from the EngineHookup and DatabaseHardening migrations) -----------

const STEP_3_CLAIM_ARGUMENTS = 'uuid, uuid, uuid, text, timestamptz, timestamptz, integer, timestamptz, boolean, integer';
const STEP_3_FINISH_ARGUMENTS = 'uuid, timestamptz, integer, text, text, integer, uuid, uuid, uuid, integer, real, integer, integer, smallint';

const STEP_3_NAME_RECOGNITION_EVENT_PARTITION_INDEXES = `
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
      END $$`;

const STEP_3_CREATE_RECOGNITION_EVENT_PARTITIONS = `
      CREATE FUNCTION app.create_recognition_event_partitions(months_ahead integer) RETURNS integer
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
              (month_start + interval '1 month') AT TIME ZONE 'UTC');
            PERFORM app.name_recognition_event_partition_indexes(partition_name);
            created_count := created_count + 1;
          END IF;
        END LOOP;
        RETURN created_count;
      END $$`;

const STEP_3_CLAIM_RECOGNITION = `
      CREATE FUNCTION recognition.claim_recognition(
          claiming_listener_install_id uuid, claimed_idempotency_key uuid, new_recognition_id uuid, request_id text,
          effective_captured_at timestamptz, client_captured_at timestamptz, clock_skew_milliseconds integer,
          received_at timestamptz, is_deferred boolean, clip_duration_milliseconds integer)
        RETURNS TABLE (recognition_id uuid, recognition_received_at timestamptz, attempt_number integer, claim_outcome text, previous_outcome text)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      #variable_conflict use_column
      DECLARE
        existing_key app.recognition_idempotency_keys%ROWTYPE;
        existing_outcome text;
        existing_last_claimed_at timestamptz;
        existing_attempt_count integer;
      BEGIN
        INSERT INTO app.recognition_idempotency_keys (listener_install_id, idempotency_key, recognition_event_id, recognition_received_at)
          VALUES (claiming_listener_install_id, claimed_idempotency_key, new_recognition_id, claim_recognition.received_at)
          ON CONFLICT DO NOTHING;
        IF FOUND THEN
          INSERT INTO app.recognition_events (id, listener_install_id, idempotency_key, request_id, captured_at, received_at,
                                              client_captured_at, clock_skew_milliseconds, is_deferred, attempt_count,
                                              outcome, clip_duration_milliseconds, last_claimed_at)
            VALUES (new_recognition_id, claiming_listener_install_id, claimed_idempotency_key, claim_recognition.request_id,
                    effective_captured_at, claim_recognition.received_at, claim_recognition.client_captured_at,
                    claim_recognition.clock_skew_milliseconds, claim_recognition.is_deferred, 1, 'PENDING',
                    claim_recognition.clip_duration_milliseconds, now());
          RETURN QUERY SELECT new_recognition_id, claim_recognition.received_at, 1, 'CLAIMED'::text, NULL::text;
          RETURN;
        END IF;

        SELECT * INTO existing_key FROM app.recognition_idempotency_keys
         WHERE listener_install_id = claiming_listener_install_id AND idempotency_key = claimed_idempotency_key FOR UPDATE;
        SELECT event.outcome, event.last_claimed_at, event.attempt_count INTO existing_outcome, existing_last_claimed_at, existing_attempt_count
          FROM app.recognition_events AS event
         WHERE event.id = existing_key.recognition_event_id AND event.received_at = existing_key.recognition_received_at
           FOR UPDATE;

        IF existing_outcome = 'PENDING' AND existing_last_claimed_at > now() - interval '30 seconds' THEN
          RETURN QUERY SELECT existing_key.recognition_event_id, existing_key.recognition_received_at, existing_attempt_count, 'IN_PROGRESS'::text, existing_outcome;
        ELSIF existing_outcome IN ('PENDING', 'TIMEOUT', 'BUSY', 'ERROR') THEN
          UPDATE app.recognition_events AS event
             SET outcome = 'PENDING', attempt_count = event.attempt_count + 1, request_id = claim_recognition.request_id,
                 last_claimed_at = now(), completed_at = NULL
           WHERE event.id = existing_key.recognition_event_id AND event.received_at = existing_key.recognition_received_at;
          RETURN QUERY SELECT existing_key.recognition_event_id, existing_key.recognition_received_at, existing_attempt_count + 1, 'RECLAIMED'::text, existing_outcome;
        ELSE
          RETURN QUERY SELECT existing_key.recognition_event_id, existing_key.recognition_received_at, existing_attempt_count, 'FINISHED'::text, existing_outcome;
        END IF;
      END
      $$`;

const STEP_3_FINISH_RECOGNITION = `
      CREATE FUNCTION recognition.finish_recognition(
          finished_recognition_id uuid, recognition_received_at timestamptz, finished_attempt_number integer,
          final_outcome text, fallback_reason text,
          matched_audio_asset_number integer, resolved_station_id uuid, resolved_campaign_id uuid, shown_action_card_id uuid,
          aligned_hash_count integer, match_margin real, match_offset_milliseconds integer, latency_milliseconds integer,
          fingerprint_version smallint)
        RETURNS boolean
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, fingerprints, app, pg_temp
      AS $$
      #variable_conflict use_column
      DECLARE
        matched_audio_asset_id uuid;
      BEGIN
        IF final_outcome NOT IN ('MATCH', 'MATCH_DEFAULT', 'CHOOSE_STATION', 'NO_MATCH', 'AMBIGUOUS', 'INVALID_AUDIO', 'TIMEOUT', 'BUSY', 'ERROR') THEN
          RAISE EXCEPTION 'unknown outcome' USING ERRCODE = '22023';
        END IF;
        IF matched_audio_asset_number IS NOT NULL THEN
          SELECT id INTO matched_audio_asset_id FROM fingerprints.audio_assets WHERE asset_number = matched_audio_asset_number;
        END IF;
        IF (resolved_station_id IS NULL) <> (resolved_campaign_id IS NULL) OR (resolved_campaign_id IS NULL) <> (shown_action_card_id IS NULL) THEN
          RAISE EXCEPTION 'a station, its campaign and the card shown come together' USING ERRCODE = '22023';
        END IF;
        IF resolved_campaign_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM app.campaigns AS campaign
              JOIN app.ads AS ad ON ad.id = campaign.ad_id
              JOIN app.clients AS client ON client.id = ad.client_id
             WHERE campaign.id = resolved_campaign_id AND campaign.station_id = resolved_station_id
               AND (shown_action_card_id = campaign.action_card_id OR shown_action_card_id = client.default_action_card_id)) THEN
          RAISE EXCEPTION 'the station, campaign and card do not belong together' USING ERRCODE = '22023';
        END IF;
        UPDATE app.recognition_events AS event
           SET outcome = final_outcome, fallback_reason = finish_recognition.fallback_reason, completed_at = now(),
               audio_asset_id = matched_audio_asset_id, station_id = resolved_station_id, campaign_id = resolved_campaign_id,
               action_card_id = shown_action_card_id, aligned_hash_count = finish_recognition.aligned_hash_count,
               match_margin = finish_recognition.match_margin, match_offset_milliseconds = finish_recognition.match_offset_milliseconds,
               latency_milliseconds = finish_recognition.latency_milliseconds, fingerprint_version = finish_recognition.fingerprint_version
         WHERE event.id = finished_recognition_id AND event.received_at = recognition_received_at AND event.outcome = 'PENDING'
           AND event.attempt_count = finished_attempt_number;
        RETURN FOUND;
      END
      $$`;

const STEP_3_FIND_STATIONS_FOR_AUDIO = `
      CREATE FUNCTION recognition.find_stations_for_audio(matched_audio_asset_number integer, effective_captured_at timestamptz)
        RETURNS TABLE (station_id uuid, station_name text, station_frequency_label text, ad_title text, client_name text,
                       campaign_id uuid, campaign_action_card_id uuid, campaign_card jsonb,
                       client_default_action_card_id uuid, client_default_card jsonb, is_in_window boolean)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, fingerprints, app, pg_temp
      AS $$
        SELECT station.id, station.name, station.frequency_label, ad.title, client.name,
               campaign.id, campaign.action_card_id, campaign_card.content,
               client.default_action_card_id, default_card.content,
               campaign.active_period @> effective_captured_at
                 AND EXISTS (
                   SELECT 1 FROM app.campaign_time_windows AS time_window
                    WHERE time_window.campaign_id = campaign.id
                      AND app.is_time_window_open(time_window.days_of_week, time_window.local_start_time, time_window.local_end_time,
                                                  effective_captured_at AT TIME ZONE station.time_zone))
          FROM fingerprints.audio_assets AS asset
          JOIN app.ads AS ad ON ad.audio_asset_id = asset.id AND ad.archived_at IS NULL
          JOIN app.stations AS station ON station.id = ad.station_id AND station.status = 'ACTIVE'
          JOIN app.campaigns AS campaign ON campaign.ad_id = ad.id AND campaign.station_id = ad.station_id AND campaign.status = 'ACTIVE'
          JOIN app.clients AS client ON client.id = ad.client_id AND client.station_id = ad.station_id
          LEFT JOIN app.action_cards AS campaign_card ON campaign_card.id = campaign.action_card_id
          LEFT JOIN app.action_cards AS default_card ON default_card.id = client.default_action_card_id
         WHERE asset.asset_number = matched_audio_asset_number
         ORDER BY lower(campaign.active_period) DESC
      $$`;

const STEP_3_DESCRIBE_RECOGNITION = `
      CREATE FUNCTION recognition.describe_recognition(described_recognition_id uuid, recognition_received_at timestamptz,
                                                       asking_listener_install_id uuid)
        RETURNS TABLE (outcome text, is_deferred boolean, captured_at timestamptz, station_id uuid, station_name text,
                       station_frequency_label text, ad_title text, client_name text, action_card jsonb)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
        SELECT event.outcome, event.is_deferred, event.captured_at, station.id, station.name, station.frequency_label,
               ad.title, client.name, card.content
          FROM app.recognition_events AS event
          LEFT JOIN app.stations AS station ON station.id = event.station_id
          LEFT JOIN app.campaigns AS campaign ON campaign.id = event.campaign_id
          LEFT JOIN app.ads AS ad ON ad.id = campaign.ad_id
          LEFT JOIN app.clients AS client ON client.id = ad.client_id
          LEFT JOIN app.action_cards AS card ON card.id = event.action_card_id
         WHERE event.id = described_recognition_id AND event.received_at = recognition_received_at
           AND event.listener_install_id = asking_listener_install_id
      $$`;
