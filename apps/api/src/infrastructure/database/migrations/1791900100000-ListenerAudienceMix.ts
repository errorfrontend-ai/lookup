import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Who is listening (ADR-005, docs/design/listener-accounts.md §7): how many different listeners identified a station's
 * ads, by gender and by age band, for the people who gave them when they made an account.
 *
 * Two functions, one for the station and one for one of its ads. Each is SECURITY DEFINER with its search path pinned and
 * EXECUTE for lookup_api only, because the accounts table is closed to every service role (a leaked API login cannot read
 * an email, a gender or an age). The functions read the current station from app.current_station_id(), as row-level
 * security does for everything else, so a station only ever counts its own recognitions; the ad one also returns nothing
 * when the ad is not the current station's, so the API answers 404 as it does for any other station's ad.
 *
 * What they return is counts and nothing else: the first and last day counted, how many accounts and how many phones with
 * no account heard the ads, and the known listeners by gender and by age band (every group present, zero where nobody is).
 * No id, no email and no row per listener leaves them. The small-group rule that decides what a station may see (groups
 * under 10 are folded together) is a pure function in the API, tested at 9, 10 and 11.
 *
 *  - A listener counts once however often they identified: one per account (so a person with two phones is one), and one
 *    per phone that has no account (or has signed out, or whose account was deleted, so its earlier scans go back to
 *    "not known yet").
 *  - The age band is worked out at query time from the stored birth year and the station's current year, as ageBandOf in
 *    the contract does.
 *  - A recognition counts as the listener figures count it: a match, the client's usual card or a "Which station?"
 *    answered with this station, on the day it was heard (in the station's time zone), never another station's.
 *
 * Scaling: like the listener figures, this reads the recognitions live, bounded by the same range and receipt-time
 * window, so it touches only the months in range. Phase 7's roll-ups will take it over when stations are many.
 */
export class ListenerAudienceMix1791900100000 implements MigrationInterface {
  name = 'ListenerAudienceMix1791900100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(READ_LISTENER_MIX_FOR_STATION);
    await queryRunner.query(READ_LISTENER_MIX_FOR_AD);
    for (const signature of API_FUNCTIONS) await queryRunner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO lookup_api`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const signature of API_FUNCTIONS) await queryRunner.query(`DROP FUNCTION ${signature}`);
  }
}

const API_FUNCTIONS = ['app.read_listener_mix_for_station(integer)', 'app.read_listener_mix_for_ad(uuid, integer)'];

/**
 * The function's body, the same for the station and for one ad: [adOnly] adds the ad's own check and its campaign join.
 * The result is one row, or none when there is no current station (or, for an ad, when it is not the station's).
 */
function mixFunction(name: string, parameters: string, adOnly: boolean): string {
  return `
      CREATE FUNCTION app.${name}(${parameters})
        RETURNS TABLE (first_day text, last_day text, known_listeners integer, not_known_yet_listeners integer, genders jsonb, age_bands jsonb)
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
      AS $$
        WITH period AS (
          SELECT station.time_zone,
                 (((now() AT TIME ZONE station.time_zone)::date - (reading_range_days - 1))::timestamp AT TIME ZONE station.time_zone) AS started_at,
                 to_char((now() AT TIME ZONE station.time_zone)::date - (reading_range_days - 1), 'YYYY-MM-DD') AS first_day,
                 to_char((now() AT TIME ZONE station.time_zone)::date, 'YYYY-MM-DD') AS last_day,
                 extract(year FROM now() AT TIME ZONE station.time_zone)::integer AS current_year
            FROM app.stations AS station
           WHERE station.id = app.current_station_id()${
             adOnly
               ? `
             AND EXISTS (SELECT 1 FROM app.ads AS reading_ad WHERE reading_ad.id = reading_ad_id AND reading_ad.station_id = station.id)`
               : ''
           }
        ),
        heard_installs AS MATERIALIZED (
          SELECT DISTINCT heard_event.listener_install_id
            FROM app.recognition_events AS heard_event${
              adOnly
                ? `
            JOIN app.campaigns AS heard_campaign
              ON heard_campaign.id = heard_event.campaign_id AND heard_campaign.station_id = heard_event.station_id`
                : ''
            }
           WHERE heard_event.station_id = app.current_station_id()${
             adOnly
               ? `
             AND heard_campaign.ad_id = reading_ad_id`
               : ''
           }
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
}

/** The station's own listeners over its last [reading_range_days] days (1, 7 or 30). */
const READ_LISTENER_MIX_FOR_STATION = mixFunction('read_listener_mix_for_station', 'reading_range_days integer', false);

/** The listeners of one of the current station's ads; no row when the ad is not the station's. */
const READ_LISTENER_MIX_FOR_AD = mixFunction('read_listener_mix_for_ad', 'reading_ad_id uuid, reading_range_days integer', true);
