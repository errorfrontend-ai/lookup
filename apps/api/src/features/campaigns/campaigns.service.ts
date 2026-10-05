import type { AdDetail, AdStatus, PublishBlocker, ScheduleInput } from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { AuditTrail } from '../../common/audit/audit-trail.js';
import { AppError } from '../../common/errors/app-error.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { type AdRecord, findAdRecord, lockAndFindAdRecord, toAdDetail } from '../ads/ad-records.js';

const VERIFIED_UPLOAD_STATUSES: readonly AdStatus[] = ['PROCESSING', 'READY', 'NEEDS_REVIEW'];

/** The part of the ad each publish blocker points the station to. */
const PUBLISH_BLOCKER_FIELDS: Record<PublishBlocker, string> = {
  upload_not_verified: 'upload',
  action_card_missing: 'actionCard',
  schedule_missing: 'schedule',
  schedule_already_ended: 'schedule',
};

/** A schedule as the audit trail records it (the saved values, read back from the campaign). */
type RecordedSchedule = Omit<ScheduleInput, 'gracePeriodMinutes'> & { gracePeriodMinutes: number };

/** The schedule an ad's latest campaign had before this change, or null for its first schedule. */
function scheduleBefore(ad: AdRecord, campaignId: string | null): RecordedSchedule | null {
  if (!campaignId || ad.campaign_id !== campaignId || !ad.campaign_starts_on || !ad.campaign_ends_on) return null;
  return {
    startsOn: ad.campaign_starts_on,
    endsOn: ad.campaign_ends_on,
    engagementLimit: ad.campaign_engagement_limit,
    gracePeriodMinutes: ad.campaign_grace_period_minutes ?? 0,
    timeWindows: ad.campaign_time_windows ?? [],
  };
}

/**
 * When an ad airs (its campaign's dates and time windows) and making it live. In Step 2 an ad has
 * one campaign: saving a schedule creates it as a draft (or updates it); publishing makes it ACTIVE
 * with the ad's current card.
 */
@Injectable()
export class CampaignsService {
  constructor(
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly auditTrail: AuditTrail,
  ) {}

  /** Creates the ad's draft campaign from the schedule, or replaces the schedule of its current campaign. */
  putSchedule(adId: string, schedule: ScheduleInput): Promise<AdDetail> {
    return this.stationScopedTransaction.run(async (database) => {
      const ad = await lockAndFindAdRecord(database, adId);
      const [latestCampaign] = (await database.query(
        `SELECT id, status FROM app.campaigns WHERE ad_id = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [adId],
      )) as Array<{ id: string; status: string }>;
      // From the first day's midnight to the midnight after the last day, in the station's time zone.
      const activePeriod = `tstzrange(($1::date)::timestamp AT TIME ZONE station.time_zone,
                                      ($2::date + 1)::timestamp AT TIME ZONE station.time_zone, '[)')`;
      const periodParameters = [schedule.startsOn, schedule.endsOn, schedule.engagementLimit, schedule.gracePeriodMinutes];

      let campaignId: string;
      let previousSchedule: RecordedSchedule | null = null;
      if (!latestCampaign || latestCampaign.status === 'ENDED') {
        const [created] = (await database.query(
          `INSERT INTO app.campaigns (station_id, ad_id, name, status, active_period, engagement_limit, time_window_grace_period)
           SELECT station.id, $5, $6, 'DRAFT', ${activePeriod}, $3, make_interval(mins => $4)
             FROM app.stations AS station WHERE station.id = app.current_station_id()
           RETURNING id`,
          [...periodParameters, adId, ad.title],
        )) as Array<{ id: string }>;
        campaignId = (created as { id: string }).id;
      } else {
        campaignId = latestCampaign.id;
        previousSchedule = scheduleBefore(ad, campaignId);
        await database.query(
          `UPDATE app.campaigns AS campaign
              SET active_period = ${activePeriod}, engagement_limit = $3, time_window_grace_period = make_interval(mins => $4)
             FROM app.stations AS station
            WHERE campaign.id = $5 AND station.id = campaign.station_id`,
          [...periodParameters, campaignId],
        );
      }

      await database.query(`DELETE FROM app.campaign_time_windows WHERE campaign_id = $1`, [campaignId]);
      for (const timeWindow of schedule.timeWindows) {
        await database.query(
          `INSERT INTO app.campaign_time_windows (campaign_id, station_id, days_of_week, local_start_time, local_end_time)
           VALUES ($1, app.current_station_id(), $2::smallint[], $3::time, $4::time)`,
          [campaignId, [...timeWindow.daysOfWeek].sort((first, second) => first - second), timeWindow.localStartTime, timeWindow.localEndTime],
        );
      }
      // A schedule holds no personal data, so the trail keeps both versions in full.
      await this.auditTrail.record(database, {
        action: 'campaign_schedule_saved',
        entityType: 'campaign',
        entityId: campaignId,
        changes: { adId, previousSchedule, schedule },
      });
      return toAdDetail(await findAdRecord(database, adId));
    });
  }

  /**
   * Makes the ad's campaign live with its current card. Needs a verified upload, a card and a schedule
   * that hasn't already ended; otherwise the answer names each missing step. Publishing again (after
   * changing the card) is allowed and simply applies the current card.
   */
  async publish(adId: string): Promise<AdDetail> {
    try {
      return await this.stationScopedTransaction.run(async (database) => {
        const ad = await lockAndFindAdRecord(database, adId);
        const [campaign] = (await database.query(
          `SELECT campaign.id, campaign.status, campaign.action_card_id, upper(campaign.active_period) <= now() AS has_ended,
                  (SELECT count(*) FROM app.campaign_time_windows AS time_window WHERE time_window.campaign_id = campaign.id)::integer AS time_window_count
             FROM app.campaigns AS campaign
            WHERE campaign.ad_id = $1 AND campaign.status <> 'ENDED'
            ORDER BY campaign.created_at DESC LIMIT 1 FOR UPDATE`,
          [adId],
        )) as Array<{ id: string; status: string; action_card_id: string | null; has_ended: boolean; time_window_count: number }>;

        const blockers: PublishBlocker[] = [];
        if (!VERIFIED_UPLOAD_STATUSES.includes(ad.status)) blockers.push('upload_not_verified');
        if (!ad.current_action_card_id) blockers.push('action_card_missing');
        if (!campaign || campaign.time_window_count === 0) blockers.push('schedule_missing');
        else if (campaign.has_ended) blockers.push('schedule_already_ended');
        if (blockers.length > 0 || !campaign) {
          throw new AppError('AD_NOT_READY_TO_PUBLISH', {
            fields: blockers.map((blocker) => ({ path: PUBLISH_BLOCKER_FIELDS[blocker], code: blocker })),
            internalDetail: `publish blocked: ${blockers.join(', ')}`,
          });
        }

        await database.query(`UPDATE app.campaigns SET status = 'ACTIVE', action_card_id = $2 WHERE id = $1`, [
          campaign.id,
          ad.current_action_card_id,
        ]);
        await this.auditTrail.record(database, {
          action: 'campaign_published',
          entityType: 'campaign',
          entityId: campaign.id,
          changes: {
            adId,
            previousStatus: campaign.status,
            previousActionCardId: campaign.action_card_id,
            actionCardId: ad.current_action_card_id,
          },
        });
        return toAdDetail(await findAdRecord(database, adId));
      });
    } catch (error) {
      if (error instanceof QueryFailedError && (error.driverError as { code?: string }).code === '23P01') {
        throw new AppError('CONFLICT', {
          publicMessage: 'This ad already has a live campaign for these dates.',
          internalDetail: 'overlapping live campaign for the ad',
          cause: error,
        });
      }
      throw error;
    }
  }
}
