import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { type JobRun, repeatJob, runJob } from '../../infrastructure/scheduled-jobs/run-job.js';
import type { NotificationMessage } from '../notifications/notification-messages.js';
import { NotificationQueue } from '../notifications/notification-queue.js';
import { PUSH_SENDER, type PushSender } from '../notifications/web-push.js';

const JOB_NAME = 'air-time-reminders';
/** A sent reminder is remembered this long (so it is sent once), then forgotten. */
export const SENT_REMINDERS_KEPT_FOR = '30 days';
const CLEAN_UP_EVERY_MILLISECONDS = 60 * 60_000;

interface DueReminder {
  portal_user_id: string;
  email: string;
  campaign_time_window_id: string;
  slot_starts_at: Date;
  local_date: string;
  local_start_time: string;
  local_end_time: string;
  is_today: boolean;
  station_id: string;
  station_name: string | null;
  station_frequency_label: string | null;
  ad_id: string;
  ad_title: string;
  client_name: string;
  is_push_on: boolean;
  is_email_on: boolean;
}

/** What one run did: the reminders due, and those this run claimed and queued. */
export interface AirTimeReminderRun {
  due: number;
  queued: number;
}

/**
 * Reminders before each slot of a client's adverts (ADR-006 decision 6; P5C-NOTIFY-04): every minute, the slots whose
 * reminder time has come ("slot start − lead time", before the slot starts), worked out by the database in each
 * station's time zone. Each reminder is claimed in the database before it is queued, so a second run, or a second API
 * instance, never sends it again. A reminder whose queueing fails stays claimed: once is the promise, not at least once.
 * AIR_TIME_REMINDER_INTERVAL_SECONDS at 0 switches it off (tests run it by hand).
 */
@Injectable()
export class AirTimeReminders implements OnApplicationBootstrap, OnApplicationShutdown {
  private stopRuns: (() => void) | undefined;
  private lastCleanUpAt = 0;

  constructor(
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly notificationQueue: NotificationQueue,
    @Inject(PUSH_SENDER) private readonly pushSender: PushSender,
    private readonly logger: PinoLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.logger.setContext(JOB_NAME);
  }

  onApplicationBootstrap(): void {
    const intervalSeconds = this.config.AIR_TIME_REMINDER_INTERVAL_SECONDS;
    if (intervalSeconds === 0) return;
    this.stopRuns = repeatJob(this.logger, JOB_NAME, intervalSeconds * 1000, (run) => this.sendDueReminders(run, new Date()));
  }

  onApplicationShutdown(): void {
    this.stopRuns?.();
  }

  /** One run at [now]; resolves to what it did (nothing when the run failed and was logged). */
  async runOnce(now: Date = new Date()): Promise<AirTimeReminderRun> {
    return (await runJob(this.logger, JOB_NAME, (run) => this.sendDueReminders(run, now))) ?? { due: 0, queued: 0 };
  }

  private async sendDueReminders(run: JobRun, now: Date): Promise<AirTimeReminderRun> {
    const due = (await this.stationScopedTransaction.run((database) => database.query('SELECT * FROM app.list_due_air_time_reminders($1)', [now]))) as DueReminder[];
    let queued = 0;
    for (const reminder of due) {
      const [claim] = (await this.stationScopedTransaction.run((database) =>
        database.query('SELECT app.claim_air_time_reminder($1, $2, $3) AS is_claimed', [reminder.portal_user_id, reminder.campaign_time_window_id, reminder.slot_starts_at]),
      )) as Array<{ is_claimed: boolean }>;
      if (!claim?.is_claimed) continue;
      const message: NotificationMessage = {
        template: 'air_time_reminder',
        stationId: reminder.station_id,
        adId: reminder.ad_id,
        adTitle: reminder.ad_title,
        stationName: reminder.station_name,
        frequencyLabel: reminder.station_frequency_label,
        localStartTime: reminder.local_start_time,
        localEndTime: reminder.local_end_time,
        isToday: reminder.is_today,
        slotTag: `air-time-${reminder.campaign_time_window_id}-${reminder.local_date}`,
        slotStartsAtEpochMilliseconds: reminder.slot_starts_at.getTime(),
      };
      try {
        if (reminder.is_push_on && this.pushSender.publicKey !== null) await this.notificationQueue.enqueue('push', reminder.portal_user_id, message, run.requestId);
        if (reminder.is_email_on) await this.notificationQueue.enqueue('email', reminder.email, message, run.requestId);
        queued += 1;
      } catch (problem) {
        run.logger.error({ err: problem, campaignTimeWindowId: reminder.campaign_time_window_id }, 'an air-time reminder could not be queued');
      }
    }
    if (due.length > 0) run.logger.info({ due: due.length, queued }, 'air-time reminders queued');
    if (now.getTime() - this.lastCleanUpAt >= CLEAN_UP_EVERY_MILLISECONDS) {
      this.lastCleanUpAt = now.getTime();
      const [cleaned] = (await this.stationScopedTransaction.run((database) =>
        database.query('SELECT app.delete_old_air_time_reminders($1::interval) AS deleted_count', [SENT_REMINDERS_KEPT_FOR]),
      )) as Array<{ deleted_count: number }>;
      if ((cleaned?.deleted_count ?? 0) > 0) run.logger.info({ deletedCount: cleaned?.deleted_count }, 'old air-time reminders forgotten');
    }
    return { due: due.length, queued };
  }
}
