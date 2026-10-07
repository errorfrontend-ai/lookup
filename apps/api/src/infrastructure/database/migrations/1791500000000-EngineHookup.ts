import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Step 3 (docs/design/step-3-engine-hookup.md): the ingest worker's one way to change an ad, and the
 * recognition functions the API uses for listeners' clips.
 *
 * Every function is SECURITY DEFINER with search_path pinned (pg_catalog first, pg_temp last) and is
 * executable only by the role that calls it: the worker gets `fingerprints.record_ad_ingest_result`
 * and nothing in `app`; the API gets the `recognition` functions and the ingest sweep, and still has
 * no privilege on any table in `fingerprints`. The functions read across stations only to return
 * what a listener may see.
 */
export class EngineHookup1791500000000 implements MigrationInterface {
  name = 'EngineHookup1791500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);

    // ---- columns ------------------------------------------------------------------------------------
    // An asset row exists only for audio that was fingerprinted; a refused file leaves none (its reason
    // is on the ad). NEEDS_REVIEW is for partial overlaps, found from phase 8.
    await run(`
      ALTER TABLE fingerprints.audio_assets
        ADD COLUMN fingerprint_status text NOT NULL DEFAULT 'READY',
        ADD CONSTRAINT audio_assets_fingerprint_status_check CHECK (fingerprint_status IN ('READY', 'NEEDS_REVIEW'))`);
    // A soft signal only (O10): no verdict changes nothing.
    await run(`
      ALTER TABLE app.listener_installs
        ADD COLUMN integrity_verdict text,
        ADD CONSTRAINT listener_installs_integrity_verdict_check
          CHECK (integrity_verdict IN ('MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY', 'FAILED')),
        ADD CONSTRAINT listener_installs_app_version_check CHECK (char_length(app_version) BETWEEN 1 AND 32)`);
    // A station's name and frequency go to listeners in every match: the same limits as the response contract.
    await run(`
      ALTER TABLE app.stations
        ADD CONSTRAINT stations_name_check CHECK (char_length(name) BETWEEN 1 AND 120),
        ADD CONSTRAINT stations_frequency_label_check CHECK (char_length(frequency_label) BETWEEN 1 AND 32)`);
    // The phone's own capture time and how far its clock was off; when the latest attempt claimed it.
    await run(`
      ALTER TABLE app.recognition_events
        ADD COLUMN client_captured_at timestamptz,
        ADD COLUMN clock_skew_milliseconds integer,
        ADD COLUMN last_claimed_at timestamptz`);
    // The uploaded audio's checksum is recorded only by the ingest worker's function (below); the API
    // never writes it, so it loses the right to, and cannot overwrite what the worker recorded.
    await run(`REVOKE UPDATE (upload_content_sha256) ON app.ads FROM lookup_api`);

    // ---- the ingest worker's one function -----------------------------------------------------------
    await run(`
      CREATE FUNCTION fingerprints.record_ad_ingest_result(ingested_ad_id uuid, ingested_audio_asset_id uuid,
                                                           uploaded_content_sha256 bytea, refusal_reason text, request_id text)
        RETURNS boolean
        LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, fingerprints, app, pg_temp
      AS $$
      DECLARE
        ingested_ad_station_id uuid;
        asset_duration_milliseconds integer;
      BEGIN
        IF (ingested_audio_asset_id IS NULL) = (refusal_reason IS NULL) THEN
          RAISE EXCEPTION 'give exactly one of an audio asset and a refusal reason' USING ERRCODE = '22023';
        END IF;
        IF refusal_reason IS NOT NULL AND refusal_reason NOT IN
            ('audio_too_short', 'audio_too_long', 'no_audio_in_file', 'audio_unreadable', 'audio_took_too_long_to_read') THEN
          RAISE EXCEPTION 'unknown refusal reason' USING ERRCODE = '22023';
        END IF;

        -- Only an ad still waiting for its audio changes: a repeated job, or an ad that was archived or
        -- given a new file meanwhile, is left alone.
        SELECT station_id INTO ingested_ad_station_id
          FROM app.ads WHERE id = ingested_ad_id AND status = 'PROCESSING' AND archived_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN
          RETURN false;
        END IF;

        IF ingested_audio_asset_id IS NOT NULL THEN
          SELECT duration_milliseconds INTO asset_duration_milliseconds
            FROM fingerprints.audio_assets WHERE id = ingested_audio_asset_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'unknown audio asset' USING ERRCODE = '23503';
          END IF;
          UPDATE app.ads
             SET status = 'READY', audio_asset_id = ingested_audio_asset_id, duration_milliseconds = asset_duration_milliseconds,
                 upload_content_sha256 = uploaded_content_sha256, processing_error_code = NULL
           WHERE id = ingested_ad_id;
          INSERT INTO app.audit_events (station_id, action, entity_type, entity_id, changes, request_id)
            VALUES (ingested_ad_station_id, 'ad_audio_ready', 'ad', ingested_ad_id,
                    jsonb_build_object('durationMilliseconds', asset_duration_milliseconds), record_ad_ingest_result.request_id);
        ELSE
          UPDATE app.ads
             SET status = 'FAILED', processing_error_code = refusal_reason, upload_content_sha256 = uploaded_content_sha256
           WHERE id = ingested_ad_id;
          INSERT INTO app.audit_events (station_id, action, entity_type, entity_id, changes, request_id)
            VALUES (ingested_ad_station_id, 'ad_upload_refused', 'ad', ingested_ad_id,
                    jsonb_build_object('reason', refusal_reason), record_ad_ingest_result.request_id);
        END IF;
        RETURN true;
      END
      $$`);

    // ---- the API's ingest sweep ---------------------------------------------------------------------
    // Ads that have waited for their fingerprints longer than `waited` (Step 2 left some, and a job can
    // be lost while Valkey is down). Only the ad id and the uploaded file's key leave the function.
    await run(`
      CREATE FUNCTION app.find_ads_waiting_for_ingest(waited interval, maximum_count integer)
        RETURNS TABLE (ad_id uuid, upload_object_key text)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
        SELECT ad.id, ad.upload_object_key
          FROM app.ads AS ad
         WHERE ad.status = 'PROCESSING' AND ad.archived_at IS NULL AND ad.upload_object_key IS NOT NULL
           AND ad.uploaded_at < now() - waited
         ORDER BY ad.uploaded_at
         LIMIT least(greatest(maximum_count, 0), 500)
      $$`);

    // ---- recognition --------------------------------------------------------------------------------
    // Claims an idempotency key for one install. A new key makes a PENDING recognition. A key seen before
    // answers with what happened to it: FINISHED (replay the stored result), IN_PROGRESS (an attempt
    // claimed it under 30 seconds ago), or RECLAIMED (the last attempt timed out, was refused as busy,
    // failed, or was abandoned), which starts a new attempt on the same recognition and keeps its first
    // receipt time.
    await run(`
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
      $$`);

    // Ends an attempt: its outcome, what matched and where it resolved. Only the attempt that is still
    // PENDING changes, so a late call from an earlier attempt (overtaken by a retry) or a repeated call
    // cannot overwrite it. The station, campaign and card must belong together.
    await run(`
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
      $$`);

    // Every station that could own a matched recording: ACTIVE stations with an ACTIVE campaign on a
    // non-archived ad that uses the asset, with only what a listener may see, plus whether the capture
    // moment falls in the campaign's period ([start, end)) and in one of its windows, in the station's
    // own time zone. Engagement limits, counters and anything else internal never leave.
    await run(`
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
      $$`);

    // What a finished recognition showed, for replaying it to the install that made it. The card is the
    // version shown then (card versions never change).
    await run(`
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
      $$`);

    // ---- privileges ---------------------------------------------------------------------------------
    const apiFunctions = [
      'app.find_ads_waiting_for_ingest(interval, integer)',
      'recognition.claim_recognition(uuid, uuid, uuid, text, timestamptz, timestamptz, integer, timestamptz, boolean, integer)',
      'recognition.finish_recognition(uuid, timestamptz, integer, text, text, integer, uuid, uuid, uuid, integer, real, integer, integer, smallint)',
      'recognition.find_stations_for_audio(integer, timestamptz)',
      'recognition.describe_recognition(uuid, timestamptz, uuid)',
    ];
    const workerFunction = 'fingerprints.record_ad_ingest_result(uuid, uuid, bytea, text, text)';
    for (const signature of [...apiFunctions, workerFunction]) {
      await run(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
    }
    await run(`GRANT USAGE ON SCHEMA recognition TO lookup_api`);
    await run(`GRANT EXECUTE ON FUNCTION ${apiFunctions.join(', ')} TO lookup_api`);
    await run(`GRANT EXECUTE ON FUNCTION ${workerFunction} TO lookup_fingerprint_worker`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);
    await run(`REVOKE USAGE ON SCHEMA recognition FROM lookup_api`);
    await run(`GRANT UPDATE (upload_content_sha256) ON app.ads TO lookup_api`);
    await run(`DROP FUNCTION recognition.describe_recognition(uuid, timestamptz, uuid)`);
    await run(`DROP FUNCTION recognition.find_stations_for_audio(integer, timestamptz)`);
    await run(`DROP FUNCTION recognition.finish_recognition(uuid, timestamptz, integer, text, text, integer, uuid, uuid, uuid, integer, real, integer, integer, smallint)`);
    await run(`DROP FUNCTION recognition.claim_recognition(uuid, uuid, uuid, text, timestamptz, timestamptz, integer, timestamptz, boolean, integer)`);
    await run(`DROP FUNCTION app.find_ads_waiting_for_ingest(interval, integer)`);
    await run(`DROP FUNCTION fingerprints.record_ad_ingest_result(uuid, uuid, bytea, text, text)`);
    await run(`ALTER TABLE app.recognition_events DROP COLUMN last_claimed_at, DROP COLUMN clock_skew_milliseconds, DROP COLUMN client_captured_at`);
    await run(`ALTER TABLE app.stations DROP CONSTRAINT stations_frequency_label_check, DROP CONSTRAINT stations_name_check`);
    await run(`ALTER TABLE app.listener_installs DROP CONSTRAINT listener_installs_app_version_check, DROP COLUMN integrity_verdict`);
    await run(`ALTER TABLE fingerprints.audio_assets DROP COLUMN fingerprint_status`);
  }
}
