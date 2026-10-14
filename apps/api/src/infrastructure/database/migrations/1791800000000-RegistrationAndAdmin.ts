import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 5a (docs/design/step-5a-registration-and-admin.md §2): station self sign-up, application review, the
 * super admin's second factor, changes to an approved station waiting for review (O2), team invitations and the
 * audio findings a super admin checks. One migration holds every schema change of the phase.
 *
 *  - stations: the applicant's contact, both verifications, the coverage note and stream address, the licence and
 *    its document, the submission and the last review decision. A station exists from step 1 of sign-up, before it
 *    has a name, so name and frequency are required in every status but PENDING_VERIFICATION (P5A-D2). A trigger
 *    allows only the status moves of §2.1, each by the one role it belongs to (P5A-D5).
 *  - portal_users: the super admin's encrypted second-factor secret and the last time step used; portal_sessions:
 *    when the second factor was passed. No service role may read or write either directly.
 *  - email_verification_links, station_change_requests, invitations (app) and asset_overlaps (fingerprints).
 *  - Functions for the API, each SECURITY DEFINER with its search path pinned and EXECUTE for one role only. Each
 *    checks its caller's right itself (a definer function sees past row-level security), writes its own audit row,
 *    and answers with an outcome word instead of raising, except for the unique violations the API maps.
 *  - Prefix indexes on the request ids of recognitions and audit events, for "Find by reference code".
 *
 * Two departures from the design, recorded there: the session check the guards need is a new function,
 * describe_active_portal_session, because find_active_portal_session is also called inside
 * change_portal_user_password; and the two overlap functions live in app, because calling a function in
 * fingerprints would need USAGE on that schema, which neither API role may hold (S1-PRIVILEGES-11).
 */
export class RegistrationAndAdmin1791800000000 implements MigrationInterface {
  name = 'RegistrationAndAdmin1791800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);

    // ---- stations: the application ------------------------------------------------------------------------
    await run(`
      ALTER TABLE app.stations
        ADD COLUMN coverage_note                 text,
        ADD COLUMN stream_address                text,
        ADD COLUMN contact_name                  text,
        ADD COLUMN contact_phone_number_e164     text,
        ADD COLUMN phone_verified_at             timestamptz,
        ADD COLUMN email_verified_at             timestamptz,
        ADD COLUMN licence_number                text,
        ADD COLUMN licence_document_object_key   text,
        ADD COLUMN licence_document_file_name    text,
        ADD COLUMN licence_document_content_type text,
        ADD COLUMN licence_document_byte_count   integer,
        ADD COLUMN licence_document_uploaded_at  timestamptz,
        ADD COLUMN licence_confirmed_at          timestamptz,
        ADD COLUMN application_submitted_at      timestamptz,
        ADD COLUMN review_note                   text,
        ADD COLUMN reviewed_by_portal_user_id    uuid,
        ADD COLUMN reviewed_at                   timestamptz,
        ADD CONSTRAINT stations_coverage_note_check CHECK (char_length(coverage_note) BETWEEN 1 AND 300),
        ADD CONSTRAINT stations_stream_address_check
          CHECK (char_length(stream_address) <= 500 AND stream_address ~ '^https://[^[:space:]/?#]+([/?#][^[:space:]]*)?$'),
        ADD CONSTRAINT stations_contact_name_check CHECK (char_length(contact_name) BETWEEN 1 AND 120),
        ADD CONSTRAINT stations_contact_phone_number_check CHECK (contact_phone_number_e164 ~ '^\\+[1-9][0-9]{6,14}$'),
        ADD CONSTRAINT stations_licence_number_check CHECK (char_length(licence_number) BETWEEN 1 AND 60),
        ADD CONSTRAINT stations_licence_document_file_name_check CHECK (char_length(licence_document_file_name) BETWEEN 1 AND 120),
        ADD CONSTRAINT stations_licence_document_content_type_check
          CHECK (licence_document_content_type IN (${LICENCE_DOCUMENT_CONTENT_TYPES})),
        ADD CONSTRAINT stations_licence_document_byte_count_check CHECK (licence_document_byte_count BETWEEN 1 AND 5242880),
        ADD CONSTRAINT stations_licence_document_complete_check CHECK (num_nulls(licence_document_object_key,
          licence_document_file_name, licence_document_content_type, licence_document_byte_count, licence_document_uploaded_at) IN (0, 5)),
        ADD CONSTRAINT stations_review_note_check CHECK (char_length(review_note) BETWEEN 1 AND 1000),
        ADD CONSTRAINT stations_reviewed_by_portal_user_foreign_key
          FOREIGN KEY (reviewed_by_portal_user_id) REFERENCES app.portal_users (id) ON DELETE SET NULL`);
    // Every row already has both (they were NOT NULL), so the check holds for all of them.
    await run(`
      ALTER TABLE app.stations
        ALTER COLUMN name DROP NOT NULL,
        ALTER COLUMN frequency_label DROP NOT NULL,
        ADD CONSTRAINT stations_details_required_after_verification_check
          CHECK (status = 'PENDING_VERIFICATION' OR (name IS NOT NULL AND frequency_label IS NOT NULL))`);
    await run(`CREATE INDEX stations_reviewed_by_portal_user_index ON app.stations (reviewed_by_portal_user_id)`);
    // The admin queue: submitted applications, oldest first.
    await run(`CREATE INDEX stations_application_queue_index ON app.stations (status, application_submitted_at)`);

    await run(GUARD_STATION_STATUS_CHANGE);
    await run(`
      CREATE TRIGGER stations_guard_status_change BEFORE INSERT OR UPDATE OF status ON app.stations
        FOR EACH ROW EXECUTE FUNCTION app.guard_station_status_change()`);

    // ---- portal users and sessions: the super admin's second factor ---------------------------------------
    // The secret is encrypted by the API (AES-256-GCM, its own key, the user id as associated data, §5.4).
    await run(`
      ALTER TABLE app.portal_users
        ADD COLUMN two_factor_secret_ciphertext   bytea,
        ADD COLUMN two_factor_enrolled_at         timestamptz,
        ADD COLUMN two_factor_last_used_time_step bigint,
        ADD CONSTRAINT portal_users_two_factor_enrolment_check
          CHECK ((two_factor_secret_ciphertext IS NULL) = (two_factor_enrolled_at IS NULL)),
        ADD CONSTRAINT portal_users_two_factor_secret_length_check
          CHECK (octet_length(two_factor_secret_ciphertext) BETWEEN 29 AND 128),
        ADD CONSTRAINT portal_users_two_factor_last_used_time_step_check CHECK (two_factor_last_used_time_step >= 0)`);
    await run(`ALTER TABLE app.portal_sessions ADD COLUMN two_factor_verified_at timestamptz`);
    // Resetting a lost authenticator (the operator command) also ends that super admin's sessions.
    await run(`
      ALTER TABLE app.portal_sessions
        DROP CONSTRAINT portal_sessions_revocation_reason_check,
        ADD CONSTRAINT portal_sessions_revocation_reason_check CHECK (revocation_reason IN
          ('SIGNED_OUT', 'REFRESH_TOKEN_REUSED', 'PASSWORD_CHANGED', 'ACCOUNT_DISABLED', 'SESSION_LIMIT_REACHED', 'TWO_FACTOR_RESET'))`);

    // ---- email verification links -------------------------------------------------------------------------
    // A link is single-use and lasts 24 hours; a new one supersedes the open ones (gap 3). Only the
    // registration functions touch the table: row-level security on, no policy, no grant.
    await run(`
      CREATE TABLE app.email_verification_links (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        station_id     uuid NOT NULL,
        portal_user_id uuid NOT NULL,
        token_hash     bytea NOT NULL,
        sent_to_email  app.citext NOT NULL,
        expires_at     timestamptz NOT NULL,
        confirmed_at   timestamptz,
        superseded_at  timestamptz,
        created_at     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT email_verification_links_primary_key PRIMARY KEY (id),
        CONSTRAINT email_verification_links_station_foreign_key
          FOREIGN KEY (station_id) REFERENCES app.stations (id) ON DELETE CASCADE,
        CONSTRAINT email_verification_links_portal_user_foreign_key
          FOREIGN KEY (portal_user_id) REFERENCES app.portal_users (id) ON DELETE CASCADE,
        CONSTRAINT email_verification_links_token_hash_unique UNIQUE (token_hash),
        CONSTRAINT email_verification_links_token_hash_length_check CHECK (octet_length(token_hash) = 32),
        CONSTRAINT email_verification_links_confirmed_or_superseded_check CHECK (confirmed_at IS NULL OR superseded_at IS NULL)
      )`);
    await run(`CREATE INDEX email_verification_links_station_index ON app.email_verification_links (station_id)`);
    await run(`CREATE INDEX email_verification_links_portal_user_index ON app.email_verification_links (portal_user_id)`);
    await run(`ALTER TABLE app.email_verification_links ENABLE ROW LEVEL SECURITY`);

    // ---- changes to an approved station, waiting for review (O2, P5A-D4) ---------------------------------
    // The station stays ACTIVE under its approved details until a super admin decides. Decisions are kept
    // (the station's history), so a station with requests is never deleted by accident.
    await run(`
      CREATE TABLE app.station_change_requests (
        id                            uuid NOT NULL DEFAULT gen_random_uuid(),
        station_id                    uuid NOT NULL,
        name                          text NOT NULL,
        frequency_label               text NOT NULL,
        licence_number                text NOT NULL,
        licence_document_object_key   text,
        licence_document_file_name    text,
        licence_document_content_type text,
        licence_document_byte_count   integer,
        requested_by_portal_user_id   uuid,
        requested_at                  timestamptz NOT NULL DEFAULT now(),
        decision                      text,
        decision_note                 text,
        decided_by_portal_user_id     uuid,
        decided_at                    timestamptz,
        CONSTRAINT station_change_requests_primary_key PRIMARY KEY (id),
        CONSTRAINT station_change_requests_station_foreign_key
          FOREIGN KEY (station_id) REFERENCES app.stations (id) ON DELETE RESTRICT,
        CONSTRAINT station_change_requests_requested_by_portal_user_foreign_key
          FOREIGN KEY (requested_by_portal_user_id) REFERENCES app.portal_users (id) ON DELETE SET NULL,
        CONSTRAINT station_change_requests_decided_by_portal_user_foreign_key
          FOREIGN KEY (decided_by_portal_user_id) REFERENCES app.portal_users (id) ON DELETE SET NULL,
        CONSTRAINT station_change_requests_name_check CHECK (char_length(name) BETWEEN 1 AND 120),
        CONSTRAINT station_change_requests_frequency_label_check CHECK (char_length(frequency_label) BETWEEN 1 AND 32),
        CONSTRAINT station_change_requests_licence_number_check CHECK (char_length(licence_number) BETWEEN 1 AND 60),
        CONSTRAINT station_change_requests_licence_document_file_name_check
          CHECK (char_length(licence_document_file_name) BETWEEN 1 AND 120),
        CONSTRAINT station_change_requests_licence_document_content_type_check
          CHECK (licence_document_content_type IN (${LICENCE_DOCUMENT_CONTENT_TYPES})),
        CONSTRAINT station_change_requests_licence_document_byte_count_check
          CHECK (licence_document_byte_count BETWEEN 1 AND 5242880),
        CONSTRAINT station_change_requests_licence_document_complete_check CHECK (num_nulls(licence_document_object_key,
          licence_document_file_name, licence_document_content_type, licence_document_byte_count) IN (0, 4)),
        CONSTRAINT station_change_requests_decision_check CHECK (decision IN ('APPROVED', 'REJECTED', 'WITHDRAWN')),
        CONSTRAINT station_change_requests_decision_consistency_check CHECK ((decision IS NULL) = (decided_at IS NULL)),
        CONSTRAINT station_change_requests_decision_note_check CHECK (char_length(decision_note) BETWEEN 1 AND 1000)
      )`);
    await run(`CREATE INDEX station_change_requests_station_index ON app.station_change_requests (station_id, requested_at DESC)`);
    // One open request per station: a second one is refused even when two arrive at once.
    await run(`
      CREATE UNIQUE INDEX station_change_requests_one_open_unique_index ON app.station_change_requests (station_id)
        WHERE decision IS NULL`);
    await run(`CREATE INDEX station_change_requests_requested_by_portal_user_index ON app.station_change_requests (requested_by_portal_user_id)`);
    await run(`CREATE INDEX station_change_requests_decided_by_portal_user_index ON app.station_change_requests (decided_by_portal_user_id)`);
    await run(GUARD_STATION_CHANGE_REQUEST_DECISION);
    await run(`
      CREATE TRIGGER station_change_requests_guard_decision BEFORE UPDATE ON app.station_change_requests
        FOR EACH ROW EXECUTE FUNCTION app.guard_station_change_request_decision()`);

    // ---- invitations ------------------------------------------------------------------------------------
    // Single-use, 7 days, the newest replacing an open one to the same email (P5A-D16). CLIENT_VIEWER exists in
    // the schema for phase 5c; nothing creates one yet.
    await run(`
      CREATE TABLE app.invitations (
        id                         uuid NOT NULL DEFAULT gen_random_uuid(),
        station_id                 uuid NOT NULL,
        kind                       text NOT NULL,
        station_role               text,
        client_id                  uuid,
        invited_email              app.citext NOT NULL,
        token_hash                 bytea NOT NULL,
        expires_at                 timestamptz NOT NULL,
        invited_by_portal_user_id  uuid,
        accepted_at                timestamptz,
        accepted_by_portal_user_id uuid,
        revoked_at                 timestamptz,
        created_at                 timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT invitations_primary_key PRIMARY KEY (id),
        CONSTRAINT invitations_station_foreign_key FOREIGN KEY (station_id) REFERENCES app.stations (id) ON DELETE CASCADE,
        CONSTRAINT invitations_client_foreign_key
          FOREIGN KEY (client_id, station_id) REFERENCES app.clients (id, station_id) ON DELETE CASCADE,
        CONSTRAINT invitations_invited_by_portal_user_foreign_key
          FOREIGN KEY (invited_by_portal_user_id) REFERENCES app.portal_users (id) ON DELETE SET NULL,
        CONSTRAINT invitations_accepted_by_portal_user_foreign_key
          FOREIGN KEY (accepted_by_portal_user_id) REFERENCES app.portal_users (id) ON DELETE SET NULL,
        CONSTRAINT invitations_kind_check CHECK (kind IN ('STATION_MEMBER', 'CLIENT_VIEWER')),
        CONSTRAINT invitations_station_role_check CHECK (station_role IN ('OWNER', 'MANAGER', 'ANALYST')),
        CONSTRAINT invitations_target_check CHECK (
          (kind = 'STATION_MEMBER' AND station_role IS NOT NULL AND client_id IS NULL)
          OR (kind = 'CLIENT_VIEWER' AND station_role IS NULL AND client_id IS NOT NULL)),
        CONSTRAINT invitations_invited_email_check CHECK (char_length(invited_email) BETWEEN 3 AND 254),
        CONSTRAINT invitations_token_hash_unique UNIQUE (token_hash),
        CONSTRAINT invitations_token_hash_length_check CHECK (octet_length(token_hash) = 32),
        CONSTRAINT invitations_accepted_or_revoked_check CHECK (accepted_at IS NULL OR revoked_at IS NULL)
      )`);
    await run(`CREATE INDEX invitations_station_index ON app.invitations (station_id, created_at DESC)`);
    await run(`CREATE INDEX invitations_client_index ON app.invitations (client_id)`);
    await run(`CREATE INDEX invitations_invited_by_portal_user_index ON app.invitations (invited_by_portal_user_id)`);
    await run(`CREATE INDEX invitations_accepted_by_portal_user_index ON app.invitations (accepted_by_portal_user_id)`);
    // One open invitation per station, email, kind and client; NULLS NOT DISTINCT so a member invitation (no
    // client) counts too.
    await run(`
      CREATE UNIQUE INDEX invitations_one_open_per_email_unique_index ON app.invitations (station_id, invited_email, kind, client_id)
        NULLS NOT DISTINCT WHERE accepted_at IS NULL AND revoked_at IS NULL`);

    // ---- audio findings for super admins (P5A-OVERLAP-REVIEW-04, P5A-D11) -------------------------------
    // Filled by the fingerprint worker from phase 8; in 5a, tests seed findings directly. No station data, no
    // grant to either API role: super admins read and review only through two functions.
    await run(`
      CREATE TABLE fingerprints.asset_overlaps (
        id                         uuid NOT NULL DEFAULT gen_random_uuid(),
        audio_asset_id             uuid NOT NULL,
        overlapping_audio_asset_id uuid NOT NULL,
        overlap_milliseconds       integer NOT NULL,
        found_at                   timestamptz NOT NULL DEFAULT now(),
        reviewed_at                timestamptz,
        reviewed_by_portal_user_id uuid,
        review_note                text,
        CONSTRAINT asset_overlaps_primary_key PRIMARY KEY (id),
        CONSTRAINT asset_overlaps_audio_asset_foreign_key
          FOREIGN KEY (audio_asset_id) REFERENCES fingerprints.audio_assets (id) ON DELETE CASCADE,
        CONSTRAINT asset_overlaps_overlapping_audio_asset_foreign_key
          FOREIGN KEY (overlapping_audio_asset_id) REFERENCES fingerprints.audio_assets (id) ON DELETE CASCADE,
        CONSTRAINT asset_overlaps_reviewed_by_portal_user_foreign_key
          FOREIGN KEY (reviewed_by_portal_user_id) REFERENCES app.portal_users (id) ON DELETE SET NULL,
        CONSTRAINT asset_overlaps_pair_unique UNIQUE (audio_asset_id, overlapping_audio_asset_id),
        CONSTRAINT asset_overlaps_distinct_assets_check CHECK (audio_asset_id <> overlapping_audio_asset_id),
        CONSTRAINT asset_overlaps_overlap_milliseconds_check CHECK (overlap_milliseconds > 0),
        CONSTRAINT asset_overlaps_review_note_check CHECK (char_length(review_note) BETWEEN 1 AND 1000),
        CONSTRAINT asset_overlaps_review_consistency_check CHECK (reviewed_at IS NOT NULL OR review_note IS NULL)
      )`);
    await run(`CREATE INDEX asset_overlaps_overlapping_audio_asset_index ON fingerprints.asset_overlaps (overlapping_audio_asset_id)`);
    await run(`CREATE INDEX asset_overlaps_reviewed_by_portal_user_index ON fingerprints.asset_overlaps (reviewed_by_portal_user_id)`);
    await run(`ALTER TABLE fingerprints.asset_overlaps ENABLE ROW LEVEL SECURITY`);

    // ---- "Find by reference code" (§4.6): prefix search on request ids --------------------------------------
    await run(`CREATE INDEX audit_events_request_id_index ON app.audit_events (request_id text_pattern_ops)`);
    // On the partitioned table, so every month gets one; the months already there get readable names.
    await run(`CREATE INDEX recognition_events_request_id_index ON app.recognition_events (request_id text_pattern_ops)`);
    await run(`
      SELECT app.name_listener_traffic_partition_objects('recognition_events', partition_table.relname)
        FROM pg_inherits AS inheritance
        JOIN pg_class AS partition_table ON partition_table.oid = inheritance.inhrelid
       WHERE inheritance.inhparent = 'app.recognition_events'::regclass AND partition_table.relkind = 'r'`);

    // ---- functions ----------------------------------------------------------------------------------------
    await run(IS_CURRENT_STATION_OWNER);
    await run(DESCRIBE_ACTIVE_PORTAL_SESSION);
    await run(REGISTER_STATION_APPLICANT);
    await run(CHANGE_APPLICANT_CONTACT);
    await run(RECORD_STATION_PHONE_VERIFIED);
    await run(ISSUE_EMAIL_VERIFICATION_LINK);
    await run(CONFIRM_EMAIL_VERIFICATION_LINK);
    await run(SAVE_STATION_APPLICATION_DETAILS);
    await run(SAVE_STATION_LICENCE_NUMBER);
    await run(ATTACH_STATION_LICENCE_DOCUMENT);
    await run(SUBMIT_STATION_APPLICATION);
    await run(REQUEST_STATION_DETAIL_CHANGE);
    await run(WITHDRAW_STATION_DETAIL_CHANGE);
    await run(FIND_TWO_FACTOR_SECRET);
    await run(RECORD_TWO_FACTOR_ATTEMPT);
    await run(CREATE_STATION_INVITATION);
    await run(REVOKE_STATION_INVITATION);
    await run(DESCRIBE_INVITATION);
    await run(ACCEPT_INVITATION_WITH_NEW_ACCOUNT);
    await run(ACCEPT_INVITATION_FOR_SIGNED_IN_USER);
    await run(REMOVE_STATION_MEMBER);
    await run(LIST_ASSET_OVERLAPS_FOR_REVIEW);
    await run(RECORD_ASSET_OVERLAP_REVIEW);

    // ---- row-level security --------------------------------------------------------------------------------
    for (const table of ['station_change_requests', 'invitations']) {
      await run(`ALTER TABLE app.${table} ENABLE ROW LEVEL SECURITY`);
      await run(`
        CREATE POLICY ${table}_visible_to_station ON app.${table} FOR SELECT TO lookup_api
          USING (station_id = app.current_station_id())`);
      await run(`
        CREATE POLICY ${table}_admin_full_access ON app.${table} FOR ALL TO lookup_admin_api
          USING (true) WITH CHECK (true)`);
    }
    // The team is changed only through the functions now, which keep the last owner (P5A-D16); a direct
    // delete would not.
    await run(`DROP POLICY station_memberships_managed_by_station ON app.station_memberships`);

    // ---- privileges --------------------------------------------------------------------------------------
    // Stations: the API role reads every column but the licence document's storage key (P5A-LICENCE-05); its
    // profile edits stay as they were. Everything else about an application changes only in the functions.
    await run(`REVOKE SELECT ON app.stations FROM lookup_api`);
    await run(`GRANT SELECT (${API_READABLE_STATION_COLUMNS}) ON app.stations TO lookup_api`);
    await run(`REVOKE INSERT, UPDATE, DELETE ON app.station_memberships FROM lookup_api`);
    await run(`GRANT SELECT (${API_READABLE_CHANGE_REQUEST_COLUMNS}) ON app.station_change_requests TO lookup_api`);
    await run(`GRANT SELECT (${READABLE_INVITATION_COLUMNS}) ON app.invitations TO lookup_api, lookup_admin_api`);
    // Super admins: the stations as before (with the licence key), and decisions on change requests.
    await run(`GRANT SELECT ON app.station_change_requests TO lookup_admin_api`);
    await run(`
      GRANT UPDATE (decision, decision_note, decided_by_portal_user_id, decided_at)
        ON app.station_change_requests TO lookup_admin_api`);

    for (const signature of [...API_FUNCTIONS, ...ADMIN_FUNCTIONS, ...INTERNAL_FUNCTIONS]) {
      await run(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
    }
    await run(`GRANT EXECUTE ON FUNCTION ${API_FUNCTIONS.join(', ')} TO lookup_api`);
    await run(`GRANT EXECUTE ON FUNCTION ${ADMIN_FUNCTIONS.join(', ')} TO lookup_admin_api`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);

    // ---- privileges, as before ------------------------------------------------------------------------------
    await run(`REVOKE SELECT (${API_READABLE_STATION_COLUMNS}) ON app.stations FROM lookup_api`);
    await run(`GRANT SELECT ON app.stations TO lookup_api`);
    await run(`GRANT INSERT, DELETE ON app.station_memberships TO lookup_api`);
    await run(`GRANT UPDATE (role) ON app.station_memberships TO lookup_api`);
    await run(`
      CREATE POLICY station_memberships_managed_by_station ON app.station_memberships FOR ALL TO lookup_api
        USING (station_id = app.current_station_id()) WITH CHECK (station_id = app.current_station_id())`);

    // ---- this migration's functions, tables and columns ------------------------------------------------------
    for (const signature of [...API_FUNCTIONS, ...ADMIN_FUNCTIONS, ...INTERNAL_FUNCTIONS]) {
      if (signature === 'app.guard_station_status_change()' || signature === 'app.guard_station_change_request_decision()') continue;
      await run(`DROP FUNCTION ${signature}`);
    }
    await run(`DROP INDEX app.recognition_events_request_id_index`);
    await run(`DROP INDEX app.audit_events_request_id_index`);
    await run(`DROP TABLE fingerprints.asset_overlaps`);
    await run(`DROP TABLE app.invitations`);
    await run(`DROP TABLE app.station_change_requests`);
    await run(`DROP FUNCTION app.guard_station_change_request_decision()`);
    await run(`DROP TABLE app.email_verification_links`);
    await run(`ALTER TABLE app.portal_sessions DROP COLUMN two_factor_verified_at`);
    await run(`UPDATE app.portal_sessions SET revocation_reason = 'ACCOUNT_DISABLED' WHERE revocation_reason = 'TWO_FACTOR_RESET'`);
    await run(`
      ALTER TABLE app.portal_sessions
        DROP CONSTRAINT portal_sessions_revocation_reason_check,
        ADD CONSTRAINT portal_sessions_revocation_reason_check CHECK (revocation_reason IN
          ('SIGNED_OUT', 'REFRESH_TOKEN_REUSED', 'PASSWORD_CHANGED', 'ACCOUNT_DISABLED', 'SESSION_LIMIT_REACHED'))`);
    await run(`
      ALTER TABLE app.portal_users
        DROP CONSTRAINT portal_users_two_factor_last_used_time_step_check,
        DROP CONSTRAINT portal_users_two_factor_secret_length_check,
        DROP CONSTRAINT portal_users_two_factor_enrolment_check,
        DROP COLUMN two_factor_last_used_time_step, DROP COLUMN two_factor_enrolled_at, DROP COLUMN two_factor_secret_ciphertext`);
    await run(`DROP TRIGGER stations_guard_status_change ON app.stations`);
    await run(`DROP FUNCTION app.guard_station_status_change()`);
    // A station still signing up has no name: it cannot be kept once both are required again.
    await run(`DELETE FROM app.station_memberships WHERE station_id IN (SELECT id FROM app.stations WHERE name IS NULL OR frequency_label IS NULL)`);
    await run(`DELETE FROM app.audit_events WHERE station_id IN (SELECT id FROM app.stations WHERE name IS NULL OR frequency_label IS NULL)`);
    await run(`DELETE FROM app.stations WHERE name IS NULL OR frequency_label IS NULL`);
    await run(`
      ALTER TABLE app.stations
        DROP CONSTRAINT stations_details_required_after_verification_check,
        ALTER COLUMN name SET NOT NULL,
        ALTER COLUMN frequency_label SET NOT NULL`);
    await run(`DROP INDEX app.stations_application_queue_index`);
    await run(`DROP INDEX app.stations_reviewed_by_portal_user_index`);
    await run(`
      ALTER TABLE app.stations
        DROP CONSTRAINT stations_reviewed_by_portal_user_foreign_key,
        DROP CONSTRAINT stations_review_note_check,
        DROP CONSTRAINT stations_licence_document_complete_check,
        DROP CONSTRAINT stations_licence_document_byte_count_check,
        DROP CONSTRAINT stations_licence_document_content_type_check,
        DROP CONSTRAINT stations_licence_document_file_name_check,
        DROP CONSTRAINT stations_licence_number_check,
        DROP CONSTRAINT stations_contact_phone_number_check,
        DROP CONSTRAINT stations_contact_name_check,
        DROP CONSTRAINT stations_stream_address_check,
        DROP CONSTRAINT stations_coverage_note_check,
        DROP COLUMN reviewed_at, DROP COLUMN reviewed_by_portal_user_id, DROP COLUMN review_note,
        DROP COLUMN application_submitted_at, DROP COLUMN licence_confirmed_at, DROP COLUMN licence_document_uploaded_at,
        DROP COLUMN licence_document_byte_count, DROP COLUMN licence_document_content_type, DROP COLUMN licence_document_file_name,
        DROP COLUMN licence_document_object_key, DROP COLUMN licence_number, DROP COLUMN email_verified_at,
        DROP COLUMN phone_verified_at, DROP COLUMN contact_phone_number_e164, DROP COLUMN contact_name,
        DROP COLUMN stream_address, DROP COLUMN coverage_note`);
  }
}

// ---- values ------------------------------------------------------------------------------------------------

const LICENCE_DOCUMENT_CONTENT_TYPES = `'application/pdf', 'image/jpeg'`;
/** The statuses in which an applicant may still change their application (§2.8). */
const EDITABLE_APPLICATION_STATUSES = `'PENDING_VERIFICATION', 'PENDING_REVIEW', 'REJECTED'`;
const ZAMBIAN_PROVINCES = `'Central', 'Copperbelt', 'Eastern', 'Luapula', 'Lusaka', 'Muchinga', 'Northern', 'North-Western', 'Southern', 'Western'`;

/** Every column of stations but licence_document_object_key. */
const API_READABLE_STATION_COLUMNS = [
  'id', 'name', 'frequency_label', 'province', 'city', 'time_zone', 'logo_object_key', 'status', 'is_listed_in_app', 'created_at',
  'updated_at', 'coverage_note', 'stream_address', 'contact_name', 'contact_phone_number_e164', 'phone_verified_at', 'email_verified_at',
  'licence_number', 'licence_document_file_name', 'licence_document_content_type', 'licence_document_byte_count',
  'licence_document_uploaded_at', 'licence_confirmed_at', 'application_submitted_at', 'review_note', 'reviewed_by_portal_user_id', 'reviewed_at',
].join(', ');

/** Every column of station_change_requests but licence_document_object_key. */
const API_READABLE_CHANGE_REQUEST_COLUMNS = [
  'id', 'station_id', 'name', 'frequency_label', 'licence_number', 'licence_document_file_name', 'licence_document_content_type',
  'licence_document_byte_count', 'requested_by_portal_user_id', 'requested_at', 'decision', 'decision_note', 'decided_by_portal_user_id',
  'decided_at',
].join(', ');

/** Every column of invitations but token_hash. */
const READABLE_INVITATION_COLUMNS = [
  'id', 'station_id', 'kind', 'station_role', 'client_id', 'invited_email', 'expires_at', 'invited_by_portal_user_id', 'accepted_at',
  'accepted_by_portal_user_id', 'revoked_at', 'created_at',
].join(', ');

const API_FUNCTIONS = [
  'app.describe_active_portal_session(uuid)',
  'app.register_station_applicant(text, text, text, text, bytea, text)',
  'app.change_applicant_contact(uuid, text, text, text, text)',
  'app.record_station_phone_verified(uuid, text, text)',
  'app.issue_email_verification_link(uuid, bytea, text)',
  'app.confirm_email_verification_link(bytea, text)',
  'app.save_station_application_details(uuid, text, text, text, text, text, text, text, text)',
  'app.save_station_licence_number(uuid, text, text)',
  'app.attach_station_licence_document(uuid, text, text, text, integer, text)',
  'app.submit_station_application(uuid, text)',
  'app.request_station_detail_change(uuid, text, text, text, text, text, text, integer, text)',
  'app.withdraw_station_detail_change(uuid, text)',
  'app.find_two_factor_secret(uuid)',
  'app.record_two_factor_attempt(uuid, bigint, text)',
  'app.create_station_invitation(uuid, text, text, bytea, text)',
  'app.revoke_station_invitation(uuid, uuid, text)',
  'app.describe_invitation(bytea)',
  'app.accept_invitation_with_new_account(bytea, text, text, text, bytea, text)',
  'app.accept_invitation_for_signed_in_user(bytea, text)',
  'app.remove_station_member(uuid, uuid, text)',
];

const ADMIN_FUNCTIONS = [
  'app.list_asset_overlaps_for_review()',
  'app.record_asset_overlap_review(uuid, text, text)',
];

/** Called only by the functions above (as their owner) or by the database itself: no service role may run them. */
const INTERNAL_FUNCTIONS = [
  'app.is_current_station_owner(uuid)',
  'app.guard_station_status_change()',
  'app.guard_station_change_request_decision()',
];

// ---- triggers --------------------------------------------------------------------------------------------------

/**
 * The status moves of §2.1, each by the one role it belongs to: an applicant's submission inside a definer
 * function (current_user is then the schema owner), a super admin's decisions as lookup_admin_api. A new station
 * starts PENDING_VERIFICATION. Only a superuser is exempt: the local seed and the tests' set-up; the app never
 * connects as one.
 */
const GUARD_STATION_STATUS_CHANGE = `
      CREATE FUNCTION app.guard_station_status_change() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
      AS $$
      BEGIN
        IF (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
          RETURN NEW;
        END IF;
        IF TG_OP = 'INSERT' THEN
          IF NEW.status = 'PENDING_VERIFICATION' THEN
            RETURN NEW;
          END IF;
          RAISE EXCEPTION 'a new station starts as PENDING_VERIFICATION, not %', NEW.status USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
          RETURN NEW;
        END IF;
        IF current_user = 'lookup_schema_owner' AND NEW.status = 'PENDING_REVIEW'
           AND OLD.status IN ('PENDING_VERIFICATION', 'REJECTED') THEN
          RETURN NEW;
        END IF;
        IF current_user = 'lookup_admin_api'
           AND ((OLD.status = 'PENDING_REVIEW' AND NEW.status IN ('ACTIVE', 'REJECTED'))
                OR (OLD.status = 'ACTIVE' AND NEW.status = 'SUSPENDED')
                OR (OLD.status = 'SUSPENDED' AND NEW.status = 'ACTIVE')) THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'station status cannot change from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
      END $$`;

/** A decided change request is history: nothing about it changes again (a superuser is exempt, as above). */
const GUARD_STATION_CHANGE_REQUEST_DECISION = `
      CREATE FUNCTION app.guard_station_change_request_decision() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
      AS $$
      BEGIN
        IF OLD.decision IS NOT NULL AND NOT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
          RAISE EXCEPTION 'a decided change request cannot change' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`;

// ---- functions -------------------------------------------------------------------------------------------------

/**
 * Whether the signed-in user is an active OWNER of the given station, and that station is the one the API is
 * working in. Run inside the definer functions, which see past row-level security and so check this themselves.
 */
const IS_CURRENT_STATION_OWNER = `
      CREATE FUNCTION app.is_current_station_owner(target_station_id uuid) RETURNS boolean
        LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
      AS $$
        SELECT coalesce(target_station_id = app.current_station_id(), false) AND EXISTS (
          SELECT 1 FROM app.station_memberships AS membership
            JOIN app.portal_users AS member ON member.id = membership.portal_user_id
           WHERE membership.station_id = target_station_id AND membership.portal_user_id = app.current_user_id()
             AND membership.role = 'OWNER' AND member.status = 'ACTIVE')
      $$`;

/** A live session's owner, their platform role and when the session passed the second factor (no row otherwise). */
const DESCRIBE_ACTIVE_PORTAL_SESSION = `
      CREATE FUNCTION app.describe_active_portal_session(current_portal_session_id uuid)
        RETURNS TABLE (portal_user_id uuid, platform_role text, two_factor_verified_at timestamptz)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
        SELECT session_owner.id, session_owner.platform_role, live_session.two_factor_verified_at
          FROM app.portal_sessions AS live_session
          JOIN app.portal_users AS session_owner ON session_owner.id = live_session.portal_user_id
         WHERE live_session.id = current_portal_session_id
           AND live_session.revoked_at IS NULL AND live_session.expires_at > now() AND session_owner.status = 'ACTIVE'
      $$`;

/**
 * Step 1 (P5A-D1): the portal user, the station (PENDING_VERIFICATION, the applicant as its contact), the OWNER
 * membership and a session, in one transaction. A taken email raises the unique violation on
 * portal_users_email_unique, which the API answers as EMAIL_ALREADY_REGISTERED (P5A-SIGNUP-07).
 */
const REGISTER_STATION_APPLICANT = `
      CREATE FUNCTION app.register_station_applicant(applicant_email text, applicant_full_name text,
                                                     applicant_phone_number_e164 text, applicant_password_hash text,
                                                     new_refresh_token_hash bytea, request_id text)
        RETURNS TABLE (new_portal_user_id uuid, new_station_id uuid, new_portal_session_id uuid, new_refresh_token_expires_at timestamptz)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        created_user_id uuid;
        created_station_id uuid;
        issued record;
      BEGIN
        INSERT INTO app.portal_users (email, password_hash, full_name, phone_number_e164)
        VALUES (applicant_email::app.citext, applicant_password_hash, applicant_full_name, applicant_phone_number_e164)
        RETURNING id INTO created_user_id;
        INSERT INTO app.stations (status, contact_name, contact_phone_number_e164)
        VALUES ('PENDING_VERIFICATION', applicant_full_name, applicant_phone_number_e164)
        RETURNING id INTO created_station_id;
        INSERT INTO app.station_memberships (station_id, portal_user_id, role) VALUES (created_station_id, created_user_id, 'OWNER');
        SELECT * INTO issued FROM app.issue_portal_session(created_user_id, new_refresh_token_hash, request_id);
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, request_id)
        VALUES (created_station_id, created_user_id, 'station_application_started', 'station', created_station_id, request_id);
        RETURN QUERY SELECT created_user_id, created_station_id, issued.new_portal_session_id, issued.new_refresh_token_expires_at;
      END $$`;

/**
 * Step 1 changed later. A changed phone needs a new code and a changed email a new link, so each clears its
 * verification (and a changed email supersedes the open links); the answer says which changed. A taken email
 * raises portal_users_email_unique, as at step 1.
 */
const CHANGE_APPLICANT_CONTACT = `
      CREATE FUNCTION app.change_applicant_contact(target_station_id uuid, new_full_name text, new_email text,
                                                   new_phone_number_e164 text, request_id text)
        RETURNS TABLE (outcome text, is_phone_number_changed boolean, is_email_changed boolean)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        locked_station app.stations%ROWTYPE;
        applicant app.portal_users%ROWTYPE;
        phone_number_differs boolean;
        email_differs boolean;
      BEGIN
        IF NOT app.is_current_station_owner(target_station_id) THEN
          RETURN QUERY SELECT 'NOT_ALLOWED'::text, false, false;
          RETURN;
        END IF;
        SELECT * INTO locked_station FROM app.stations WHERE id = target_station_id FOR UPDATE;
        IF locked_station.status NOT IN (${EDITABLE_APPLICATION_STATUSES}) THEN
          RETURN QUERY SELECT 'NOT_EDITABLE'::text, false, false;
          RETURN;
        END IF;
        SELECT * INTO applicant FROM app.portal_users WHERE id = app.current_user_id() FOR UPDATE;
        phone_number_differs := locked_station.contact_phone_number_e164 IS DISTINCT FROM new_phone_number_e164;
        email_differs := applicant.email IS DISTINCT FROM new_email::app.citext;
        UPDATE app.portal_users SET full_name = new_full_name, email = new_email::app.citext, phone_number_e164 = new_phone_number_e164
         WHERE id = applicant.id;
        UPDATE app.stations
           SET contact_name = new_full_name, contact_phone_number_e164 = new_phone_number_e164,
               phone_verified_at = CASE WHEN phone_number_differs THEN NULL ELSE phone_verified_at END,
               email_verified_at = CASE WHEN email_differs THEN NULL ELSE email_verified_at END
         WHERE id = target_station_id;
        IF email_differs THEN
          UPDATE app.email_verification_links SET superseded_at = now()
           WHERE station_id = target_station_id AND confirmed_at IS NULL AND superseded_at IS NULL;
        END IF;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
        VALUES (target_station_id, applicant.id, 'station_application_contact_changed', 'station', target_station_id,
                jsonb_build_object('is_full_name_changed', applicant.full_name IS DISTINCT FROM new_full_name,
                                   'is_phone_number_changed', phone_number_differs, 'is_email_changed', email_differs),
                request_id);
        RETURN QUERY SELECT 'CHANGED'::text, phone_number_differs, email_differs;
      END $$`;

/** The SMS code was right: the phone counts as confirmed only if it is still the number the code went to. */
const RECORD_STATION_PHONE_VERIFIED = `
      CREATE FUNCTION app.record_station_phone_verified(target_station_id uuid, verified_phone_number_e164 text, request_id text)
        RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        locked_station app.stations%ROWTYPE;
      BEGIN
        IF NOT app.is_current_station_owner(target_station_id) THEN
          RETURN 'NOT_ALLOWED';
        END IF;
        SELECT * INTO locked_station FROM app.stations WHERE id = target_station_id FOR UPDATE;
        IF locked_station.status NOT IN (${EDITABLE_APPLICATION_STATUSES}) THEN
          RETURN 'NOT_EDITABLE';
        END IF;
        IF locked_station.contact_phone_number_e164 IS DISTINCT FROM verified_phone_number_e164 THEN
          RETURN 'PHONE_NUMBER_CHANGED';
        END IF;
        UPDATE app.stations SET phone_verified_at = now() WHERE id = target_station_id;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, request_id)
        VALUES (target_station_id, app.current_user_id(), 'station_phone_verified', 'station', target_station_id, request_id);
        RETURN 'VERIFIED';
      END $$`;

/** A new email link, to the applicant's current address, superseding the open ones (gap 3); 24 hours. */
const ISSUE_EMAIL_VERIFICATION_LINK = `
      CREATE FUNCTION app.issue_email_verification_link(target_station_id uuid, new_token_hash bytea, request_id text)
        RETURNS TABLE (outcome text, recipient_email text, link_expires_at timestamptz)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        locked_station app.stations%ROWTYPE;
        applicant_email app.citext;
        new_link_expires_at timestamptz;
      BEGIN
        IF NOT app.is_current_station_owner(target_station_id) THEN
          RETURN QUERY SELECT 'NOT_ALLOWED'::text, NULL::text, NULL::timestamptz;
          RETURN;
        END IF;
        SELECT * INTO locked_station FROM app.stations WHERE id = target_station_id FOR UPDATE;
        IF locked_station.status NOT IN (${EDITABLE_APPLICATION_STATUSES}) THEN
          RETURN QUERY SELECT 'NOT_EDITABLE'::text, NULL::text, NULL::timestamptz;
          RETURN;
        END IF;
        IF locked_station.email_verified_at IS NOT NULL THEN
          RETURN QUERY SELECT 'ALREADY_CONFIRMED'::text, NULL::text, NULL::timestamptz;
          RETURN;
        END IF;
        SELECT email INTO applicant_email FROM app.portal_users WHERE id = app.current_user_id();
        UPDATE app.email_verification_links SET superseded_at = now()
         WHERE station_id = target_station_id AND confirmed_at IS NULL AND superseded_at IS NULL;
        INSERT INTO app.email_verification_links (station_id, portal_user_id, token_hash, sent_to_email, expires_at)
        VALUES (target_station_id, app.current_user_id(), new_token_hash, applicant_email, now() + interval '24 hours')
        RETURNING expires_at INTO new_link_expires_at;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, request_id)
        VALUES (target_station_id, app.current_user_id(), 'email_verification_link_sent', 'station', target_station_id, request_id);
        RETURN QUERY SELECT 'ISSUED'::text, applicant_email::text, new_link_expires_at;
      END $$`;

/**
 * The link opened, on any device and without a station context. It confirms the email only if it is the newest
 * link, still in time, unused, and the account's email is still the one it went to.
 */
const CONFIRM_EMAIL_VERIFICATION_LINK = `
      CREATE FUNCTION app.confirm_email_verification_link(presented_token_hash bytea, request_id text) RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        presented_link app.email_verification_links%ROWTYPE;
        account_email app.citext;
      BEGIN
        SELECT * INTO presented_link FROM app.email_verification_links WHERE token_hash = presented_token_hash FOR UPDATE;
        IF NOT FOUND THEN
          RETURN 'NOT_FOUND';
        END IF;
        IF presented_link.confirmed_at IS NOT NULL THEN
          RETURN 'ALREADY_CONFIRMED';
        END IF;
        IF presented_link.superseded_at IS NOT NULL THEN
          RETURN 'SUPERSEDED';
        END IF;
        IF presented_link.expires_at <= now() THEN
          RETURN 'EXPIRED';
        END IF;
        SELECT email INTO account_email FROM app.portal_users WHERE id = presented_link.portal_user_id;
        IF account_email IS DISTINCT FROM presented_link.sent_to_email THEN
          RETURN 'EMAIL_CHANGED';
        END IF;
        UPDATE app.email_verification_links SET confirmed_at = now() WHERE id = presented_link.id;
        UPDATE app.stations SET email_verified_at = now() WHERE id = presented_link.station_id;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, request_id)
        VALUES (presented_link.station_id, presented_link.portal_user_id, 'station_email_verified', 'station', presented_link.station_id, request_id);
        RETURN 'CONFIRMED';
      END $$`;

/** Step 3. The province must be one of the ten, the time zone one the database knows. */
const SAVE_STATION_APPLICATION_DETAILS = `
      CREATE FUNCTION app.save_station_application_details(target_station_id uuid, new_name text, new_frequency_label text,
                                                           new_province text, new_city text, new_time_zone text,
                                                           new_coverage_note text, new_stream_address text, request_id text)
        RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        locked_station app.stations%ROWTYPE;
      BEGIN
        IF NOT app.is_current_station_owner(target_station_id) THEN
          RETURN 'NOT_ALLOWED';
        END IF;
        SELECT * INTO locked_station FROM app.stations WHERE id = target_station_id FOR UPDATE;
        IF locked_station.status NOT IN (${EDITABLE_APPLICATION_STATUSES}) THEN
          RETURN 'NOT_EDITABLE';
        END IF;
        IF new_province IS NULL OR new_province NOT IN (${ZAMBIAN_PROVINCES}) THEN
          RETURN 'PROVINCE_NOT_VALID';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names AS known_zone WHERE known_zone.name = new_time_zone) THEN
          RETURN 'TIME_ZONE_NOT_VALID';
        END IF;
        UPDATE app.stations
           SET name = new_name, frequency_label = new_frequency_label, province = new_province, city = new_city,
               time_zone = new_time_zone, coverage_note = new_coverage_note, stream_address = new_stream_address
         WHERE id = target_station_id;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
        VALUES (target_station_id, app.current_user_id(), 'station_application_details_saved', 'station', target_station_id,
                jsonb_build_object('changed_fields', to_jsonb(array_remove(ARRAY[
                  CASE WHEN locked_station.name IS DISTINCT FROM new_name THEN 'name' END,
                  CASE WHEN locked_station.frequency_label IS DISTINCT FROM new_frequency_label THEN 'frequency_label' END,
                  CASE WHEN locked_station.province IS DISTINCT FROM new_province THEN 'province' END,
                  CASE WHEN locked_station.city IS DISTINCT FROM new_city THEN 'city' END,
                  CASE WHEN locked_station.time_zone IS DISTINCT FROM new_time_zone THEN 'time_zone' END,
                  CASE WHEN locked_station.coverage_note IS DISTINCT FROM new_coverage_note THEN 'coverage_note' END,
                  CASE WHEN locked_station.stream_address IS DISTINCT FROM new_stream_address THEN 'stream_address' END], NULL))),
                request_id);
        RETURN 'SAVED';
      END $$`;

/** Step 4: the licence number. */
const SAVE_STATION_LICENCE_NUMBER = `
      CREATE FUNCTION app.save_station_licence_number(target_station_id uuid, new_licence_number text, request_id text) RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        locked_station app.stations%ROWTYPE;
      BEGIN
        IF NOT app.is_current_station_owner(target_station_id) THEN
          RETURN 'NOT_ALLOWED';
        END IF;
        SELECT * INTO locked_station FROM app.stations WHERE id = target_station_id FOR UPDATE;
        IF locked_station.status NOT IN (${EDITABLE_APPLICATION_STATUSES}) THEN
          RETURN 'NOT_EDITABLE';
        END IF;
        UPDATE app.stations SET licence_number = new_licence_number WHERE id = target_station_id;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
        VALUES (target_station_id, app.current_user_id(), 'station_licence_number_saved', 'station', target_station_id,
                jsonb_build_object('is_changed', locked_station.licence_number IS DISTINCT FROM new_licence_number), request_id);
        RETURN 'SAVED';
      END $$`;

/** Step 4: the licence document, checked by the API. The replaced document's key comes back for deletion. */
const ATTACH_STATION_LICENCE_DOCUMENT = `
      CREATE FUNCTION app.attach_station_licence_document(target_station_id uuid, new_object_key text, new_file_name text,
                                                          new_content_type text, new_byte_count integer, request_id text)
        RETURNS TABLE (outcome text, replaced_object_key text)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        locked_station app.stations%ROWTYPE;
      BEGIN
        IF NOT app.is_current_station_owner(target_station_id) THEN
          RETURN QUERY SELECT 'NOT_ALLOWED'::text, NULL::text;
          RETURN;
        END IF;
        SELECT * INTO locked_station FROM app.stations WHERE id = target_station_id FOR UPDATE;
        IF locked_station.status NOT IN (${EDITABLE_APPLICATION_STATUSES}) THEN
          RETURN QUERY SELECT 'NOT_EDITABLE'::text, NULL::text;
          RETURN;
        END IF;
        UPDATE app.stations
           SET licence_document_object_key = new_object_key, licence_document_file_name = new_file_name,
               licence_document_content_type = new_content_type, licence_document_byte_count = new_byte_count,
               licence_document_uploaded_at = now()
         WHERE id = target_station_id;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
        VALUES (target_station_id, app.current_user_id(), 'station_licence_document_attached', 'station', target_station_id,
                jsonb_build_object('content_type', new_content_type, 'byte_count', new_byte_count,
                                   'is_replacement', locked_station.licence_document_object_key IS NOT NULL),
                request_id);
        RETURN QUERY SELECT 'ATTACHED'::text, locked_station.licence_document_object_key;
      END $$`;

/**
 * Submit for review (or again, after a rejection) if everything is there (P5A-D3): station details, licence number
 * and document, the phone and the email confirmed. The confirmation box is required by the API's input.
 */
const SUBMIT_STATION_APPLICATION = `
      CREATE FUNCTION app.submit_station_application(target_station_id uuid, request_id text)
        RETURNS TABLE (outcome text, missing_parts text[])
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        locked_station app.stations%ROWTYPE;
        missing text[];
      BEGIN
        IF NOT app.is_current_station_owner(target_station_id) THEN
          RETURN QUERY SELECT 'NOT_ALLOWED'::text, ARRAY[]::text[];
          RETURN;
        END IF;
        SELECT * INTO locked_station FROM app.stations WHERE id = target_station_id FOR UPDATE;
        IF locked_station.status = 'PENDING_REVIEW' THEN
          RETURN QUERY SELECT 'ALREADY_SUBMITTED'::text, ARRAY[]::text[];
          RETURN;
        END IF;
        IF locked_station.status NOT IN ('PENDING_VERIFICATION', 'REJECTED') THEN
          RETURN QUERY SELECT 'NOT_EDITABLE'::text, ARRAY[]::text[];
          RETURN;
        END IF;
        missing := array_remove(ARRAY[
          CASE WHEN locked_station.name IS NULL OR locked_station.frequency_label IS NULL
                    OR locked_station.province IS NULL OR locked_station.city IS NULL THEN 'station_details_missing' END,
          CASE WHEN locked_station.licence_number IS NULL THEN 'licence_number_missing' END,
          CASE WHEN locked_station.licence_document_object_key IS NULL THEN 'licence_document_missing' END,
          CASE WHEN locked_station.phone_verified_at IS NULL THEN 'phone_not_verified' END,
          CASE WHEN locked_station.email_verified_at IS NULL THEN 'email_not_verified' END], NULL);
        IF cardinality(missing) > 0 THEN
          RETURN QUERY SELECT 'INCOMPLETE'::text, missing;
          RETURN;
        END IF;
        UPDATE app.stations
           SET status = 'PENDING_REVIEW', licence_confirmed_at = now(), application_submitted_at = now()
         WHERE id = target_station_id;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
        VALUES (target_station_id, app.current_user_id(), 'station_application_submitted', 'station', target_station_id,
                jsonb_build_object('is_resubmission', locked_station.status = 'REJECTED'), request_id);
        RETURN QUERY SELECT 'SUBMITTED'::text, ARRAY[]::text[];
      END $$`;

/** O2 for an ACTIVE station: one open request at a time, and only if something differs from what was approved. */
const REQUEST_STATION_DETAIL_CHANGE = `
      CREATE FUNCTION app.request_station_detail_change(target_station_id uuid, new_name text, new_frequency_label text,
                                                        new_licence_number text, new_document_object_key text,
                                                        new_document_file_name text, new_document_content_type text,
                                                        new_document_byte_count integer, request_id text)
        RETURNS TABLE (outcome text, change_request_id uuid)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        locked_station app.stations%ROWTYPE;
        created_request_id uuid;
      BEGIN
        IF NOT app.is_current_station_owner(target_station_id) THEN
          RETURN QUERY SELECT 'NOT_ALLOWED'::text, NULL::uuid;
          RETURN;
        END IF;
        SELECT * INTO locked_station FROM app.stations WHERE id = target_station_id FOR UPDATE;
        IF locked_station.status <> 'ACTIVE' THEN
          RETURN QUERY SELECT 'NOT_EDITABLE'::text, NULL::uuid;
          RETURN;
        END IF;
        IF EXISTS (SELECT 1 FROM app.station_change_requests AS open_request
                    WHERE open_request.station_id = target_station_id AND open_request.decision IS NULL) THEN
          RETURN QUERY SELECT 'ALREADY_OPEN'::text, NULL::uuid;
          RETURN;
        END IF;
        IF new_name = locked_station.name AND new_frequency_label = locked_station.frequency_label
           AND new_licence_number IS NOT DISTINCT FROM locked_station.licence_number AND new_document_object_key IS NULL THEN
          RETURN QUERY SELECT 'NOTHING_CHANGED'::text, NULL::uuid;
          RETURN;
        END IF;
        INSERT INTO app.station_change_requests (station_id, name, frequency_label, licence_number, licence_document_object_key,
                                                 licence_document_file_name, licence_document_content_type,
                                                 licence_document_byte_count, requested_by_portal_user_id)
        VALUES (target_station_id, new_name, new_frequency_label, new_licence_number, new_document_object_key,
                new_document_file_name, new_document_content_type, new_document_byte_count, app.current_user_id())
        RETURNING id INTO created_request_id;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
        VALUES (target_station_id, app.current_user_id(), 'station_detail_change_requested', 'station_change_request', created_request_id,
                jsonb_build_object('changed_fields', to_jsonb(array_remove(ARRAY[
                  CASE WHEN new_name <> locked_station.name THEN 'name' END,
                  CASE WHEN new_frequency_label <> locked_station.frequency_label THEN 'frequency_label' END,
                  CASE WHEN new_licence_number IS DISTINCT FROM locked_station.licence_number THEN 'licence_number' END,
                  CASE WHEN new_document_object_key IS NOT NULL THEN 'licence_document' END], NULL))),
                request_id);
        RETURN QUERY SELECT 'REQUESTED'::text, created_request_id;
      END $$`;

/** Withdraws the open change request; its new document's key comes back for deletion. */
const WITHDRAW_STATION_DETAIL_CHANGE = `
      CREATE FUNCTION app.withdraw_station_detail_change(target_station_id uuid, request_id text)
        RETURNS TABLE (outcome text, withdrawn_document_object_key text)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        open_request app.station_change_requests%ROWTYPE;
      BEGIN
        IF NOT app.is_current_station_owner(target_station_id) THEN
          RETURN QUERY SELECT 'NOT_ALLOWED'::text, NULL::text;
          RETURN;
        END IF;
        SELECT * INTO open_request FROM app.station_change_requests AS candidate
         WHERE candidate.station_id = target_station_id AND candidate.decision IS NULL FOR UPDATE;
        IF NOT FOUND THEN
          RETURN QUERY SELECT 'NONE_OPEN'::text, NULL::text;
          RETURN;
        END IF;
        UPDATE app.station_change_requests
           SET decision = 'WITHDRAWN', decided_at = now(), decided_by_portal_user_id = app.current_user_id()
         WHERE id = open_request.id;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, request_id)
        VALUES (target_station_id, app.current_user_id(), 'station_detail_change_withdrawn', 'station_change_request', open_request.id, request_id);
        RETURN QUERY SELECT 'WITHDRAWN'::text, open_request.licence_document_object_key;
      END $$`;

/** The encrypted secret of a live session's enrolled SUPER_ADMIN, with the last step used (no row otherwise). */
const FIND_TWO_FACTOR_SECRET = `
      CREATE FUNCTION app.find_two_factor_secret(current_portal_session_id uuid)
        RETURNS TABLE (portal_user_id uuid, two_factor_secret_ciphertext bytea, two_factor_last_used_time_step bigint)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
        SELECT session_owner.id, session_owner.two_factor_secret_ciphertext, session_owner.two_factor_last_used_time_step
          FROM app.portal_sessions AS live_session
          JOIN app.portal_users AS session_owner ON session_owner.id = live_session.portal_user_id
         WHERE live_session.id = current_portal_session_id
           AND live_session.revoked_at IS NULL AND live_session.expires_at > now() AND session_owner.status = 'ACTIVE'
           AND session_owner.platform_role = 'SUPER_ADMIN' AND session_owner.two_factor_enrolled_at IS NOT NULL
      $$`;

/**
 * One second-factor attempt. A null step is a wrong code. A right code counts only for a time step later than the
 * last one used, so each code works once (NIST SP 800-63B-4 §3.1.4.2); then the session has passed.
 */
const RECORD_TWO_FACTOR_ATTEMPT = `
      CREATE FUNCTION app.record_two_factor_attempt(current_portal_session_id uuid, accepted_time_step bigint, request_id text)
        RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        session_owner_id uuid;
        last_used_time_step bigint;
      BEGIN
        SELECT session_owner.id, session_owner.two_factor_last_used_time_step INTO session_owner_id, last_used_time_step
          FROM app.portal_sessions AS live_session
          JOIN app.portal_users AS session_owner ON session_owner.id = live_session.portal_user_id
         WHERE live_session.id = current_portal_session_id
           AND live_session.revoked_at IS NULL AND live_session.expires_at > now() AND session_owner.status = 'ACTIVE'
           AND session_owner.platform_role = 'SUPER_ADMIN' AND session_owner.two_factor_enrolled_at IS NOT NULL
           FOR UPDATE OF session_owner;
        IF NOT FOUND THEN
          RETURN 'NOT_ALLOWED';
        END IF;
        IF accepted_time_step IS NULL OR accepted_time_step <= coalesce(last_used_time_step, -1) THEN
          INSERT INTO app.audit_events (actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
          VALUES (session_owner_id, 'two_factor_failed', 'portal_session', current_portal_session_id,
                  jsonb_build_object('is_code_reused', accepted_time_step IS NOT NULL), request_id);
          RETURN CASE WHEN accepted_time_step IS NULL THEN 'FAILED' ELSE 'CODE_ALREADY_USED' END;
        END IF;
        UPDATE app.portal_users SET two_factor_last_used_time_step = accepted_time_step WHERE id = session_owner_id;
        UPDATE app.portal_sessions SET two_factor_verified_at = now() WHERE id = current_portal_session_id;
        INSERT INTO app.audit_events (actor_portal_user_id, action, entity_type, entity_id, request_id)
        VALUES (session_owner_id, 'two_factor_succeeded', 'portal_session', current_portal_session_id, request_id);
        RETURN 'ACCEPTED';
      END $$`;

/**
 * An OWNER of an active station invites someone by email (P5A-D16): an open invitation to the same email is
 * revoked first, and an email that already belongs to a member is refused. Seven days, single use.
 */
const CREATE_STATION_INVITATION = `
      CREATE FUNCTION app.create_station_invitation(target_station_id uuid, new_invited_email text, new_station_role text,
                                                    new_token_hash bytea, request_id text)
        RETURNS TABLE (outcome text, invitation_id uuid, invitation_expires_at timestamptz)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        station_status text;
        created_invitation_id uuid;
        created_expires_at timestamptz;
      BEGIN
        IF NOT app.is_current_station_owner(target_station_id) THEN
          RETURN QUERY SELECT 'NOT_ALLOWED'::text, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        SELECT status INTO station_status FROM app.stations WHERE id = target_station_id FOR UPDATE;
        IF station_status <> 'ACTIVE' THEN
          RETURN QUERY SELECT 'STATION_NOT_ACTIVE'::text, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        IF EXISTS (SELECT 1 FROM app.station_memberships AS membership
                     JOIN app.portal_users AS member ON member.id = membership.portal_user_id
                    WHERE membership.station_id = target_station_id AND member.email = new_invited_email::app.citext) THEN
          RETURN QUERY SELECT 'ALREADY_A_MEMBER'::text, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        UPDATE app.invitations SET revoked_at = now()
         WHERE station_id = target_station_id AND kind = 'STATION_MEMBER' AND invited_email = new_invited_email::app.citext
           AND accepted_at IS NULL AND revoked_at IS NULL;
        INSERT INTO app.invitations (station_id, kind, station_role, invited_email, token_hash, expires_at, invited_by_portal_user_id)
        VALUES (target_station_id, 'STATION_MEMBER', new_station_role, new_invited_email::app.citext, new_token_hash,
                now() + interval '7 days', app.current_user_id())
        RETURNING id, expires_at INTO created_invitation_id, created_expires_at;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
        VALUES (target_station_id, app.current_user_id(), 'invitation_created', 'invitation', created_invitation_id,
                jsonb_build_object('station_role', new_station_role), request_id);
        RETURN QUERY SELECT 'CREATED'::text, created_invitation_id, created_expires_at;
      END $$`;

/** An OWNER withdraws an open invitation of their station. */
const REVOKE_STATION_INVITATION = `
      CREATE FUNCTION app.revoke_station_invitation(target_station_id uuid, target_invitation_id uuid, request_id text) RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      BEGIN
        IF NOT app.is_current_station_owner(target_station_id) THEN
          RETURN 'NOT_ALLOWED';
        END IF;
        UPDATE app.invitations SET revoked_at = now()
         WHERE id = target_invitation_id AND station_id = target_station_id AND accepted_at IS NULL AND revoked_at IS NULL;
        IF NOT FOUND THEN
          RETURN 'NOT_FOUND';
        END IF;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, request_id)
        VALUES (target_station_id, app.current_user_id(), 'invitation_revoked', 'invitation', target_invitation_id, request_id);
        RETURN 'REVOKED';
      END $$`;

/**
 * What an invitation link leads to, for its holder only (the token is 32 random bytes): its state, the station,
 * the role, the invited email, whether that email already has an account, and the expiry. No row when unknown.
 */
const DESCRIBE_INVITATION = `
      CREATE FUNCTION app.describe_invitation(presented_token_hash bytea)
        RETURNS TABLE (invitation_state text, station_name text, station_frequency_label text, invited_role text,
                       invited_email text, has_account boolean, invitation_expires_at timestamptz)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
        SELECT CASE WHEN invitation.accepted_at IS NOT NULL THEN 'ACCEPTED'
                    WHEN invitation.revoked_at IS NOT NULL THEN 'REVOKED'
                    WHEN invitation.expires_at <= now() THEN 'EXPIRED'
                    ELSE 'OPEN' END,
               station.name, station.frequency_label, invitation.station_role, invitation.invited_email::text,
               EXISTS (SELECT 1 FROM app.portal_users AS account WHERE account.email = invitation.invited_email),
               invitation.expires_at
          FROM app.invitations AS invitation
          JOIN app.stations AS station ON station.id = invitation.station_id
         WHERE invitation.token_hash = presented_token_hash AND invitation.kind = 'STATION_MEMBER'
      $$`;

/**
 * Accepting with a new account: the email is the invited one (the link proves it), so no email check follows.
 * An email that already has an account must sign in and accept instead.
 */
const ACCEPT_INVITATION_WITH_NEW_ACCOUNT = `
      CREATE FUNCTION app.accept_invitation_with_new_account(presented_token_hash bytea, new_full_name text,
                                                             new_phone_number_e164 text, new_password_hash text,
                                                             new_refresh_token_hash bytea, request_id text)
        RETURNS TABLE (outcome text, new_portal_user_id uuid, joined_station_id uuid, new_portal_session_id uuid,
                       new_refresh_token_expires_at timestamptz)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        presented_invitation app.invitations%ROWTYPE;
        created_user_id uuid;
        issued record;
      BEGIN
        SELECT * INTO presented_invitation FROM app.invitations AS invitation
         WHERE invitation.token_hash = presented_token_hash AND invitation.kind = 'STATION_MEMBER' FOR UPDATE;
        IF NOT FOUND THEN
          RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        IF presented_invitation.accepted_at IS NOT NULL OR presented_invitation.revoked_at IS NOT NULL THEN
          RETURN QUERY SELECT CASE WHEN presented_invitation.accepted_at IS NOT NULL THEN 'ALREADY_ACCEPTED' ELSE 'REVOKED' END,
                              NULL::uuid, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        IF presented_invitation.expires_at <= now() THEN
          RETURN QUERY SELECT 'EXPIRED'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        IF EXISTS (SELECT 1 FROM app.portal_users AS account WHERE account.email = presented_invitation.invited_email) THEN
          RETURN QUERY SELECT 'ACCOUNT_EXISTS'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        INSERT INTO app.portal_users (email, password_hash, full_name, phone_number_e164)
        VALUES (presented_invitation.invited_email, new_password_hash, new_full_name, new_phone_number_e164)
        RETURNING id INTO created_user_id;
        INSERT INTO app.station_memberships (station_id, portal_user_id, role)
        VALUES (presented_invitation.station_id, created_user_id, presented_invitation.station_role);
        UPDATE app.invitations SET accepted_at = now(), accepted_by_portal_user_id = created_user_id WHERE id = presented_invitation.id;
        SELECT * INTO issued FROM app.issue_portal_session(created_user_id, new_refresh_token_hash, request_id);
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
        VALUES (presented_invitation.station_id, created_user_id, 'invitation_accepted', 'invitation', presented_invitation.id,
                jsonb_build_object('station_role', presented_invitation.station_role, 'is_new_account', true), request_id);
        RETURN QUERY SELECT 'ACCEPTED'::text, created_user_id, presented_invitation.station_id,
                            issued.new_portal_session_id, issued.new_refresh_token_expires_at;
      END $$`;

/** Accepting while signed in: only with the invited email, and only once. */
const ACCEPT_INVITATION_FOR_SIGNED_IN_USER = `
      CREATE FUNCTION app.accept_invitation_for_signed_in_user(presented_token_hash bytea, request_id text)
        RETURNS TABLE (outcome text, joined_station_id uuid)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        presented_invitation app.invitations%ROWTYPE;
        signed_in_email app.citext;
      BEGIN
        SELECT account.email INTO signed_in_email FROM app.portal_users AS account
         WHERE account.id = app.current_user_id() AND account.status = 'ACTIVE';
        IF NOT FOUND THEN
          RETURN QUERY SELECT 'NOT_SIGNED_IN'::text, NULL::uuid;
          RETURN;
        END IF;
        SELECT * INTO presented_invitation FROM app.invitations AS invitation
         WHERE invitation.token_hash = presented_token_hash AND invitation.kind = 'STATION_MEMBER' FOR UPDATE;
        IF NOT FOUND THEN
          RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::uuid;
          RETURN;
        END IF;
        IF presented_invitation.accepted_at IS NOT NULL OR presented_invitation.revoked_at IS NOT NULL THEN
          RETURN QUERY SELECT CASE WHEN presented_invitation.accepted_at IS NOT NULL THEN 'ALREADY_ACCEPTED' ELSE 'REVOKED' END, NULL::uuid;
          RETURN;
        END IF;
        IF presented_invitation.expires_at <= now() THEN
          RETURN QUERY SELECT 'EXPIRED'::text, NULL::uuid;
          RETURN;
        END IF;
        IF signed_in_email <> presented_invitation.invited_email THEN
          RETURN QUERY SELECT 'FOR_ANOTHER_EMAIL'::text, NULL::uuid;
          RETURN;
        END IF;
        IF EXISTS (SELECT 1 FROM app.station_memberships AS membership
                    WHERE membership.station_id = presented_invitation.station_id AND membership.portal_user_id = app.current_user_id()) THEN
          RETURN QUERY SELECT 'ALREADY_A_MEMBER'::text, presented_invitation.station_id;
          RETURN;
        END IF;
        INSERT INTO app.station_memberships (station_id, portal_user_id, role)
        VALUES (presented_invitation.station_id, app.current_user_id(), presented_invitation.station_role);
        UPDATE app.invitations SET accepted_at = now(), accepted_by_portal_user_id = app.current_user_id() WHERE id = presented_invitation.id;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
        VALUES (presented_invitation.station_id, app.current_user_id(), 'invitation_accepted', 'invitation', presented_invitation.id,
                jsonb_build_object('station_role', presented_invitation.station_role, 'is_new_account', false), request_id);
        RETURN QUERY SELECT 'ACCEPTED'::text, presented_invitation.station_id;
      END $$`;

/**
 * An OWNER removes a member. The station's OWNER rows are locked first, so two owners removing each other at once
 * cannot leave the station with none (P5A-D16).
 */
const REMOVE_STATION_MEMBER = `
      CREATE FUNCTION app.remove_station_member(target_station_id uuid, removed_portal_user_id uuid, request_id text) RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        removed_role text;
        owner_count integer;
      BEGIN
        IF NOT app.is_current_station_owner(target_station_id) THEN
          RETURN 'NOT_ALLOWED';
        END IF;
        PERFORM 1 FROM app.station_memberships AS owner_membership
          WHERE owner_membership.station_id = target_station_id AND owner_membership.role = 'OWNER' FOR UPDATE;
        SELECT membership.role INTO removed_role FROM app.station_memberships AS membership
         WHERE membership.station_id = target_station_id AND membership.portal_user_id = removed_portal_user_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN 'NOT_FOUND';
        END IF;
        SELECT count(*)::integer INTO owner_count FROM app.station_memberships AS owner_membership
         WHERE owner_membership.station_id = target_station_id AND owner_membership.role = 'OWNER';
        IF removed_role = 'OWNER' AND owner_count <= 1 THEN
          RETURN 'LAST_OWNER';
        END IF;
        DELETE FROM app.station_memberships AS membership
         WHERE membership.station_id = target_station_id AND membership.portal_user_id = removed_portal_user_id;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
        VALUES (target_station_id, app.current_user_id(), 'station_member_removed', 'portal_user', removed_portal_user_id,
                jsonb_build_object('station_role', removed_role), request_id);
        RETURN 'REMOVED';
      END $$`;

/**
 * Whether the signed-in user (set by the admin data source) is an active SUPER_ADMIN: the overlap functions check
 * it themselves, as every definer function checks its caller.
 */
const IS_SUPER_ADMIN_CONDITION = `EXISTS (SELECT 1 FROM app.portal_users AS admin_user
                    WHERE admin_user.id = app.current_user_id() AND admin_user.platform_role = 'SUPER_ADMIN' AND admin_user.status = 'ACTIVE')`;

/** "Audio to check": each finding, its two recordings, and the ads (with their stations) that use each. */
const LIST_ASSET_OVERLAPS_FOR_REVIEW = `
      CREATE FUNCTION app.list_asset_overlaps_for_review()
        RETURNS TABLE (finding_id uuid, audio_asset_id uuid, audio_asset_number integer, overlapping_audio_asset_id uuid,
                       overlapping_audio_asset_number integer, overlap_milliseconds integer, found_at timestamptz,
                       reviewed_at timestamptz, review_note text, audio_asset_ads jsonb, overlapping_audio_asset_ads jsonb)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
        SELECT finding.id, finding.audio_asset_id, first_asset.asset_number, finding.overlapping_audio_asset_id,
               second_asset.asset_number, finding.overlap_milliseconds, finding.found_at, finding.reviewed_at, finding.review_note,
               app_ads.audio_asset_ads, overlapping_ads.audio_asset_ads
          FROM fingerprints.asset_overlaps AS finding
          JOIN fingerprints.audio_assets AS first_asset ON first_asset.id = finding.audio_asset_id
          JOIN fingerprints.audio_assets AS second_asset ON second_asset.id = finding.overlapping_audio_asset_id
          CROSS JOIN LATERAL (
            SELECT coalesce(jsonb_agg(jsonb_build_object('ad_id', ad.id, 'ad_title', ad.title, 'station_id', station.id,
                                                         'station_name', station.name) ORDER BY ad.created_at), '[]'::jsonb) AS audio_asset_ads
              FROM app.ads AS ad JOIN app.stations AS station ON station.id = ad.station_id
             WHERE ad.audio_asset_id = finding.audio_asset_id) AS app_ads
          CROSS JOIN LATERAL (
            SELECT coalesce(jsonb_agg(jsonb_build_object('ad_id', ad.id, 'ad_title', ad.title, 'station_id', station.id,
                                                         'station_name', station.name) ORDER BY ad.created_at), '[]'::jsonb) AS audio_asset_ads
              FROM app.ads AS ad JOIN app.stations AS station ON station.id = ad.station_id
             WHERE ad.audio_asset_id = finding.overlapping_audio_asset_id) AS overlapping_ads
         WHERE ${IS_SUPER_ADMIN_CONDITION}
         ORDER BY finding.reviewed_at IS NOT NULL, finding.found_at
      $$`;

/** Marks a finding checked, with the super admin as actor. */
const RECORD_ASSET_OVERLAP_REVIEW = `
      CREATE FUNCTION app.record_asset_overlap_review(target_finding_id uuid, new_review_note text, request_id text) RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        finding fingerprints.asset_overlaps%ROWTYPE;
      BEGIN
        IF NOT ${IS_SUPER_ADMIN_CONDITION} THEN
          RETURN 'NOT_ALLOWED';
        END IF;
        SELECT * INTO finding FROM fingerprints.asset_overlaps AS candidate WHERE candidate.id = target_finding_id FOR UPDATE;
        IF NOT FOUND THEN
          RETURN 'NOT_FOUND';
        END IF;
        IF finding.reviewed_at IS NOT NULL THEN
          RETURN 'ALREADY_REVIEWED';
        END IF;
        UPDATE fingerprints.asset_overlaps
           SET reviewed_at = now(), reviewed_by_portal_user_id = app.current_user_id(), review_note = new_review_note
         WHERE id = target_finding_id;
        INSERT INTO app.audit_events (actor_portal_user_id, action, entity_type, entity_id, request_id)
        VALUES (app.current_user_id(), 'asset_overlap_reviewed', 'asset_overlap', target_finding_id, request_id);
        RETURN 'REVIEWED';
      END $$`;
