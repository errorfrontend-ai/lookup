import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { AppError } from '../../common/errors/app-error.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import type { NotificationMessage } from './notification-messages.js';

export const NOTIFY_QUEUE_NAME = 'notify';
/** Five tries in all, the waits growing from NOTIFICATION_RETRY_DELAY_MILLISECONDS (30 s by default). */
export const NOTIFICATION_ATTEMPTS = 5;
/** A phone code is useless once it has expired; everything else is still worth sending a day later. */
const PHONE_CODE_DEADLINE_MILLISECONDS = 10 * 60_000;
const OTHER_DEADLINE_MILLISECONDS = 24 * 60 * 60_000;

export type NotificationChannel = 'sms' | 'email';

/** One notify job: who, what, and until when it is worth sending; the request that caused it, for the log. */
export interface NotificationJobData {
  channel: NotificationChannel;
  /** An E.164 number or an email address; the job is removed once sent or given up. */
  recipient: string;
  /** For an SMS: the email of the person it is for, used only when SMS_SENDER is `email-stand-in`. */
  smsStandInEmail?: string;
  message: NotificationMessage;
  requestId: string;
  deadlineEpochMilliseconds: number;
}

/**
 * The `notify` queue (P5A design §3.1, P5A-D9, P5A-NOTIFICATIONS-01, -10): SMS and email leave the request path, are
 * retried with growing waits, and every job is removed when it is sent or given up, so no phone number or email
 * stays in Valkey. A message that cannot be queued fails the request (SERVICE_UNAVAILABLE): a step that promised a
 * code never says it sent one when it did not.
 */
@Injectable()
export class NotificationQueue implements OnApplicationShutdown {
  private readonly connection: Redis;
  private readonly queue: Queue<NotificationJobData>;
  private readonly retryDelayMilliseconds: number;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('notifications');
    this.connection = new Redis(config.KEY_VALUE_STORE_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 3_000 });
    this.connection.on('error', (error) => this.logger.warn({ err: error }, 'notify queue connection problem'));
    this.queue = new Queue<NotificationJobData>(NOTIFY_QUEUE_NAME, { connection: this.connection, prefix: config.QUEUE_KEY_PREFIX });
    this.queue.on('error', (error) => this.logger.warn({ err: error }, 'notify queue problem'));
    this.retryDelayMilliseconds = config.NOTIFICATION_RETRY_DELAY_MILLISECONDS;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    await this.connection.quit().catch(() => this.connection.disconnect());
  }

  /**
   * Queues one message. An SMS names the email of the person it is for (`smsStandInEmail`) whenever the caller knows
   * it, so the showcase's stand-in can email it to them; any other sender ignores it.
   */
  async enqueue(
    channel: NotificationChannel,
    recipient: string,
    message: NotificationMessage,
    requestId: string,
    options: { smsStandInEmail?: string | null } = {},
  ): Promise<void> {
    const deadline = Date.now() + (message.template === 'phone_verification_code' ? PHONE_CODE_DEADLINE_MILLISECONDS : OTHER_DEADLINE_MILLISECONDS);
    const standIn = channel === 'sms' && options.smsStandInEmail ? { smsStandInEmail: options.smsStandInEmail } : {};
    try {
      await this.queue.add(message.template, { channel, recipient, ...standIn, message, requestId, deadlineEpochMilliseconds: deadline }, {
        attempts: NOTIFICATION_ATTEMPTS,
        backoff: { type: 'exponential', delay: this.retryDelayMilliseconds },
        removeOnComplete: true,
        removeOnFail: true,
      });
    } catch (problem) {
      throw new AppError('SERVICE_UNAVAILABLE', { internalDetail: `could not queue the ${message.template} ${channel}`, cause: problem });
    }
  }

  /** How many notifications wait or are being sent, for System health. */
  async countWaiting(): Promise<number> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
    return Object.values(counts).reduce((total, count) => total + count, 0);
  }
}
