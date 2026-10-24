import type { MigrationInterface, QueryRunner } from 'typeorm';
import { ListenerAudienceMix1791900100000 } from './1791900100000-ListenerAudienceMix.js';

/**
 * Client accounts (ADR-006, docs/design/step-5c-client-accounts.md): the business that pays for an advert follows it.
 *
 *  - app.client_viewers: "this person follows client C at station S", granted only by the station's email invitation
 *    (app.invitations, kind CLIENT_VIEWER, built in 5a). Row-level security on, no policy, no grant.
 *  - Client reads are SECURITY DEFINER functions, search path pinned, EXECUTE for lookup_api only. Each checks a
 *    client_viewers row for app.current_user_id() at an ACTIVE station, and returns only what a client may see: never
 *    another client, a listener, a station's engagement limit or notes, or an audio asset id (ADR-006 decision 3; this
 *    replaces the plan's row-level-security policies for client viewers).
 *  - The station side: invite (owner or manager), send again, cancel, remove, and the list of people and invitations.
 *    The 5a functions for station members are left as they are; client invitations have their own.
 *  - The listener-mix query becomes one internal function with an explicit station, so the station's two functions and
 *    the client's one share it.
 *  - Notification settings, muted adverts, Web Push devices (endpoints and keys are secrets: no grant, never returned
 *    except to the sender) and the air-time reminders sent (one per person, time window and slot start).
 *
 * Scaling: client_viewers, settings and devices are one row per person and station or device; reminders are one row per
 * person and slot, deleted after 30 days by the reminder job. Every foreign key is indexed.
 */
export class ClientAccounts1792000000000 implements MigrationInterface {
  name = 'ClientAccounts1792000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);

    await run(`
      CREATE TABLE app.client_viewers (
        client_id      uuid NOT NULL,
        station_id     uuid NOT NULL,
        portal_user_id uuid NOT NULL,
        invitation_id  uuid,
        created_at     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT client_viewers_primary_key PRIMARY KEY (client_id, station_id, portal_user_id),
        CONSTRAINT client_viewers_client_foreign_key
          FOREIGN KEY (client_id, station_id) REFERENCES app.clients (id, station_id) ON DELETE CASCADE,
        CONSTRAINT client_viewers_portal_user_foreign_key
          FOREIGN KEY (portal_user_id) REFERENCES app.portal_users (id) ON DELETE CASCADE,
        CONSTRAINT client_viewers_invitation_foreign_key
          FOREIGN KEY (invitation_id) REFERENCES app.invitations (id) ON DELETE SET NULL
      )`);
    await run(`CREATE INDEX client_viewers_portal_user_index ON app.client_viewers (portal_user_id)`);
    await run(`CREATE INDEX client_viewers_invitation_index ON app.client_viewers (invitation_id)`);
    await run(`ALTER TABLE app.client_viewers ENABLE ROW LEVEL SECURITY`);

    await run(`
      CREATE TABLE app.client_viewer_notification_settings (
        portal_user_id uuid NOT NULL,
        is_push_on     boolean NOT NULL DEFAULT true,
        is_email_on    boolean NOT NULL DEFAULT false,
        lead_minutes   smallint NOT NULL DEFAULT 15,
        updated_at     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT client_viewer_notification_settings_primary_key PRIMARY KEY (portal_user_id),
        CONSTRAINT client_viewer_notification_settings_portal_user_foreign_key
          FOREIGN KEY (portal_user_id) REFERENCES app.portal_users (id) ON DELETE CASCADE,
        CONSTRAINT client_viewer_notification_settings_lead_minutes_check CHECK (lead_minutes IN (5, 15, 30))
      )`);
    await run(`ALTER TABLE app.client_viewer_notification_settings ENABLE ROW LEVEL SECURITY`);

    await run(`
      CREATE TABLE app.client_viewer_muted_ads (
        portal_user_id uuid NOT NULL,
        station_id     uuid NOT NULL,
        ad_id          uuid NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT client_viewer_muted_ads_primary_key PRIMARY KEY (portal_user_id, ad_id),
        CONSTRAINT client_viewer_muted_ads_portal_user_foreign_key
          FOREIGN KEY (portal_user_id) REFERENCES app.portal_users (id) ON DELETE CASCADE,
        CONSTRAINT client_viewer_muted_ads_ad_foreign_key
          FOREIGN KEY (ad_id, station_id) REFERENCES app.ads (id, station_id) ON DELETE CASCADE
      )`);
    await run(`CREATE INDEX client_viewer_muted_ads_ad_index ON app.client_viewer_muted_ads (ad_id, station_id)`);
    await run(`ALTER TABLE app.client_viewer_muted_ads ENABLE ROW LEVEL SECURITY`);

    await run(`
      CREATE TABLE app.web_push_subscriptions (
        id                    uuid NOT NULL DEFAULT gen_random_uuid(),
        portal_user_id        uuid NOT NULL,
        endpoint              text NOT NULL,
        endpoint_hash         bytea NOT NULL,
        receiver_public_key   text NOT NULL,
        authentication_secret text NOT NULL,
        created_at            timestamptz NOT NULL DEFAULT now(),
        last_sent_at          timestamptz,
        CONSTRAINT web_push_subscriptions_primary_key PRIMARY KEY (id),
        CONSTRAINT web_push_subscriptions_endpoint_hash_unique UNIQUE (endpoint_hash),
        CONSTRAINT web_push_subscriptions_portal_user_foreign_key
          FOREIGN KEY (portal_user_id) REFERENCES app.portal_users (id) ON DELETE CASCADE,
        CONSTRAINT web_push_subscriptions_endpoint_check CHECK (endpoint ~ '^https://[^\\s]+$' AND char_length(endpoint) <= 2048),
        CONSTRAINT web_push_subscriptions_endpoint_hash_length_check CHECK (octet_length(endpoint_hash) = 32),
        CONSTRAINT web_push_subscriptions_receiver_public_key_check CHECK (receiver_public_key ~ '^[A-Za-z0-9_-]{80,100}$'),
        CONSTRAINT web_push_subscriptions_authentication_secret_check CHECK (authentication_secret ~ '^[A-Za-z0-9_-]{16,32}$')
      )`);
    await run(`CREATE INDEX web_push_subscriptions_portal_user_index ON app.web_push_subscriptions (portal_user_id, created_at)`);
    await run(`ALTER TABLE app.web_push_subscriptions ENABLE ROW LEVEL SECURITY`);

    await run(`
      CREATE TABLE app.air_time_reminders (
        portal_user_id          uuid NOT NULL,
        campaign_time_window_id uuid NOT NULL,
        slot_starts_at          timestamptz NOT NULL,
        queued_at               timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT air_time_reminders_primary_key PRIMARY KEY (portal_user_id, campaign_time_window_id, slot_starts_at),
        CONSTRAINT air_time_reminders_portal_user_foreign_key
          FOREIGN KEY (portal_user_id) REFERENCES app.portal_users (id) ON DELETE CASCADE,
        CONSTRAINT air_time_reminders_campaign_time_window_foreign_key
          FOREIGN KEY (campaign_time_window_id) REFERENCES app.campaign_time_windows (id) ON DELETE CASCADE
      )`);
    await run(`CREATE INDEX air_time_reminders_campaign_time_window_index ON app.air_time_reminders (campaign_time_window_id)`);
    await run(`CREATE INDEX air_time_reminders_queued_at_index ON app.air_time_reminders (queued_at)`);
    await run(`ALTER TABLE app.air_time_reminders ENABLE ROW LEVEL SECURITY`);

    for (const definition of DEFINITIONS) await run(definition);

    // The listener mix: one body, with an explicit station; the station's two functions keep their signatures and grants.
    await run(COMPUTE_LISTENER_MIX);
    await run(`
      CREATE OR REPLACE FUNCTION app.read_listener_mix_for_station(reading_range_days integer)
        RETURNS TABLE (first_day text, last_day text, known_listeners integer, not_known_yet_listeners integer, genders jsonb, age_bands jsonb)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$ SELECT * FROM app.compute_listener_mix(app.current_station_id(), NULL, reading_range_days) $$`);
    await run(`
      CREATE OR REPLACE FUNCTION app.read_listener_mix_for_ad(reading_ad_id uuid, reading_range_days integer)
        RETURNS TABLE (first_day text, last_day text, known_listeners integer, not_known_yet_listeners integer, genders jsonb, age_bands jsonb)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$ SELECT * FROM app.compute_listener_mix(app.current_station_id(), reading_ad_id, reading_range_days) $$`);
    await run(READ_LISTENER_MIX_FOR_CLIENT_AD);

    for (const signature of INTERNAL_FUNCTIONS) await run(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
    for (const signature of API_FUNCTIONS) {
      await run(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
      await run(`GRANT EXECUTE ON FUNCTION ${signature} TO lookup_api`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const run = (sql: string) => queryRunner.query(sql);
    for (const signature of API_FUNCTIONS) await run(`DROP FUNCTION ${signature}`);
    // The station's listener-mix functions go back to the bodies of their own migration.
    await run(`DROP FUNCTION app.read_listener_mix_for_station(integer)`);
    await run(`DROP FUNCTION app.read_listener_mix_for_ad(uuid, integer)`);
    await new ListenerAudienceMix1791900100000().up(queryRunner);
    for (const signature of INTERNAL_FUNCTIONS) await run(`DROP FUNCTION ${signature}`);
    for (const table of ['air_time_reminders', 'web_push_subscriptions', 'client_viewer_muted_ads', 'client_viewer_notification_settings', 'client_viewers']) {
      await run(`DROP TABLE app.${table}`);
    }
  }
}

/** Called only from inside the definer functions below: no role may run them directly. */
const INTERNAL_FUNCTIONS = [
  'app.is_current_station_content_editor(uuid)',
  'app.compute_listener_mix(uuid, uuid, integer)',
  'app.list_campaign_slot_starts(uuid, timestamptz, timestamptz)',
  'app.can_current_user_view_ad(uuid, uuid)',
];

const API_FUNCTIONS = [
  // The station's side.
  'app.list_client_viewers(uuid, uuid)',
  'app.count_client_viewers_of_current_station()',
  'app.create_client_viewer_invitation(uuid, uuid, text, bytea, text)',
  'app.resend_client_viewer_invitation(uuid, uuid, uuid, bytea, text)',
  'app.revoke_client_viewer_invitation(uuid, uuid, uuid, text)',
  'app.remove_client_viewer(uuid, uuid, uuid, text)',
  // The invitee's side.
  'app.describe_client_viewer_invitation(bytea)',
  'app.accept_client_viewer_invitation_with_new_account(bytea, text, text, text, bytea, text)',
  'app.accept_client_viewer_invitation_for_signed_in_user(bytea, text)',
  // The client's reads.
  'app.list_client_viewer_accesses()',
  'app.list_client_viewer_ads(uuid)',
  'app.read_client_viewer_ad(uuid, uuid)',
  'app.read_client_viewer_figures(uuid, uuid, integer)',
  'app.list_client_viewer_daily_figures(uuid, integer)',
  'app.list_client_viewer_next_slots(uuid, uuid, integer)',
  'app.read_listener_mix_for_client_ad(uuid, uuid, integer)',
  // The client's own settings and devices.
  'app.read_client_viewer_notification_settings()',
  'app.save_client_viewer_notification_settings(boolean, boolean, smallint, jsonb)',
  'app.save_web_push_subscription(text, bytea, text, text)',
  'app.delete_own_web_push_subscription(bytea)',
  'app.list_own_web_push_subscriptions()',
  // The reminder job and the push sender.
  'app.list_due_air_time_reminders(timestamptz)',
  'app.claim_air_time_reminder(uuid, uuid, timestamptz)',
  'app.delete_old_air_time_reminders(interval)',
  'app.list_web_push_subscriptions_of(uuid)',
  'app.forget_web_push_subscription(bytea)',
  'app.note_web_push_sent(bytea)',
];

const DEFINER = 'SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp';

/**
 * The person's views, as one reusable condition: this person follows the ad's client at the ad's station, the station
 * is ACTIVE and the person's account is ACTIVE.
 */
const VIEWS = (stationColumn: string, clientColumn: string) => `
  EXISTS (SELECT 1 FROM app.client_viewers AS viewer
            JOIN app.stations AS viewed_station ON viewed_station.id = viewer.station_id
            JOIN app.portal_users AS viewing_person ON viewing_person.id = viewer.portal_user_id
           WHERE viewer.portal_user_id = app.current_user_id() AND viewer.station_id = ${stationColumn}
             AND viewer.client_id = ${clientColumn} AND viewed_station.status = 'ACTIVE' AND viewing_person.status = 'ACTIVE')`;

/** The start of the station's day [days] days before today (0 = today), as an instant. */
const STATION_DAYS_STARTED_AT = (timeZone: string, daysBack: string) =>
  `((((now() AT TIME ZONE ${timeZone})::date - ${daysBack})::timestamp) AT TIME ZONE ${timeZone})`;

/** The ad's latest campaign, as the station's own pages read it. */
const LATEST_CAMPAIGN = `
  LEFT JOIN LATERAL (
    SELECT latest.id, latest.status, latest.active_period
      FROM app.campaigns AS latest
     WHERE latest.ad_id = ads.id AND latest.station_id = ads.station_id
     ORDER BY latest.created_at DESC
     LIMIT 1
  ) AS campaign ON true`;

/** An ad's time windows, as the station's pages show them. */
const TIME_WINDOWS_JSON = `
  (SELECT json_agg(json_build_object(
             'daysOfWeek', time_window.days_of_week,
             'localStartTime', to_char(time_window.local_start_time, 'HH24:MI'),
             'localEndTime', to_char(time_window.local_end_time, 'HH24:MI'))
           ORDER BY time_window.local_start_time, time_window.days_of_week)
     FROM app.campaign_time_windows AS time_window WHERE time_window.campaign_id = campaign.id)`;

const DEFINITIONS = [
  `
      CREATE FUNCTION app.is_current_station_content_editor(target_station_id uuid) RETURNS boolean
        LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp
      AS $$
        SELECT coalesce(target_station_id = app.current_station_id(), false) AND EXISTS (
          SELECT 1 FROM app.station_memberships AS membership
            JOIN app.portal_users AS member ON member.id = membership.portal_user_id
           WHERE membership.station_id = target_station_id AND membership.portal_user_id = app.current_user_id()
             AND membership.role IN ('OWNER', 'MANAGER') AND member.status = 'ACTIVE')
      $$`,

  // Whether the signed-in person may view this ad: they follow its client at its station, which is ACTIVE.
  `
      CREATE FUNCTION app.can_current_user_view_ad(target_station_id uuid, target_ad_id uuid) RETURNS boolean
        LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
      AS $$
        SELECT EXISTS (SELECT 1 FROM app.ads
                        WHERE ads.id = target_ad_id AND ads.station_id = target_station_id AND ads.archived_at IS NULL
                          AND ${VIEWS('ads.station_id', 'ads.client_id')})
      $$`,

  // ---- the station's side ------------------------------------------------------------------------------------------
  // The people who follow one client, and the invitations not yet accepted or cancelled (expired ones too), for any
  // member of the station the API is working in.
  `
      CREATE FUNCTION app.list_client_viewers(target_station_id uuid, target_client_id uuid)
        RETURNS TABLE (entry_kind text, portal_user_id uuid, full_name text, email text, invitation_id uuid,
                       invited_at timestamptz, expires_at timestamptz, joined_at timestamptz)
        LANGUAGE sql STABLE ${DEFINER}
      AS $$
        SELECT 'VIEWER', person.id, person.full_name, person.email::text, NULL::uuid, NULL::timestamptz, NULL::timestamptz,
               viewer.created_at
          FROM app.client_viewers AS viewer
          JOIN app.portal_users AS person ON person.id = viewer.portal_user_id
         WHERE viewer.station_id = target_station_id AND viewer.client_id = target_client_id
           AND target_station_id = app.current_station_id()
           AND EXISTS (SELECT 1 FROM app.station_memberships AS membership
                        WHERE membership.station_id = target_station_id AND membership.portal_user_id = app.current_user_id())
        UNION ALL
        SELECT 'INVITATION', NULL::uuid, NULL::text, invitation.invited_email::text, invitation.id, invitation.created_at,
               invitation.expires_at, NULL::timestamptz
          FROM app.invitations AS invitation
         WHERE invitation.station_id = target_station_id AND invitation.client_id = target_client_id
           AND invitation.kind = 'CLIENT_VIEWER' AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL
           AND target_station_id = app.current_station_id()
           AND EXISTS (SELECT 1 FROM app.station_memberships AS membership
                        WHERE membership.station_id = target_station_id AND membership.portal_user_id = app.current_user_id())
         ORDER BY 1 DESC, 3, 4
      $$`,

  // How many people view each client of the station the API is working in, for the Clients page.
  `
      CREATE FUNCTION app.count_client_viewers_of_current_station()
        RETURNS TABLE (client_id uuid, viewer_count integer)
        LANGUAGE sql STABLE ${DEFINER}
      AS $$
        SELECT viewer.client_id, count(*)::integer
          FROM app.client_viewers AS viewer
         WHERE viewer.station_id = app.current_station_id()
           AND EXISTS (SELECT 1 FROM app.station_memberships AS membership
                        WHERE membership.station_id = viewer.station_id AND membership.portal_user_id = app.current_user_id())
         GROUP BY viewer.client_id
      $$`,

  // An OWNER or MANAGER of an active station invites someone to follow one of its clients. An open invitation to the
  // same email for the same client is cancelled first (so the newest link is the only one that works); an email that
  // already follows the client is refused. Seven days, single use.
  `
      CREATE FUNCTION app.create_client_viewer_invitation(target_station_id uuid, target_client_id uuid, new_invited_email text,
                                                          new_token_hash bytea, request_id text)
        RETURNS TABLE (outcome text, invitation_id uuid, invitation_expires_at timestamptz, station_name text,
                       station_frequency_label text, client_name text)
        LANGUAGE plpgsql ${DEFINER}
      AS $$
      DECLARE
        station_row app.stations%ROWTYPE;
        found_client_name text;
        created_invitation_id uuid;
        created_expires_at timestamptz;
      BEGIN
        IF NOT app.is_current_station_content_editor(target_station_id) THEN
          RETURN QUERY SELECT 'NOT_ALLOWED'::text, NULL::uuid, NULL::timestamptz, NULL::text, NULL::text, NULL::text;
          RETURN;
        END IF;
        SELECT * INTO station_row FROM app.stations WHERE id = target_station_id FOR UPDATE;
        IF station_row.status <> 'ACTIVE' THEN
          RETURN QUERY SELECT 'STATION_NOT_ACTIVE'::text, NULL::uuid, NULL::timestamptz, NULL::text, NULL::text, NULL::text;
          RETURN;
        END IF;
        SELECT name INTO found_client_name FROM app.clients WHERE id = target_client_id AND station_id = target_station_id;
        IF NOT FOUND THEN
          RETURN QUERY SELECT 'CLIENT_NOT_FOUND'::text, NULL::uuid, NULL::timestamptz, NULL::text, NULL::text, NULL::text;
          RETURN;
        END IF;
        IF EXISTS (SELECT 1 FROM app.client_viewers AS viewer
                     JOIN app.portal_users AS person ON person.id = viewer.portal_user_id
                    WHERE viewer.station_id = target_station_id AND viewer.client_id = target_client_id
                      AND person.email = new_invited_email::app.citext) THEN
          RETURN QUERY SELECT 'ALREADY_HAS_ACCESS'::text, NULL::uuid, NULL::timestamptz, NULL::text, NULL::text, NULL::text;
          RETURN;
        END IF;
        UPDATE app.invitations SET revoked_at = now()
         WHERE station_id = target_station_id AND kind = 'CLIENT_VIEWER' AND client_id = target_client_id
           AND invited_email = new_invited_email::app.citext AND accepted_at IS NULL AND revoked_at IS NULL;
        INSERT INTO app.invitations (station_id, kind, client_id, invited_email, token_hash, expires_at, invited_by_portal_user_id)
        VALUES (target_station_id, 'CLIENT_VIEWER', target_client_id, new_invited_email::app.citext, new_token_hash,
                now() + interval '7 days', app.current_user_id())
        RETURNING id, expires_at INTO created_invitation_id, created_expires_at;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
        VALUES (target_station_id, app.current_user_id(), 'client_viewer_invitation_created', 'invitation', created_invitation_id,
                jsonb_build_object('client_id', target_client_id), request_id);
        RETURN QUERY SELECT 'CREATED'::text, created_invitation_id, created_expires_at, station_row.name,
                            station_row.frequency_label, found_client_name;
      END $$`,

  // "Send again": the open (or expired) invitation is cancelled and a new one made to the same email for the same client.
  `
      CREATE FUNCTION app.resend_client_viewer_invitation(target_station_id uuid, target_client_id uuid, target_invitation_id uuid,
                                                          new_token_hash bytea, request_id text)
        RETURNS TABLE (outcome text, invitation_id uuid, invitation_expires_at timestamptz, invited_email text, station_name text,
                       station_frequency_label text, client_name text)
        LANGUAGE plpgsql ${DEFINER}
      AS $$
      DECLARE
        old_invitation app.invitations%ROWTYPE;
        created record;
      BEGIN
        IF NOT app.is_current_station_content_editor(target_station_id) THEN
          RETURN QUERY SELECT 'NOT_ALLOWED'::text, NULL::uuid, NULL::timestamptz, NULL::text, NULL::text, NULL::text, NULL::text;
          RETURN;
        END IF;
        SELECT * INTO old_invitation FROM app.invitations
         WHERE id = target_invitation_id AND station_id = target_station_id AND client_id = target_client_id
           AND kind = 'CLIENT_VIEWER' AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN
          RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::uuid, NULL::timestamptz, NULL::text, NULL::text, NULL::text, NULL::text;
          RETURN;
        END IF;
        SELECT * INTO created FROM app.create_client_viewer_invitation(target_station_id, old_invitation.client_id,
                                                                       old_invitation.invited_email::text, new_token_hash, request_id);
        RETURN QUERY SELECT created.outcome, created.invitation_id, created.invitation_expires_at, old_invitation.invited_email::text,
                            created.station_name, created.station_frequency_label, created.client_name;
      END $$`,

  `
      CREATE FUNCTION app.revoke_client_viewer_invitation(target_station_id uuid, target_client_id uuid, target_invitation_id uuid,
                                                          request_id text)
        RETURNS text
        LANGUAGE plpgsql ${DEFINER}
      AS $$
      BEGIN
        IF NOT app.is_current_station_content_editor(target_station_id) THEN
          RETURN 'NOT_ALLOWED';
        END IF;
        UPDATE app.invitations SET revoked_at = now()
         WHERE id = target_invitation_id AND station_id = target_station_id AND client_id = target_client_id
           AND kind = 'CLIENT_VIEWER' AND accepted_at IS NULL AND revoked_at IS NULL;
        IF NOT FOUND THEN
          RETURN 'NOT_FOUND';
        END IF;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
        VALUES (target_station_id, app.current_user_id(), 'client_viewer_invitation_revoked', 'invitation', target_invitation_id,
                jsonb_build_object('client_id', target_client_id), request_id);
        RETURN 'REVOKED';
      END $$`,

  `
      CREATE FUNCTION app.remove_client_viewer(target_station_id uuid, target_client_id uuid, removed_portal_user_id uuid,
                                               request_id text)
        RETURNS text
        LANGUAGE plpgsql ${DEFINER}
      AS $$
      BEGIN
        IF NOT app.is_current_station_content_editor(target_station_id) THEN
          RETURN 'NOT_ALLOWED';
        END IF;
        DELETE FROM app.client_viewers
         WHERE station_id = target_station_id AND client_id = target_client_id AND portal_user_id = removed_portal_user_id;
        IF NOT FOUND THEN
          RETURN 'NOT_FOUND';
        END IF;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
        VALUES (target_station_id, app.current_user_id(), 'client_viewer_removed', 'client', target_client_id,
                jsonb_build_object('portal_user_id', removed_portal_user_id), request_id);
        RETURN 'REMOVED';
      END $$`,

  // ---- the invitee's side ----------------------------------------------------------------------------------------------
  `
      CREATE FUNCTION app.describe_client_viewer_invitation(presented_token_hash bytea)
        RETURNS TABLE (invitation_state text, station_name text, station_frequency_label text, client_name text,
                       invited_email text, has_account boolean, invitation_expires_at timestamptz)
        LANGUAGE sql STABLE ${DEFINER}
      AS $$
        SELECT CASE WHEN invitation.accepted_at IS NOT NULL THEN 'ACCEPTED'
                    WHEN invitation.revoked_at IS NOT NULL THEN 'REVOKED'
                    WHEN invitation.expires_at <= now() THEN 'EXPIRED'
                    ELSE 'OPEN' END,
               station.name, station.frequency_label, followed_client.name, invitation.invited_email::text,
               EXISTS (SELECT 1 FROM app.portal_users AS account WHERE account.email = invitation.invited_email),
               invitation.expires_at
          FROM app.invitations AS invitation
          JOIN app.stations AS station ON station.id = invitation.station_id
          JOIN app.clients AS followed_client ON followed_client.id = invitation.client_id AND followed_client.station_id = invitation.station_id
         WHERE invitation.token_hash = presented_token_hash AND invitation.kind = 'CLIENT_VIEWER'
      $$`,

  // Accepting with a new account: the email is the invited one (the link proves it). An email with an account signs in.
  `
      CREATE FUNCTION app.accept_client_viewer_invitation_with_new_account(presented_token_hash bytea, new_full_name text,
                                                                         new_phone_number_e164 text, new_password_hash text,
                                                                         new_refresh_token_hash bytea, request_id text)
        RETURNS TABLE (outcome text, new_portal_user_id uuid, joined_station_id uuid, joined_client_id uuid,
                       new_portal_session_id uuid, new_refresh_token_expires_at timestamptz)
        LANGUAGE plpgsql ${DEFINER}
      AS $$
      DECLARE
        presented_invitation app.invitations%ROWTYPE;
        created_user_id uuid;
        issued record;
      BEGIN
        SELECT * INTO presented_invitation FROM app.invitations AS invitation
         WHERE invitation.token_hash = presented_token_hash AND invitation.kind = 'CLIENT_VIEWER' FOR UPDATE;
        IF NOT FOUND THEN
          RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        IF presented_invitation.accepted_at IS NOT NULL OR presented_invitation.revoked_at IS NOT NULL THEN
          RETURN QUERY SELECT CASE WHEN presented_invitation.accepted_at IS NOT NULL THEN 'ALREADY_ACCEPTED' ELSE 'REVOKED' END,
                              NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        IF presented_invitation.expires_at <= now() THEN
          RETURN QUERY SELECT 'EXPIRED'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        IF EXISTS (SELECT 1 FROM app.portal_users AS account WHERE account.email = presented_invitation.invited_email) THEN
          RETURN QUERY SELECT 'ACCOUNT_EXISTS'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::timestamptz;
          RETURN;
        END IF;
        INSERT INTO app.portal_users (email, password_hash, full_name, phone_number_e164)
        VALUES (presented_invitation.invited_email, new_password_hash, new_full_name, new_phone_number_e164)
        RETURNING id INTO created_user_id;
        INSERT INTO app.client_viewers (client_id, station_id, portal_user_id, invitation_id)
        VALUES (presented_invitation.client_id, presented_invitation.station_id, created_user_id, presented_invitation.id);
        UPDATE app.invitations SET accepted_at = now(), accepted_by_portal_user_id = created_user_id WHERE id = presented_invitation.id;
        SELECT * INTO issued FROM app.issue_portal_session(created_user_id, new_refresh_token_hash, request_id);
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
        VALUES (presented_invitation.station_id, created_user_id, 'client_viewer_invitation_accepted', 'invitation', presented_invitation.id,
                jsonb_build_object('client_id', presented_invitation.client_id, 'is_new_account', true), request_id);
        RETURN QUERY SELECT 'ACCEPTED'::text, created_user_id, presented_invitation.station_id, presented_invitation.client_id,
                            issued.new_portal_session_id, issued.new_refresh_token_expires_at;
      END $$`,

  // Accepting while signed in: only with the invited email, and only once. Following the client already counts as done.
  `
      CREATE FUNCTION app.accept_client_viewer_invitation_for_signed_in_user(presented_token_hash bytea, request_id text)
        RETURNS TABLE (outcome text, joined_station_id uuid, joined_client_id uuid)
        LANGUAGE plpgsql ${DEFINER}
      AS $$
      DECLARE
        presented_invitation app.invitations%ROWTYPE;
        signed_in_email app.citext;
      BEGIN
        SELECT account.email INTO signed_in_email FROM app.portal_users AS account
         WHERE account.id = app.current_user_id() AND account.status = 'ACTIVE';
        IF NOT FOUND THEN
          RETURN QUERY SELECT 'NOT_SIGNED_IN'::text, NULL::uuid, NULL::uuid;
          RETURN;
        END IF;
        SELECT * INTO presented_invitation FROM app.invitations AS invitation
         WHERE invitation.token_hash = presented_token_hash AND invitation.kind = 'CLIENT_VIEWER' FOR UPDATE;
        IF NOT FOUND THEN
          RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::uuid, NULL::uuid;
          RETURN;
        END IF;
        IF presented_invitation.accepted_at IS NOT NULL OR presented_invitation.revoked_at IS NOT NULL THEN
          RETURN QUERY SELECT CASE WHEN presented_invitation.accepted_at IS NOT NULL THEN 'ALREADY_ACCEPTED' ELSE 'REVOKED' END,
                              NULL::uuid, NULL::uuid;
          RETURN;
        END IF;
        IF presented_invitation.expires_at <= now() THEN
          RETURN QUERY SELECT 'EXPIRED'::text, NULL::uuid, NULL::uuid;
          RETURN;
        END IF;
        IF signed_in_email <> presented_invitation.invited_email THEN
          RETURN QUERY SELECT 'FOR_ANOTHER_EMAIL'::text, NULL::uuid, NULL::uuid;
          RETURN;
        END IF;
        INSERT INTO app.client_viewers (client_id, station_id, portal_user_id, invitation_id)
        VALUES (presented_invitation.client_id, presented_invitation.station_id, app.current_user_id(), presented_invitation.id)
        ON CONFLICT ON CONSTRAINT client_viewers_primary_key DO NOTHING;
        UPDATE app.invitations SET accepted_at = now(), accepted_by_portal_user_id = app.current_user_id() WHERE id = presented_invitation.id;
        INSERT INTO app.audit_events (station_id, actor_portal_user_id, action, entity_type, entity_id, changes, request_id)
        VALUES (presented_invitation.station_id, app.current_user_id(), 'client_viewer_invitation_accepted', 'invitation',
                presented_invitation.id, jsonb_build_object('client_id', presented_invitation.client_id, 'is_new_account', false), request_id);
        RETURN QUERY SELECT 'ACCEPTED'::text, presented_invitation.station_id, presented_invitation.client_id;
      END $$`,

  // ---- the client's reads ------------------------------------------------------------------------------------------------
  // Every client the signed-in person follows, at ACTIVE stations, with what the client's pages name.
  `
      CREATE FUNCTION app.list_client_viewer_accesses()
        RETURNS TABLE (station_id uuid, station_name text, station_frequency_label text, station_time_zone text,
                       station_contact_name text, station_contact_phone_number_e164 text, client_id uuid, client_name text)
        LANGUAGE sql STABLE ${DEFINER}
      AS $$
        SELECT station.id, station.name, station.frequency_label, station.time_zone, station.contact_name,
               station.contact_phone_number_e164, followed_client.id, followed_client.name
          FROM app.client_viewers AS viewer
          JOIN app.stations AS station ON station.id = viewer.station_id
          JOIN app.clients AS followed_client ON followed_client.id = viewer.client_id AND followed_client.station_id = viewer.station_id
          JOIN app.portal_users AS person ON person.id = viewer.portal_user_id
         WHERE viewer.portal_user_id = app.current_user_id() AND station.status = 'ACTIVE' AND person.status = 'ACTIVE'
         ORDER BY lower(station.name), station.id, lower(followed_client.name), followed_client.id
      $$`,

  // The person's adverts at one station: those of the clients they follow whose latest campaign is published (active,
  // paused or ended; a draft is the station's work in progress). Heard: the station's last 7 days, as its own pages count.
  `
      CREATE FUNCTION app.list_client_viewer_ads(target_station_id uuid)
        RETURNS TABLE (ad_id uuid, client_id uuid, client_name text, title text, campaign_id uuid, campaign_display_status text,
                       campaign_starts_on text, campaign_ends_on text, campaign_time_windows json, heard_last_seven_days integer)
        LANGUAGE sql STABLE ${DEFINER}
      AS $$
        SELECT ads.id, ads.client_id, followed_client.name, ads.title, campaign.id,
               app.campaign_display_status(campaign.id, now()),
               to_char(lower(campaign.active_period) AT TIME ZONE station.time_zone, 'YYYY-MM-DD'),
               to_char((upper(campaign.active_period) AT TIME ZONE station.time_zone) - interval '1 day', 'YYYY-MM-DD'),
               ${TIME_WINDOWS_JSON},
               (SELECT count(*)::integer
                  FROM app.recognition_events AS heard_event
                  JOIN app.campaigns AS heard_campaign
                    ON heard_campaign.id = heard_event.campaign_id AND heard_campaign.station_id = heard_event.station_id
                 WHERE heard_event.station_id = ads.station_id AND heard_campaign.ad_id = ads.id
                   AND heard_event.outcome IN ('MATCH', 'MATCH_DEFAULT', 'CHOOSE_STATION')
                   AND heard_event.captured_at >= ${STATION_DAYS_STARTED_AT('station.time_zone', '6')}
                   AND heard_event.received_at >= ${STATION_DAYS_STARTED_AT('station.time_zone', '6')} - interval '2 minutes')
          FROM app.ads
          JOIN app.stations AS station ON station.id = ads.station_id
          JOIN app.clients AS followed_client ON followed_client.id = ads.client_id AND followed_client.station_id = ads.station_id
          ${LATEST_CAMPAIGN}
         WHERE ads.station_id = target_station_id AND ads.archived_at IS NULL
           AND campaign.status IN ('ACTIVE', 'PAUSED', 'ENDED')
           AND ${VIEWS('ads.station_id', 'ads.client_id')}
         ORDER BY lower(ads.title), ads.id
      $$`,

  // One advert, with the card listeners see. No row for an advert the person may not view.
  `
      CREATE FUNCTION app.read_client_viewer_ad(target_station_id uuid, target_ad_id uuid)
        RETURNS TABLE (ad_id uuid, client_id uuid, client_name text, title text, campaign_id uuid, campaign_display_status text,
                       campaign_starts_on text, campaign_ends_on text, campaign_time_windows json, action_card_content jsonb)
        LANGUAGE sql STABLE ${DEFINER}
      AS $$
        SELECT ads.id, ads.client_id, followed_client.name, ads.title, campaign.id,
               app.campaign_display_status(campaign.id, now()),
               to_char(lower(campaign.active_period) AT TIME ZONE station.time_zone, 'YYYY-MM-DD'),
               to_char((upper(campaign.active_period) AT TIME ZONE station.time_zone) - interval '1 day', 'YYYY-MM-DD'),
               ${TIME_WINDOWS_JSON},
               current_card.content
          FROM app.ads
          JOIN app.stations AS station ON station.id = ads.station_id
          JOIN app.clients AS followed_client ON followed_client.id = ads.client_id AND followed_client.station_id = ads.station_id
          LEFT JOIN app.action_cards AS current_card
                 ON current_card.id = ads.current_action_card_id AND current_card.station_id = ads.station_id
          ${LATEST_CAMPAIGN}
         WHERE ads.id = target_ad_id AND ads.station_id = target_station_id AND ads.archived_at IS NULL
           AND campaign.status IN ('ACTIVE', 'PAUSED', 'ENDED')
           AND ${VIEWS('ads.station_id', 'ads.client_id')}
      $$`,

  // Heard and taps by button type over the station's last [reading_range_days] days (1, 7 or 30), one row per advert the
  // person may view at the station (or only [target_ad_id]), counted as the station's own figures count them.
  `
      CREATE FUNCTION app.read_client_viewer_figures(target_station_id uuid, target_ad_id uuid, reading_range_days integer)
        RETURNS TABLE (ad_id uuid, first_day text, last_day text, heard integer, call_taps integer, whatsapp_taps integer,
                       map_taps integer, link_taps integer)
        LANGUAGE sql STABLE ${DEFINER}
      AS $$
        WITH viewed AS (
          SELECT ads.id AS ad_id, station.time_zone,
                 ${STATION_DAYS_STARTED_AT('station.time_zone', '(reading_range_days - 1)')} AS started_at,
                 to_char((now() AT TIME ZONE station.time_zone)::date - (reading_range_days - 1), 'YYYY-MM-DD') AS first_day,
                 to_char((now() AT TIME ZONE station.time_zone)::date, 'YYYY-MM-DD') AS last_day
            FROM app.ads
            JOIN app.stations AS station ON station.id = ads.station_id
            ${LATEST_CAMPAIGN}
           WHERE ads.station_id = target_station_id AND ads.archived_at IS NULL
             AND (target_ad_id IS NULL OR ads.id = target_ad_id)
             AND campaign.status IN ('ACTIVE', 'PAUSED', 'ENDED')
             AND ${VIEWS('ads.station_id', 'ads.client_id')}
        )
        SELECT viewed.ad_id, viewed.first_day, viewed.last_day,
               (SELECT count(*)::integer
                  FROM app.recognition_events AS heard_event
                  JOIN app.campaigns AS heard_campaign
                    ON heard_campaign.id = heard_event.campaign_id AND heard_campaign.station_id = heard_event.station_id
                 WHERE heard_event.station_id = target_station_id AND heard_campaign.ad_id = viewed.ad_id
                   AND heard_event.outcome IN ('MATCH', 'MATCH_DEFAULT', 'CHOOSE_STATION')
                   AND heard_event.captured_at >= viewed.started_at
                   AND heard_event.received_at >= viewed.started_at - interval '2 minutes'),
               tapped.call_taps, tapped.whatsapp_taps, tapped.map_taps, tapped.link_taps
          FROM viewed
          CROSS JOIN LATERAL (
            SELECT count(*) FILTER (WHERE tap.action_type = 'CALL')::integer AS call_taps,
                   count(*) FILTER (WHERE tap.action_type = 'WHATSAPP')::integer AS whatsapp_taps,
                   count(*) FILTER (WHERE tap.action_type = 'MAP')::integer AS map_taps,
                   count(*) FILTER (WHERE tap.action_type = 'LINK')::integer AS link_taps
              FROM app.engagement_events AS tap
              JOIN app.campaigns AS tapped_campaign ON tapped_campaign.id = tap.campaign_id AND tapped_campaign.station_id = tap.station_id
             WHERE tap.station_id = target_station_id AND tapped_campaign.ad_id = viewed.ad_id
               AND tap.occurred_at >= viewed.started_at AND tap.received_at >= viewed.started_at
          ) AS tapped
         ORDER BY viewed.ad_id
      $$`,

  // The same figures day by day, for the spreadsheet: one row per advert and station day that has anything to count.
  `
      CREATE FUNCTION app.list_client_viewer_daily_figures(target_station_id uuid, reading_range_days integer)
        RETURNS TABLE (station_day text, ad_id uuid, title text, heard integer, call_taps integer, whatsapp_taps integer,
                       map_taps integer, link_taps integer)
        LANGUAGE sql STABLE ${DEFINER}
      AS $$
        WITH viewed AS (
          SELECT ads.id AS ad_id, ads.title, station.time_zone,
                 ${STATION_DAYS_STARTED_AT('station.time_zone', '(reading_range_days - 1)')} AS started_at
            FROM app.ads
            JOIN app.stations AS station ON station.id = ads.station_id
            ${LATEST_CAMPAIGN}
           WHERE ads.station_id = target_station_id AND ads.archived_at IS NULL
             AND campaign.status IN ('ACTIVE', 'PAUSED', 'ENDED')
             AND ${VIEWS('ads.station_id', 'ads.client_id')}
        ),
        heard AS (
          SELECT viewed.ad_id, (heard_event.captured_at AT TIME ZONE viewed.time_zone)::date AS station_day, count(*)::integer AS heard
            FROM viewed
            JOIN app.campaigns AS heard_campaign ON heard_campaign.ad_id = viewed.ad_id AND heard_campaign.station_id = target_station_id
            JOIN app.recognition_events AS heard_event
              ON heard_event.campaign_id = heard_campaign.id AND heard_event.station_id = target_station_id
           WHERE heard_event.outcome IN ('MATCH', 'MATCH_DEFAULT', 'CHOOSE_STATION')
             AND heard_event.captured_at >= viewed.started_at
             AND heard_event.received_at >= viewed.started_at - interval '2 minutes'
           GROUP BY 1, 2
        ),
        tapped AS (
          SELECT viewed.ad_id, (tap.occurred_at AT TIME ZONE viewed.time_zone)::date AS station_day,
                 count(*) FILTER (WHERE tap.action_type = 'CALL')::integer AS call_taps,
                 count(*) FILTER (WHERE tap.action_type = 'WHATSAPP')::integer AS whatsapp_taps,
                 count(*) FILTER (WHERE tap.action_type = 'MAP')::integer AS map_taps,
                 count(*) FILTER (WHERE tap.action_type = 'LINK')::integer AS link_taps
            FROM viewed
            JOIN app.campaigns AS tapped_campaign ON tapped_campaign.ad_id = viewed.ad_id AND tapped_campaign.station_id = target_station_id
            JOIN app.engagement_events AS tap ON tap.campaign_id = tapped_campaign.id AND tap.station_id = target_station_id
           WHERE tap.occurred_at >= viewed.started_at AND tap.received_at >= viewed.started_at
           GROUP BY 1, 2
        )
        SELECT to_char(coalesce(heard.station_day, tapped.station_day), 'YYYY-MM-DD'), viewed.ad_id, viewed.title,
               coalesce(heard.heard, 0), coalesce(tapped.call_taps, 0), coalesce(tapped.whatsapp_taps, 0),
               coalesce(tapped.map_taps, 0), coalesce(tapped.link_taps, 0)
          FROM heard
          FULL JOIN tapped ON tapped.ad_id = heard.ad_id AND tapped.station_day = heard.station_day
          JOIN viewed ON viewed.ad_id = coalesce(heard.ad_id, tapped.ad_id)
         ORDER BY 1, lower(viewed.title), viewed.ad_id
      $$`,

  // The starts of a campaign's slots between two instants, in its station's time zone: a slot belongs to the day it
  // starts (Friday 22:00–02:00 is Friday's), and only slots that start inside the campaign's dates count.
  `
      CREATE FUNCTION app.list_campaign_slot_starts(target_campaign_id uuid, from_moment timestamptz, until_moment timestamptz)
        RETURNS TABLE (campaign_time_window_id uuid, slot_starts_at timestamptz, slot_ends_at timestamptz, local_date text,
                       local_start_time text, local_end_time text)
        LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
      AS $$
        SELECT slot.window_id, slot.starts_at, slot.ends_at, to_char(slot.local_day, 'YYYY-MM-DD'),
               to_char(slot.local_start_time, 'HH24:MI'), to_char(slot.local_end_time, 'HH24:MI')
          FROM (
            SELECT time_window.id AS window_id, local_day::date AS local_day, time_window.local_start_time, time_window.local_end_time,
                   ((local_day::date + time_window.local_start_time) AT TIME ZONE station.time_zone) AS starts_at,
                   ((local_day::date + time_window.local_end_time
                     + CASE WHEN time_window.local_end_time <= time_window.local_start_time THEN interval '1 day' ELSE interval '0' END)
                    AT TIME ZONE station.time_zone) AS ends_at,
                   campaign.active_period
              FROM app.campaigns AS campaign
              JOIN app.stations AS station ON station.id = campaign.station_id
              JOIN app.campaign_time_windows AS time_window ON time_window.campaign_id = campaign.id
             CROSS JOIN LATERAL generate_series((from_moment AT TIME ZONE station.time_zone)::date - 1,
                                                (until_moment AT TIME ZONE station.time_zone)::date, interval '1 day') AS local_day
             WHERE campaign.id = target_campaign_id
               AND extract(isodow FROM local_day)::smallint = ANY (time_window.days_of_week)
          ) AS slot
         WHERE slot.starts_at >= from_moment AND slot.starts_at < until_moment AND slot.active_period @> slot.starts_at
         ORDER BY slot.starts_at, slot.window_id
      $$`,

  // The next [slot_count] slots of each advert the person may view at the station (or of [target_ad_id]), in the next
  // 14 days: only ACTIVE campaigns at ACTIVE stations air.
  `
      CREATE FUNCTION app.list_client_viewer_next_slots(target_station_id uuid, target_ad_id uuid, slot_count integer)
        RETURNS TABLE (ad_id uuid, slot_starts_at timestamptz, slot_ends_at timestamptz, local_date text, local_start_time text,
                       local_end_time text)
        LANGUAGE sql STABLE ${DEFINER}
      AS $$
        SELECT ranked.ad_id, ranked.slot_starts_at, ranked.slot_ends_at, ranked.local_date, ranked.local_start_time, ranked.local_end_time
          FROM (
            SELECT ads.id AS ad_id, slot.slot_starts_at, slot.slot_ends_at, slot.local_date, slot.local_start_time, slot.local_end_time,
                   row_number() OVER (PARTITION BY ads.id ORDER BY slot.slot_starts_at) AS position
              FROM app.ads
              ${LATEST_CAMPAIGN}
             CROSS JOIN LATERAL app.list_campaign_slot_starts(campaign.id, now(), now() + interval '14 days') AS slot
             WHERE ads.station_id = target_station_id AND ads.archived_at IS NULL
               AND (target_ad_id IS NULL OR ads.id = target_ad_id)
               AND campaign.status = 'ACTIVE'
               AND ${VIEWS('ads.station_id', 'ads.client_id')}
          ) AS ranked
         WHERE ranked.position <= slot_count
         ORDER BY ranked.slot_starts_at, ranked.ad_id
      $$`,

  // ---- the client's own settings and devices -------------------------------------------------------------------------------
  // The person's settings (the defaults when they never changed them), and which of their adverts are muted.
  `
      CREATE FUNCTION app.read_client_viewer_notification_settings()
        RETURNS TABLE (is_push_on boolean, is_email_on boolean, lead_minutes smallint, muted_ads jsonb)
        LANGUAGE sql STABLE ${DEFINER}
      AS $$
        SELECT coalesce(settings.is_push_on, true), coalesce(settings.is_email_on, false), coalesce(settings.lead_minutes, 15::smallint),
               coalesce((SELECT jsonb_agg(jsonb_build_object('stationId', muted.station_id, 'adId', muted.ad_id) ORDER BY muted.ad_id)
                           FROM app.client_viewer_muted_ads AS muted WHERE muted.portal_user_id = app.current_user_id()), '[]'::jsonb)
          FROM (SELECT 1) AS one
          LEFT JOIN app.client_viewer_notification_settings AS settings ON settings.portal_user_id = app.current_user_id()
         WHERE app.current_user_id() IS NOT NULL
      $$`,

  // Saves the person's settings and replaces their muted adverts with [new_muted_ads] ([{stationId, adId}]), keeping only
  // adverts they may view. Only someone who follows a client has settings.
  `
      CREATE FUNCTION app.save_client_viewer_notification_settings(new_is_push_on boolean, new_is_email_on boolean,
                                                                 new_lead_minutes smallint, new_muted_ads jsonb)
        RETURNS text
        LANGUAGE plpgsql ${DEFINER}
      AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM app.client_viewers WHERE portal_user_id = app.current_user_id()) THEN
          RETURN 'NOT_A_CLIENT_VIEWER';
        END IF;
        INSERT INTO app.client_viewer_notification_settings (portal_user_id, is_push_on, is_email_on, lead_minutes, updated_at)
        VALUES (app.current_user_id(), new_is_push_on, new_is_email_on, new_lead_minutes, now())
        ON CONFLICT ON CONSTRAINT client_viewer_notification_settings_primary_key
        DO UPDATE SET is_push_on = EXCLUDED.is_push_on, is_email_on = EXCLUDED.is_email_on, lead_minutes = EXCLUDED.lead_minutes,
                      updated_at = now();
        DELETE FROM app.client_viewer_muted_ads WHERE portal_user_id = app.current_user_id();
        INSERT INTO app.client_viewer_muted_ads (portal_user_id, station_id, ad_id)
        SELECT DISTINCT app.current_user_id(), (muted ->> 'stationId')::uuid, (muted ->> 'adId')::uuid
          FROM jsonb_array_elements(new_muted_ads) AS muted
         WHERE app.can_current_user_view_ad((muted ->> 'stationId')::uuid, (muted ->> 'adId')::uuid);
        RETURN 'SAVED';
      END $$`,

  // A device turned on: stored for this person (a device once used by another account moves to this one), at most 10 per
  // person, the oldest going first.
  `
      CREATE FUNCTION app.save_web_push_subscription(new_endpoint text, new_endpoint_hash bytea, new_receiver_public_key text,
                                                     new_authentication_secret text)
        RETURNS text
        LANGUAGE plpgsql ${DEFINER}
      AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM app.client_viewers WHERE portal_user_id = app.current_user_id()) THEN
          RETURN 'NOT_A_CLIENT_VIEWER';
        END IF;
        INSERT INTO app.web_push_subscriptions (portal_user_id, endpoint, endpoint_hash, receiver_public_key, authentication_secret)
        VALUES (app.current_user_id(), new_endpoint, new_endpoint_hash, new_receiver_public_key, new_authentication_secret)
        ON CONFLICT ON CONSTRAINT web_push_subscriptions_endpoint_hash_unique
        DO UPDATE SET portal_user_id = EXCLUDED.portal_user_id, endpoint = EXCLUDED.endpoint,
                      receiver_public_key = EXCLUDED.receiver_public_key, authentication_secret = EXCLUDED.authentication_secret,
                      created_at = now();
        DELETE FROM app.web_push_subscriptions
         WHERE id IN (SELECT id FROM app.web_push_subscriptions WHERE portal_user_id = app.current_user_id()
                       ORDER BY created_at DESC OFFSET 10);
        RETURN 'SAVED';
      END $$`,

  `
      CREATE FUNCTION app.delete_own_web_push_subscription(target_endpoint_hash bytea) RETURNS text
        LANGUAGE plpgsql ${DEFINER}
      AS $$
      BEGIN
        DELETE FROM app.web_push_subscriptions WHERE endpoint_hash = target_endpoint_hash AND portal_user_id = app.current_user_id();
        RETURN CASE WHEN FOUND THEN 'DELETED' ELSE 'NOT_FOUND' END;
      END $$`,

  // The person's own devices, to send them a test notification.
  `
      CREATE FUNCTION app.list_own_web_push_subscriptions()
        RETURNS TABLE (endpoint text, endpoint_hash bytea, receiver_public_key text, authentication_secret text)
        LANGUAGE sql STABLE ${DEFINER}
      AS $$
        SELECT subscription.endpoint, subscription.endpoint_hash, subscription.receiver_public_key, subscription.authentication_secret
          FROM app.web_push_subscriptions AS subscription
         WHERE subscription.portal_user_id = app.current_user_id()
         ORDER BY subscription.created_at
      $$`,

  // ---- the reminder job and the push sender ------------------------------------------------------------------------------
  // Every reminder due at [at_moment]: a slot of an ACTIVE campaign at an ACTIVE station starting within the next 31
  // minutes, for each person who follows the advert's client, has not muted it, has push or email on, and whose lead time
  // has come, and who has not had this slot's reminder yet.
  `
      CREATE FUNCTION app.list_due_air_time_reminders(at_moment timestamptz)
        RETURNS TABLE (portal_user_id uuid, email text, campaign_time_window_id uuid, slot_starts_at timestamptz, local_date text,
                       local_start_time text, local_end_time text, is_today boolean, station_id uuid, station_name text,
                       station_frequency_label text, ad_id uuid, ad_title text, client_name text, is_push_on boolean, is_email_on boolean)
        LANGUAGE sql STABLE ${DEFINER}
      AS $$
        SELECT viewer.portal_user_id, person.email::text, slot.campaign_time_window_id, slot.slot_starts_at, slot.local_date,
               slot.local_start_time, slot.local_end_time,
               slot.local_date = to_char((at_moment AT TIME ZONE station.time_zone)::date, 'YYYY-MM-DD'),
               station.id, station.name, station.frequency_label, ads.id, ads.title, followed_client.name,
               coalesce(settings.is_push_on, true), coalesce(settings.is_email_on, false)
          FROM app.campaigns AS campaign
          JOIN app.stations AS station ON station.id = campaign.station_id AND station.status = 'ACTIVE'
          JOIN app.ads ON ads.id = campaign.ad_id AND ads.station_id = campaign.station_id AND ads.archived_at IS NULL
          JOIN app.clients AS followed_client ON followed_client.id = ads.client_id AND followed_client.station_id = ads.station_id
          JOIN app.client_viewers AS viewer ON viewer.client_id = ads.client_id AND viewer.station_id = ads.station_id
          JOIN app.portal_users AS person ON person.id = viewer.portal_user_id AND person.status = 'ACTIVE'
          LEFT JOIN app.client_viewer_notification_settings AS settings ON settings.portal_user_id = viewer.portal_user_id
          CROSS JOIN LATERAL app.list_campaign_slot_starts(campaign.id, at_moment, at_moment + interval '31 minutes') AS slot
         WHERE campaign.status = 'ACTIVE' AND campaign.active_period && tstzrange(at_moment, at_moment + interval '31 minutes')
           AND (coalesce(settings.is_push_on, true) OR coalesce(settings.is_email_on, false))
           AND slot.slot_starts_at - make_interval(mins => coalesce(settings.lead_minutes, 15)) <= at_moment
           AND slot.slot_starts_at > at_moment
           AND NOT EXISTS (SELECT 1 FROM app.client_viewer_muted_ads AS muted
                            WHERE muted.portal_user_id = viewer.portal_user_id AND muted.ad_id = ads.id)
           AND NOT EXISTS (SELECT 1 FROM app.air_time_reminders AS sent
                            WHERE sent.portal_user_id = viewer.portal_user_id AND sent.campaign_time_window_id = slot.campaign_time_window_id
                              AND sent.slot_starts_at = slot.slot_starts_at)
         ORDER BY slot.slot_starts_at, viewer.portal_user_id
      $$`,

  // Marks a reminder as sent; false when another run already did, so it goes out once.
  `
      CREATE FUNCTION app.claim_air_time_reminder(target_portal_user_id uuid, target_campaign_time_window_id uuid,
                                                  target_slot_starts_at timestamptz)
        RETURNS boolean
        LANGUAGE plpgsql ${DEFINER}
      AS $$
      BEGIN
        INSERT INTO app.air_time_reminders (portal_user_id, campaign_time_window_id, slot_starts_at)
        VALUES (target_portal_user_id, target_campaign_time_window_id, target_slot_starts_at)
        ON CONFLICT ON CONSTRAINT air_time_reminders_primary_key DO NOTHING;
        RETURN FOUND;
      END $$`,

  `
      CREATE FUNCTION app.delete_old_air_time_reminders(older_than interval) RETURNS integer
        LANGUAGE plpgsql ${DEFINER}
      AS $$
      DECLARE
        deleted_count integer;
      BEGIN
        DELETE FROM app.air_time_reminders WHERE queued_at < now() - older_than;
        GET DIAGNOSTICS deleted_count = ROW_COUNT;
        RETURN deleted_count;
      END $$`,

  // A person's devices, for the push sender (the notification worker sends what the reminder job queued).
  `
      CREATE FUNCTION app.list_web_push_subscriptions_of(target_portal_user_id uuid)
        RETURNS TABLE (endpoint text, endpoint_hash bytea, receiver_public_key text, authentication_secret text)
        LANGUAGE sql STABLE ${DEFINER}
      AS $$
        SELECT subscription.endpoint, subscription.endpoint_hash, subscription.receiver_public_key, subscription.authentication_secret
          FROM app.web_push_subscriptions AS subscription
         WHERE subscription.portal_user_id = target_portal_user_id
         ORDER BY subscription.created_at
      $$`,

  // The push service said the device is gone (404 or 410): it is forgotten.
  `
      CREATE FUNCTION app.forget_web_push_subscription(target_endpoint_hash bytea) RETURNS boolean
        LANGUAGE plpgsql ${DEFINER}
      AS $$
      BEGIN
        DELETE FROM app.web_push_subscriptions WHERE endpoint_hash = target_endpoint_hash;
        RETURN FOUND;
      END $$`,

  `
      CREATE FUNCTION app.note_web_push_sent(target_endpoint_hash bytea) RETURNS void
        LANGUAGE sql ${DEFINER}
      AS $$ UPDATE app.web_push_subscriptions SET last_sent_at = now() WHERE endpoint_hash = target_endpoint_hash $$`,
];

/**
 * Distinct listeners by gender and age band for one station (or one of its ads when [reading_ad_id] is given), as
 * ListenerAudienceMix1791900100000 counted them; no row when the ad is not the station's. Run only from the definer
 * functions, which check who is asking.
 */
const COMPUTE_LISTENER_MIX = `
      CREATE FUNCTION app.compute_listener_mix(reading_station_id uuid, reading_ad_id uuid, reading_range_days integer)
        RETURNS TABLE (first_day text, last_day text, known_listeners integer, not_known_yet_listeners integer, genders jsonb, age_bands jsonb)
        LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
      AS $$
        WITH period AS (
          SELECT station.time_zone,
                 (((now() AT TIME ZONE station.time_zone)::date - (reading_range_days - 1))::timestamp AT TIME ZONE station.time_zone) AS started_at,
                 to_char((now() AT TIME ZONE station.time_zone)::date - (reading_range_days - 1), 'YYYY-MM-DD') AS first_day,
                 to_char((now() AT TIME ZONE station.time_zone)::date, 'YYYY-MM-DD') AS last_day,
                 extract(year FROM now() AT TIME ZONE station.time_zone)::integer AS current_year
            FROM app.stations AS station
           WHERE station.id = reading_station_id
             AND (reading_ad_id IS NULL OR EXISTS (SELECT 1 FROM app.ads AS reading_ad
                                                    WHERE reading_ad.id = reading_ad_id AND reading_ad.station_id = station.id))
        ),
        heard_installs AS MATERIALIZED (
          SELECT DISTINCT heard_event.listener_install_id
            FROM app.recognition_events AS heard_event
           WHERE heard_event.station_id = reading_station_id
             AND (reading_ad_id IS NULL OR EXISTS (
                   SELECT 1 FROM app.campaigns AS heard_campaign
                    WHERE heard_campaign.id = heard_event.campaign_id AND heard_campaign.station_id = heard_event.station_id
                      AND heard_campaign.ad_id = reading_ad_id))
             AND heard_event.outcome IN ('MATCH', 'MATCH_DEFAULT', 'CHOOSE_STATION')
             AND heard_event.captured_at >= (SELECT started_at FROM period)
             -- A clip arrives at most 24 hours after it was heard and never 2 minutes before: this bounds the months read.
             AND heard_event.received_at >= (SELECT started_at FROM period) - interval '2 minutes'
        ),
        known AS (
          SELECT listener_account.gender,
                 CASE
                   WHEN period.current_year - listener_account.birth_year < 18 THEN 'UNDER_18'
                   WHEN period.current_year - listener_account.birth_year <= 24 THEN 'AGE_18_TO_24'
                   WHEN period.current_year - listener_account.birth_year <= 34 THEN 'AGE_25_TO_34'
                   WHEN period.current_year - listener_account.birth_year <= 44 THEN 'AGE_35_TO_44'
                   WHEN period.current_year - listener_account.birth_year <= 54 THEN 'AGE_45_TO_54'
                   ELSE 'AGE_55_AND_OVER'
                 END AS age_band
            FROM (SELECT DISTINCT listener_install.listener_account_id
                    FROM heard_installs
                    JOIN app.listener_installs AS listener_install ON listener_install.id = heard_installs.listener_install_id
                   WHERE listener_install.listener_account_id IS NOT NULL) AS known_account
            JOIN app.listener_accounts AS listener_account ON listener_account.id = known_account.listener_account_id
           CROSS JOIN period
        )
        SELECT period.first_day, period.last_day,
               (SELECT count(*) FROM known)::integer AS known_listeners,
               (SELECT count(*)
                  FROM heard_installs
                  JOIN app.listener_installs AS listener_install ON listener_install.id = heard_installs.listener_install_id
                 WHERE listener_install.listener_account_id IS NULL)::integer AS not_known_yet_listeners,
               (SELECT jsonb_object_agg(gender_name, (SELECT count(*) FROM known WHERE known.gender = gender_name))
                  FROM unnest(ARRAY['FEMALE', 'MALE', 'ANOTHER', 'PREFER_NOT_TO_SAY']) AS gender_name) AS genders,
               (SELECT jsonb_object_agg(age_band_name, (SELECT count(*) FROM known WHERE known.age_band = age_band_name))
                  FROM unnest(ARRAY['UNDER_18', 'AGE_18_TO_24', 'AGE_25_TO_34', 'AGE_35_TO_44', 'AGE_45_TO_54', 'AGE_55_AND_OVER']) AS age_band_name) AS age_bands
          FROM period
      $$`;

/** The mix for one advert the signed-in person may view; no row otherwise. */
const READ_LISTENER_MIX_FOR_CLIENT_AD = `
      CREATE FUNCTION app.read_listener_mix_for_client_ad(target_station_id uuid, target_ad_id uuid, reading_range_days integer)
        RETURNS TABLE (first_day text, last_day text, known_listeners integer, not_known_yet_listeners integer, genders jsonb, age_bands jsonb)
        LANGUAGE sql STABLE ${DEFINER}
      AS $$
        SELECT mix.* FROM app.compute_listener_mix(target_station_id, target_ad_id, reading_range_days) AS mix
         WHERE app.can_current_user_view_ad(target_station_id, target_ad_id)
      $$`;
