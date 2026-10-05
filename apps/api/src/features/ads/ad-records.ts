import type {
  ActionCard,
  AdCampaignSummary,
  AdDetail,
  AdSchedule,
  AdStatus,
  AdSummary,
  AdUploadContentType,
  CampaignDisplayStatus,
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
  updated_at_text: string;
  created_at_text: string;
}

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
         to_char(ads.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_text,
         to_char(ads.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text
    FROM app.ads
    JOIN app.clients ON clients.id = ads.client_id AND clients.station_id = ads.station_id
    JOIN app.stations AS station ON station.id = ads.station_id
    LEFT JOIN app.action_cards AS current_card
           ON current_card.id = ads.current_action_card_id AND current_card.station_id = ads.station_id
    LEFT JOIN LATERAL (
      SELECT latest.id, latest.active_period, latest.time_window_grace_period, latest.engagement_limit
        FROM app.campaigns AS latest
       WHERE latest.ad_id = ads.id AND latest.station_id = ads.station_id
       ORDER BY latest.created_at DESC
       LIMIT 1
    ) AS campaign ON true`;

/** The ad with this id at the current station; NOT_FOUND for another station's ad or none. */
export async function findAdRecord(database: EntityManager, adId: string): Promise<AdRecord> {
  const [ad] = (await database.query(`${AD_RECORD_SELECT} WHERE ads.id = $1`, [adId])) as AdRecord[];
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
    updatedAt: ad.updated_at_text,
  };
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
