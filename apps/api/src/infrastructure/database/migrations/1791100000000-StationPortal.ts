import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Step 2 — sign-in, sessions and ad uploads for the station portal.
 *
 * Passwords are verified INSIDE the database: the API asks find_password_hash_settings for the hash's
 * algorithm, parameters and salt (never the hash itself), computes argon2id, and passes the result to
 * sign_in_portal_user, which compares, counts failures and opens the session. The API role can no
 * longer write password hashes, and no function opens a session without proof of the password.
 *
 * Sessions: one portal_sessions row per sign-in (the refresh-token family). Refresh tokens rotate on
 * every use; presenting a used token again revokes the whole session, except within a 30-second grace
 * period that covers a response lost on a weak connection or two tabs refreshing at once.
 *
 * Every function here is SECURITY DEFINER with `search_path = pg_catalog, app, pg_temp`: the app
 * schema must be on the path for citext's `=` operator (otherwise email lookups silently become
 * case-sensitive), and pg_temp is listed last so a temporary object can never shadow ours.
 * Failed sign-ins never RAISE, because that would roll back the failure counter.
 */
export class StationPortal1791100000000 implements MigrationInterface {
  name = 'StationPortal1791100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);

    // ---- fix from Step 1: pg_temp listed last explicitly ---------------------------------------
    await run(`ALTER FUNCTION app.create_recognition_event_partitions(integer) SET search_path = pg_catalog, pg_temp`);

    // ---- portal users: the API can no longer write password hashes --------------------------------
    await run(`REVOKE UPDATE (password_hash) ON app.portal_users FROM lookup_api`);
    await run(`
      ALTER TABLE app.portal_users
        ADD COLUMN consecutive_failed_sign_in_count integer NOT NULL DEFAULT 0,
        ADD COLUMN last_failed_sign_in_at timestamptz,
        ADD COLUMN password_changed_at timestamptz,
        ADD CONSTRAINT portal_users_password_hash_check CHECK (password_hash ~ '^\\$argon2id\\$v=19\\$m=[0-9]+,t=[0-9]+,p=[0-9]+\\$[A-Za-z0-9+/]+\\$[A-Za-z0-9+/]+$'),
        ADD CONSTRAINT portal_users_full_name_check CHECK (char_length(full_name) BETWEEN 1 AND 120)`);

    // ---- sessions --------------------------------------------------------------------------------
    await run(`
      CREATE TABLE app.portal_sessions (
        id                 uuid NOT NULL DEFAULT gen_random_uuid(),
        portal_user_id     uuid NOT NULL,
        started_at         timestamptz NOT NULL DEFAULT now(),
        expires_at         timestamptz NOT NULL,
        last_refreshed_at  timestamptz,
        revoked_at         timestamptz,
        revocation_reason  text,
        sign_in_request_id text,
        CONSTRAINT portal_sessions_primary_key PRIMARY KEY (id),
        CONSTRAINT portal_sessions_portal_user_foreign_key
          FOREIGN KEY (portal_user_id) REFERENCES app.portal_users (id) ON DELETE CASCADE,
        CONSTRAINT portal_sessions_revocation_reason_check CHECK (revocation_reason IN
          ('SIGNED_OUT', 'REFRESH_TOKEN_REUSED', 'PASSWORD_CHANGED', 'ACCOUNT_DISABLED', 'SESSION_LIMIT_REACHED')),
        CONSTRAINT portal_sessions_revocation_consistency_check CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL))
      )`);
    await run(`CREATE INDEX portal_sessions_portal_user_index ON app.portal_sessions (portal_user_id)`);
    await run(`ALTER TABLE app.portal_sessions ENABLE ROW LEVEL SECURITY`);

    await run(`ALTER TABLE app.refresh_tokens RENAME COLUMN token_family_id TO portal_session_id`);
    await run(`ALTER INDEX app.refresh_tokens_token_family_index RENAME TO refresh_tokens_portal_session_index`);
    await run(`
      ALTER TABLE app.refresh_tokens
        ADD COLUMN used_at timestamptz,
        ADD COLUMN successor_count smallint NOT NULL DEFAULT 0,
        ADD CONSTRAINT refresh_tokens_portal_session_foreign_key
          FOREIGN KEY (portal_session_id) REFERENCES app.portal_sessions (id) ON DELETE CASCADE,
        ADD CONSTRAINT refresh_tokens_token_hash_length_check CHECK (octet_length(token_hash) = 32)`);

    // ---- sign-in functions -------------------------------------------------------------------------
    await run(`
      CREATE FUNCTION app.find_password_hash_settings(submitted_email text) RETURNS text
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
        -- Everything up to and including the last '$': algorithm, version, parameters and salt.
        SELECT substring(password_hash FROM '^(.*\\$)[^$]+$')
          FROM app.portal_users
         WHERE email = submitted_email::app.citext AND status = 'ACTIVE'
      $$`);

    // Shared by sign-in and password change: is this account currently held back by the backstop?
    await run(`
      CREATE FUNCTION app.is_sign_in_backstop_active(failed_count integer, last_failed_at timestamptz) RETURNS boolean
        LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
      AS $$ SELECT failed_count >= 20 AND last_failed_at > now() - interval '60 seconds' $$`);

    await run(`
      CREATE FUNCTION app.issue_portal_session(session_owner_id uuid, new_refresh_token_hash bytea, request_id text,
                                               OUT new_portal_session_id uuid, OUT new_refresh_token_expires_at timestamptz)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        session_expires_at timestamptz := now() + interval '30 days';
        sessions_over_limit integer;
      BEGIN
        -- At most 10 live sessions per user: the oldest beyond the newest 9 make room for this one.
        WITH sessions_to_revoke AS (
          SELECT id FROM app.portal_sessions
           WHERE portal_user_id = session_owner_id AND revoked_at IS NULL AND expires_at > now()
           ORDER BY started_at DESC OFFSET 9
        )
        UPDATE app.portal_sessions SET revoked_at = now(), revocation_reason = 'SESSION_LIMIT_REACHED'
         WHERE id IN (SELECT id FROM sessions_to_revoke);
        GET DIAGNOSTICS sessions_over_limit = ROW_COUNT;
        IF sessions_over_limit > 0 THEN
          INSERT INTO app.audit_events (actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
          VALUES (session_owner_id, 'sessions_revoked_by_limit', 'portal_user', session_owner_id,
                  jsonb_build_object('revoked_session_count', sessions_over_limit), request_id);
        END IF;

        INSERT INTO app.portal_sessions (portal_user_id, expires_at, sign_in_request_id)
        VALUES (session_owner_id, session_expires_at, request_id)
        RETURNING id INTO new_portal_session_id;
        new_refresh_token_expires_at := least(now() + interval '7 days', session_expires_at);
        INSERT INTO app.refresh_tokens (portal_user_id, portal_session_id, token_hash, expires_at)
        VALUES (session_owner_id, new_portal_session_id, new_refresh_token_hash, new_refresh_token_expires_at);
      END $$`);

    await run(`
      CREATE FUNCTION app.sign_in_portal_user(submitted_email text, computed_password_hash text,
                                              new_refresh_token_hash bytea, replacement_password_hash text, request_id text)
        RETURNS TABLE (outcome text, portal_user_id uuid, portal_session_id uuid, refresh_token_expires_at timestamptz)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      #variable_conflict use_column
      DECLARE
        matched_user app.portal_users%ROWTYPE;
        issued record;
      BEGIN
        SELECT * INTO matched_user FROM app.portal_users WHERE email = submitted_email::app.citext FOR UPDATE;
        IF NOT FOUND OR matched_user.status <> 'ACTIVE' THEN
          RETURN QUERY SELECT 'INVALID_CREDENTIALS'::text, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        -- Backstop that holds even if the rate-limit store or the API itself is compromised.
        IF app.is_sign_in_backstop_active(matched_user.consecutive_failed_sign_in_count, matched_user.last_failed_sign_in_at) THEN
          RETURN QUERY SELECT 'THROTTLED'::text, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        -- Comparing digests of both strings keeps the comparison time independent of where they differ.
        IF sha256(convert_to(matched_user.password_hash, 'UTF8')) <> sha256(convert_to(coalesce(computed_password_hash, ''), 'UTF8')) THEN
          UPDATE app.portal_users
             SET consecutive_failed_sign_in_count = consecutive_failed_sign_in_count + 1, last_failed_sign_in_at = now()
           WHERE id = matched_user.id;
          INSERT INTO app.audit_events (actor_portal_user_id, action, entity_type, entity_id, request_id)
          VALUES (matched_user.id, 'sign_in_failed', 'portal_user', matched_user.id, request_id);
          RETURN QUERY SELECT 'INVALID_CREDENTIALS'::text, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;

        UPDATE app.portal_users
           SET consecutive_failed_sign_in_count = 0, last_failed_sign_in_at = NULL,
               password_hash = coalesce(replacement_password_hash, password_hash)
         WHERE id = matched_user.id;
        SELECT * INTO issued FROM app.issue_portal_session(matched_user.id, new_refresh_token_hash, request_id);
        INSERT INTO app.audit_events (actor_portal_user_id, action, entity_type, entity_id, request_id)
        VALUES (matched_user.id, 'signed_in', 'portal_session', issued.new_portal_session_id, request_id);
        RETURN QUERY SELECT 'SIGNED_IN'::text, matched_user.id, issued.new_portal_session_id, issued.new_refresh_token_expires_at;
      END $$`);

    await run(`
      CREATE FUNCTION app.rotate_portal_refresh_token(presented_token_hash bytea, new_refresh_token_hash bytea, request_id text)
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
        UPDATE app.portal_sessions SET last_refreshed_at = now() WHERE id = owning_session.id;
        RETURN QUERY SELECT 'ROTATED'::text, presented_token.portal_user_id, owning_session.id, new_expires_at;
      END $$`);

    await run(`
      CREATE FUNCTION app.end_portal_session(known_portal_session_id uuid, presented_token_hash bytea, request_id text) RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      DECLARE
        session_to_end uuid := known_portal_session_id;
        ended_session_owner uuid;
      BEGIN
        IF session_to_end IS NULL AND presented_token_hash IS NOT NULL THEN
          SELECT tokens.portal_session_id INTO session_to_end FROM app.refresh_tokens AS tokens WHERE tokens.token_hash = presented_token_hash;
        END IF;
        IF session_to_end IS NULL THEN RETURN; END IF;
        UPDATE app.portal_sessions SET revoked_at = now(), revocation_reason = 'SIGNED_OUT'
         WHERE id = session_to_end AND revoked_at IS NULL
        RETURNING portal_user_id INTO ended_session_owner;
        IF ended_session_owner IS NOT NULL THEN
          UPDATE app.refresh_tokens SET revoked_at = now() WHERE portal_session_id = session_to_end AND revoked_at IS NULL;
          INSERT INTO app.audit_events (actor_portal_user_id, action, entity_type, entity_id, request_id)
          VALUES (ended_session_owner, 'signed_out', 'portal_session', session_to_end, request_id);
        END IF;
      END $$`);

    await run(`
      CREATE FUNCTION app.find_active_portal_session(portal_session_id uuid) RETURNS uuid
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
        SELECT sessions.portal_user_id
          FROM app.portal_sessions AS sessions
          JOIN app.portal_users AS users ON users.id = sessions.portal_user_id
         WHERE sessions.id = find_active_portal_session.portal_session_id
           AND sessions.revoked_at IS NULL AND sessions.expires_at > now() AND users.status = 'ACTIVE'
      $$`);

    await run(`
      CREATE FUNCTION app.change_portal_user_password(current_portal_session_id uuid, computed_current_password_hash text,
                                                      new_password_hash text, new_refresh_token_hash bytea, request_id text)
        RETURNS TABLE (outcome text, portal_user_id uuid, portal_session_id uuid, refresh_token_expires_at timestamptz)
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
      #variable_conflict use_column
      DECLARE
        session_owner_id uuid := app.find_active_portal_session(current_portal_session_id);
        matched_user app.portal_users%ROWTYPE;
        issued record;
      BEGIN
        IF session_owner_id IS NULL THEN
          RETURN QUERY SELECT 'INVALID_SESSION'::text, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        SELECT * INTO matched_user FROM app.portal_users WHERE id = session_owner_id FOR UPDATE;
        IF app.is_sign_in_backstop_active(matched_user.consecutive_failed_sign_in_count, matched_user.last_failed_sign_in_at) THEN
          RETURN QUERY SELECT 'THROTTLED'::text, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        IF sha256(convert_to(matched_user.password_hash, 'UTF8')) <> sha256(convert_to(coalesce(computed_current_password_hash, ''), 'UTF8')) THEN
          UPDATE app.portal_users
             SET consecutive_failed_sign_in_count = consecutive_failed_sign_in_count + 1, last_failed_sign_in_at = now()
           WHERE id = matched_user.id;
          INSERT INTO app.audit_events (actor_portal_user_id, action, entity_type, entity_id, request_id)
          VALUES (matched_user.id, 'password_change_failed', 'portal_user', matched_user.id, request_id);
          RETURN QUERY SELECT 'INVALID_CREDENTIALS'::text, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;

        UPDATE app.portal_users
           SET password_hash = new_password_hash, password_changed_at = now(),
               consecutive_failed_sign_in_count = 0, last_failed_sign_in_at = NULL
         WHERE id = matched_user.id;
        -- Every session ends, including the one that asked, which is replaced by a fresh session.
        UPDATE app.portal_sessions AS sessions SET revoked_at = now(), revocation_reason = 'PASSWORD_CHANGED'
         WHERE sessions.portal_user_id = matched_user.id AND sessions.revoked_at IS NULL;
        UPDATE app.refresh_tokens AS tokens SET revoked_at = now()
         WHERE tokens.portal_user_id = matched_user.id AND tokens.revoked_at IS NULL;
        SELECT * INTO issued FROM app.issue_portal_session(matched_user.id, new_refresh_token_hash, request_id);
        INSERT INTO app.audit_events (actor_portal_user_id, action, entity_type, entity_id, request_id)
        VALUES (matched_user.id, 'password_changed', 'portal_user', matched_user.id, request_id);
        RETURN QUERY SELECT 'PASSWORD_CHANGED'::text, matched_user.id, issued.new_portal_session_id, issued.new_refresh_token_expires_at;
      END $$`);

    await run(`
      CREATE FUNCTION app.delete_expired_portal_sessions() RETURNS integer
        LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
        WITH deleted_sessions AS (
          DELETE FROM app.portal_sessions
           WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'
          RETURNING 1
        )
        SELECT count(*)::integer FROM deleted_sessions
      $$`);

    const authenticationFunctions = [
      'app.find_password_hash_settings(text)',
      'app.sign_in_portal_user(text, text, bytea, text, text)',
      'app.rotate_portal_refresh_token(bytea, bytea, text)',
      'app.end_portal_session(uuid, bytea, text)',
      'app.find_active_portal_session(uuid)',
      'app.change_portal_user_password(uuid, text, text, bytea, text)',
      'app.delete_expired_portal_sessions()',
    ];
    for (const signature of [...authenticationFunctions, 'app.issue_portal_session(uuid, bytea, text)', 'app.is_sign_in_backstop_active(integer, timestamptz)']) {
      await run(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
    }
    // issue_portal_session and is_sign_in_backstop_active are internal helpers: nobody but the owner calls them.
    await run(`GRANT EXECUTE ON FUNCTION ${authenticationFunctions.join(', ')} TO lookup_api`);

    // ---- ads: upload details -----------------------------------------------------------------------
    await run(`
      ALTER TABLE app.ads
        ADD COLUMN upload_content_type text,
        ADD COLUMN upload_size_bytes integer,
        ADD COLUMN upload_original_file_name text,
        ADD COLUMN upload_expires_at timestamptz,
        ADD COLUMN upload_entity_tag text,
        ADD COLUMN uploaded_at timestamptz,
        ADD CONSTRAINT ads_upload_content_type_check CHECK (upload_content_type IN ('audio/mpeg', 'audio/wav', 'audio/mp4')),
        ADD CONSTRAINT ads_upload_size_check CHECK (upload_size_bytes BETWEEN 1 AND 20971520),
        ADD CONSTRAINT ads_upload_original_file_name_check CHECK (char_length(upload_original_file_name) BETWEEN 1 AND 255),
        ADD CONSTRAINT ads_title_check CHECK (char_length(title) BETWEEN 1 AND 120)`);
    await run(`ALTER TABLE app.clients ADD CONSTRAINT clients_name_check CHECK (char_length(name) BETWEEN 1 AND 80)`);
    await run(`ALTER TABLE app.campaigns ADD CONSTRAINT campaigns_name_check CHECK (char_length(name) BETWEEN 1 AND 120)`);
    await run(`
      GRANT INSERT (upload_content_type, upload_size_bytes, upload_original_file_name, upload_expires_at)
        ON app.ads TO lookup_api`);
    await run(`
      GRANT UPDATE (upload_content_type, upload_size_bytes, upload_original_file_name, upload_expires_at,
                    upload_entity_tag, uploaded_at)
        ON app.ads TO lookup_api`);

    // The API may only move an ad through the upload states; READY and NEEDS_REVIEW come from the
    // ingest worker's function (Step 3), which runs as the schema owner and is not limited here.
    await run(`
      CREATE FUNCTION app.guard_ad_status_transition() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
      AS $$
      BEGIN
        IF NEW.status IS DISTINCT FROM OLD.status AND current_user = 'lookup_api'
           AND NOT ((OLD.status = 'AWAITING_UPLOAD' AND NEW.status IN ('PROCESSING', 'FAILED'))
                    OR (OLD.status = 'FAILED' AND NEW.status = 'AWAITING_UPLOAD')) THEN
          RAISE EXCEPTION 'ad status cannot change from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$`);
    await run(`
      CREATE TRIGGER ads_guard_status_transition BEFORE UPDATE OF status ON app.ads
        FOR EACH ROW EXECUTE FUNCTION app.guard_ad_status_transition()`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);
    await run(`DROP TRIGGER IF EXISTS ads_guard_status_transition ON app.ads`);
    await run(`DROP FUNCTION IF EXISTS app.guard_ad_status_transition()`);
    await run(`ALTER TABLE app.campaigns DROP CONSTRAINT IF EXISTS campaigns_name_check`);
    await run(`ALTER TABLE app.clients DROP CONSTRAINT IF EXISTS clients_name_check`);
    await run(`
      ALTER TABLE app.ads
        DROP COLUMN IF EXISTS upload_content_type, DROP COLUMN IF EXISTS upload_size_bytes,
        DROP COLUMN IF EXISTS upload_original_file_name, DROP COLUMN IF EXISTS upload_expires_at,
        DROP COLUMN IF EXISTS upload_entity_tag, DROP COLUMN IF EXISTS uploaded_at,
        DROP CONSTRAINT IF EXISTS ads_title_check`);
    for (const signature of [
      'app.delete_expired_portal_sessions()',
      'app.change_portal_user_password(uuid, text, text, bytea, text)',
      'app.find_active_portal_session(uuid)',
      'app.end_portal_session(uuid, bytea, text)',
      'app.rotate_portal_refresh_token(bytea, bytea, text)',
      'app.sign_in_portal_user(text, text, bytea, text, text)',
      'app.issue_portal_session(uuid, bytea, text)',
      'app.is_sign_in_backstop_active(integer, timestamptz)',
      'app.find_password_hash_settings(text)',
    ]) {
      await run(`DROP FUNCTION IF EXISTS ${signature}`);
    }
    await run(`
      ALTER TABLE app.refresh_tokens
        DROP CONSTRAINT IF EXISTS refresh_tokens_token_hash_length_check,
        DROP CONSTRAINT IF EXISTS refresh_tokens_portal_session_foreign_key,
        DROP COLUMN IF EXISTS successor_count, DROP COLUMN IF EXISTS used_at`);
    await run(`ALTER INDEX app.refresh_tokens_portal_session_index RENAME TO refresh_tokens_token_family_index`);
    await run(`ALTER TABLE app.refresh_tokens RENAME COLUMN portal_session_id TO token_family_id`);
    await run(`DROP TABLE IF EXISTS app.portal_sessions`);
    await run(`
      ALTER TABLE app.portal_users
        DROP CONSTRAINT IF EXISTS portal_users_full_name_check, DROP CONSTRAINT IF EXISTS portal_users_password_hash_check,
        DROP COLUMN IF EXISTS password_changed_at, DROP COLUMN IF EXISTS last_failed_sign_in_at,
        DROP COLUMN IF EXISTS consecutive_failed_sign_in_count`);
    await run(`GRANT UPDATE (password_hash) ON app.portal_users TO lookup_api`);
    await run(`ALTER FUNCTION app.create_recognition_event_partitions(integer) SET search_path = pg_catalog`);
  }
}
