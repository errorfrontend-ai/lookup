import {
  type ActionCard,
  type AdAttentionReason,
  type AdCampaignSummary,
  type AdDetail,
  type AdSchedule,
  type AdStatus,
  type AdSummary,
  type AdUploadContentType,
  AD_ATTENTION_REASONS,
  type CampaignDisplayStatus,
  ENDING_SOON_DAYS,
  UNFINISHED_UPLOAD_GRACE_MINUTES,
} from '@lookup/contracts';
import type { EntityManager } from 'typeorm';
import { AppError } from '../../common/errors/app-error.js';

/** One ad as the queries below return it, with its latest campaign and current action card. */
export interface AdRecord {
  id: string;
  title: string;
  status: AdStatus;
  duration_milliseconds: number | null;
  upload_original_file_name: string | null;
  upload_object_key: string | null;
  upload_content_type: AdUploadContentType | null;
  upload_size_bytes: number | null;
  processing_error_code: string | null;
  current_action_card_id: string | null;
  action_card_content: ActionCard | null;
  client_id: string;
  client_name: string;
  station_time_zone: string;
  campaign_id: string | null;
  campaign_display_status: CampaignDisplayStatus | null;
  campaign_starts_on: string | null;
  campaign_ends_on: string | null;
  campaign_grace_period_minutes: number | null;
  campaign_engagement_limit: number | null;
  campaign_time_windows: Array<{ daysOfWeek: number[]; localStartTime: string; localEndTime: string }> | null;
  /** The later of the ad's and its campaign's last change. */
  updated_at_text: string;
  created_at_text: string;
  uploaded_at_text: string | null;
  /** The five reasons an ad needs attention, each decided in the database (see AD_ATTENTION_REASONS). */
  is_upload_refused: boolean;
  is_needing_review: boolean;
  is_upload_not_finished: boolean;
  is_start_date_passed: boolean;
  is_ending_soon: boolean;
  /** What listeners did with the ad over the station's last 7 days (see LAST_SEVEN_DAYS_STARTED_AT). */
  heard_last_seven_days: number;
  heard_sent_later_last_seven_days: number;
  button_taps_last_seven_days: number;
}

/**
 * The start of the station's last 7 days: midnight, station time, six days before today. A scalar subquery, so it
 * is worked out once per query and the recognitions' (station_id, captured_at) index can range over it.
 */
export const LAST_SEVEN_DAYS_STARTED_AT = `(SELECT (((now() AT TIME ZONE week_station.time_zone)::date - 6)::timestamp AT TIME ZONE week_station.time_zone)
                                             FROM app.stations AS week_station WHERE week_station.id = app.current_station_id())`;

/**
 * A recognition counts for a station when the listener was shown one of its cards: a match, the client's usual
 * buttons, or a "Which station?" the listener answered with it (row-level security shows a station only its own,
 * and an unanswered chooser names no station).
 */
export const COUNTED_RECOGNITION_OUTCOMES = `('MATCH', 'MATCH_DEFAULT', 'CHOOSE_STATION')`;

/**
 * Every column the portal needs about an ad, read through row-level security (so only the current
 * station's ads ever appear). Dates are converted to the station's time zone in the database, and
 * "Live now" comes from app.campaign_display_status, the same rule recognition uses.
 */
export const AD_RECORD_SELECT = `
  SELECT ads.id, ads.title, ads.status, ads.duration_milliseconds, ads.upload_original_file_name, ads.upload_object_key,
         ads.upload_content_type, ads.upload_size_bytes, ads.processing_error_code, ads.current_action_card_id,
         current_card.content AS action_card_content,
         clients.id AS client_id, clients.name AS client_name,
         station.time_zone AS station_time_zone,
         campaign.id AS campaign_id,
         CASE WHEN campaign.id IS NULL THEN NULL ELSE app.campaign_display_status(campaign.id, now()) END AS campaign_display_status,
         to_char(lower(campaign.active_period) AT TIME ZONE station.time_zone, 'YYYY-MM-DD') AS campaign_starts_on,
         to_char((upper(campaign.active_period) AT TIME ZONE station.time_zone) - interval '1 day', 'YYYY-MM-DD') AS campaign_ends_on,
         (extract(epoch FROM campaign.time_window_grace_period) / 60)::integer AS campaign_grace_period_minutes,
         campaign.engagement_limit AS campaign_engagement_limit,
         (SELECT json_agg(json_build_object(
                    'daysOfWeek', time_window.days_of_week,
                    'localStartTime', to_char(time_window.local_start_time, 'HH24:MI'),
                    'localEndTime', to_char(time_window.local_end_time, 'HH24:MI'))
                  ORDER BY time_window.local_start_time, time_window.days_of_week)
            FROM app.campaign_time_windows AS time_window WHERE time_window.campaign_id = campaign.id) AS campaign_time_windows,
         to_char(greatest(ads.updated_at, campaign.updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_text,
         to_char(ads.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text,
         to_char(ads.uploaded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS uploaded_at_text,
         lower(campaign.active_period) AS campaign_starts_at,
         greatest(ads.updated_at, campaign.updated_at) AS last_changed_at,
         (ads.status = 'FAILED') AS is_upload_refused,
         (ads.status = 'NEEDS_REVIEW') AS is_needing_review,
         coalesce(ads.status = 'AWAITING_UPLOAD'
            AND ads.upload_expires_at < now() - interval '${UNFINISHED_UPLOAD_GRACE_MINUTES} minutes', false) AS is_upload_not_finished,
         coalesce(campaign.status = 'DRAFT' AND lower(campaign.active_period) <= now(), false) AS is_start_date_passed,
         coalesce(campaign.status = 'ACTIVE' AND upper(campaign.active_period) > now()
            AND ((upper(campaign.active_period) AT TIME ZONE station.time_zone)::date - 1)
                - (now() AT TIME ZONE station.time_zone)::date BETWEEN 0 AND ${ENDING_SOON_DAYS}, false) AS is_ending_soon,
         coalesce(heard.heard_count, 0) AS heard_last_seven_days,
         coalesce(heard.heard_sent_later_count, 0) AS heard_sent_later_last_seven_days,
         coalesce(tapped.button_tap_count, 0) AS button_taps_last_seven_days
    FROM app.ads
    JOIN app.clients ON clients.id = ads.client_id AND clients.station_id = ads.station_id
    JOIN app.stations AS station ON station.id = ads.station_id
    LEFT JOIN app.action_cards AS current_card
           ON current_card.id = ads.current_action_card_id AND current_card.station_id = ads.station_id
    LEFT JOIN LATERAL (
      SELECT latest.id, latest.status, latest.active_period, latest.time_window_grace_period, latest.engagement_limit,
             latest.updated_at
        FROM app.campaigns AS latest
       WHERE latest.ad_id = ads.id AND latest.station_id = ads.station_id
       ORDER BY latest.created_at DESC
       LIMIT 1
    ) AS campaign ON true
    -- Each grouped once per query for the whole station, then joined by ad (P5B-D2).
    LEFT JOIN (
      SELECT heard_campaign.ad_id, count(*)::integer AS heard_count,
             count(*) FILTER (WHERE heard_event.is_deferred)::integer AS heard_sent_later_count
        FROM app.recognition_events AS heard_event
        JOIN app.campaigns AS heard_campaign
          ON heard_campaign.id = heard_event.campaign_id AND heard_campaign.station_id = heard_event.station_id
       WHERE heard_event.station_id = app.current_station_id()
         AND heard_event.outcome IN ${COUNTED_RECOGNITION_OUTCOMES}
         AND heard_event.captured_at >= ${LAST_SEVEN_DAYS_STARTED_AT}
         -- A clip arrives at most 24 hours after it was heard and never 2 minutes before: this bounds the months read.
         AND heard_event.received_at >= ${LAST_SEVEN_DAYS_STARTED_AT} - interval '2 minutes'
       GROUP BY heard_campaign.ad_id
    ) AS heard ON heard.ad_id = ads.id
    LEFT JOIN (
      SELECT tapped_campaign.ad_id, count(*)::integer AS button_tap_count
        FROM app.engagement_events AS tap
        JOIN app.campaigns AS tapped_campaign ON tapped_campaign.id = tap.campaign_id AND tapped_campaign.station_id = tap.station_id
       WHERE tap.station_id = app.current_station_id()
         AND tap.occurred_at >= ${LAST_SEVEN_DAYS_STARTED_AT}
         AND tap.received_at >= ${LAST_SEVEN_DAYS_STARTED_AT}
       GROUP BY tapped_campaign.ad_id
    ) AS tapped ON tapped.ad_id = ads.id`;

/** The ad with this id at the current station; NOT_FOUND for another station's ad or none. */
export async function findAdRecord(database: EntityManager, adId: string): Promise<AdRecord> {
  const [ad] = (await database.query(`${AD_RECORD_SELECT} WHERE ads.id = $1 AND ads.archived_at IS NULL`, [adId])) as AdRecord[];
  if (!ad) throw new AppError('NOT_FOUND', { internalDetail: 'ad not found at this station' });
  return ad;
}

/** Locks the ad's row for the rest of the transaction, then reads it, so concurrent edits to one ad queue up. */
export async function lockAndFindAdRecord(database: EntityManager, adId: string): Promise<AdRecord> {
  await database.query(`SELECT id FROM app.ads WHERE id = $1 FOR UPDATE`, [adId]);
  return findAdRecord(database, adId);
}

export function toAdSummary(ad: AdRecord): AdSummary {
  return {
    id: ad.id,
    title: ad.title,
    client: { id: ad.client_id, name: ad.client_name },
    status: ad.status,
    durationMilliseconds: ad.duration_milliseconds,
    uploadedFileName: ad.upload_original_file_name,
    campaign: toCampaignSummary(ad),
    hasActionCard: ad.current_action_card_id !== null,
    attentionReasons: attentionReasonsOf(ad),
    updatedAt: ad.updated_at_text,
    lastSevenDays: { heard: ad.heard_last_seven_days, heardSentLater: ad.heard_sent_later_last_seven_days, buttonTaps: ad.button_taps_last_seven_days },
  };
}

/** The reasons this ad needs attention, most serious first. */
function attentionReasonsOf(ad: AdRecord): AdAttentionReason[] {
  const flags: Record<AdAttentionReason, boolean> = {
    upload_refused: ad.is_upload_refused,
    needs_review: ad.is_needing_review,
    upload_not_finished: ad.is_upload_not_finished,
    start_date_passed: ad.is_start_date_passed,
    ending_soon: ad.is_ending_soon,
  };
  return AD_ATTENTION_REASONS.filter((reason) => flags[reason]);
}

export function toAdDetail(ad: AdRecord): AdDetail {
  const campaign = toCampaignSummary(ad);
  const schedule: AdSchedule | null = campaign
    ? {
        ...campaign,
        gracePeriodMinutes: ad.campaign_grace_period_minutes ?? 0,
        engagementLimit: ad.campaign_engagement_limit,
        stationTimeZone: ad.station_time_zone,
      }
    : null;
  return {
    ...toAdSummary(ad),
    uploadSizeBytes: ad.upload_size_bytes,
    uploadedAt: ad.uploaded_at_text,
    processingErrorCode: ad.processing_error_code,
    actionCard: ad.action_card_content,
    schedule,
    createdAt: ad.created_at_text,
  };
}

function toCampaignSummary(ad: AdRecord): AdCampaignSummary | null {
  if (!ad.campaign_id || !ad.campaign_display_status || !ad.campaign_starts_on || !ad.campaign_ends_on) return null;
  return {
    id: ad.campaign_id,
    displayStatus: ad.campaign_display_status,
    startsOn: ad.campaign_starts_on,
    endsOn: ad.campaign_ends_on,
    timeWindows: ad.campaign_time_windows ?? [],
  };
}
