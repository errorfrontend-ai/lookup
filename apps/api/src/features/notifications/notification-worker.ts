import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { type Job, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { DerivedKeys } from '../../common/security/derived-keys.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { workerHeartbeatKey } from '../../infrastructure/job-queues/worker-heartbeat-key.js';
import { emailTextOf, smsTextOf } from './notification-messages.js';
import { NOTIFICATION_ATTEMPTS, NOTIFY_QUEUE_NAME, type NotificationJobData } from './notification-queue.js';
import { EMAIL_SENDER, SMS_SENDER, type EmailSender, type SmsSender } from './notification-senders.js';

/** Two sends at once per API instance; more instances add more (P5A-D9). */
const CONCURRENCY = 2;
const HEARTBEAT_EVERY_MILLISECONDS = 15_000;
const HEARTBEAT_LIFETIME_MILLISECONDS = 45_000;

/** The key that says a notify worker is alive, for System health: named like the fingerprint workers' keys. */
export function notifyWorkerHeartbeatKey(queueKeyPrefix: string): string {
  return workerHeartbeatKey(queueKeyPrefix, NOTIFY_QUEUE_NAME);
}

/**
 * A failed send for the log: its kind, the SMTP codes, and the stack without its first line. A mail server's message
 * can quote the recipient's address, so the message itself is never logged.
 */
export function describeSendFailure(error: Error): { errorName: string; errorCode?: string; responseCode?: number; stack?: string } {
  const { code, responseCode } = error as Error & { code?: unknown; responseCode?: unknown };
  return {
    errorName: error.name,
    ...(typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? { errorCode: code } : {}),
    ...(typeof responseCode === 'number' ? { responseCode } : {}),
    ...(error.stack ? { stack: error.stack.split('\n').slice(1).join('\n') } : {}),
  };
}

/**
 * What the queue keeps of a failed send (its failed reason, in Valkey): the sender's kind of error and codes only. The
 * sender's own error, which may quote the recipient, stays in memory for the log line.
 */
class SendFailure extends Error {
  readonly sendError: Error;

  constructor(problem: unknown) {
    const sendError = problem instanceof Error ? problem : new Error(String(problem));
    const { errorName, errorCode, responseCode } = describeSendFailure(sendError);
    super(`send failed: ${[errorName, errorCode, responseCode].filter((part) => part !== undefined).join(' ')}`);
    this.name = 'SendFailure';
    this.sendError = sendError;
  }
}

/**
 * Sends the notify queue's SMS and email from inside the API process (P5A-D9), when NOTIFICATION_SENDING_ENABLED.
 * A job past its deadline is dropped, not sent late (a phone code is useless after 10 minutes). A failed send is
 * thrown, so the queue tries it again; the last failure is logged as an error. Log lines name the recipient only by
 * its keyed hash and carry the request id that caused the message (P5A-NOTIFICATIONS-08).
 */
@Injectable()
export class NotificationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private connection: Redis | null = null;
  private worker: Worker<NotificationJobData> | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
    @Inject(SMS_SENDER) private readonly smsSender: SmsSender,
    private readonly derivedKeys: DerivedKeys,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('notifications');
  }

  onApplicationBootstrap(): void {
    if (!this.config.NOTIFICATION_SENDING_ENABLED) return;
    // BullMQ's blocking reads need a connection that never gives up on a command.
    const connection = new Redis(this.config.KEY_VALUE_STORE_URL, { maxRetriesPerRequest: null, connectTimeout: 3_000 });
    connection.on('error', (error) => this.logger.warn({ err: error }, 'notify worker connection problem'));
    this.connection = connection;
    this.worker = new Worker<NotificationJobData>(NOTIFY_QUEUE_NAME, (job) => this.send(job), {
      connection,
      prefix: this.config.QUEUE_KEY_PREFIX,
      concurrency: CONCURRENCY,
    });
    this.worker.on('error', (error) => this.logger.warn({ err: error }, 'notify worker problem'));
    this.worker.on('failed', (job, error) => {
      if (!job) return;
      const isGivenUp = job.attemptsMade >= NOTIFICATION_ATTEMPTS;
      const details = { ...this.describe(job), attempt: job.attemptsMade, failure: describeSendFailure(error instanceof SendFailure ? error.sendError : error) };
      if (isGivenUp) this.logger.error(details, 'notification not sent after every try');
      else this.logger.warn(details, 'notification send failed; it will be tried again');
    });
    const beat = () => {
      connection.set(notifyWorkerHeartbeatKey(this.config.QUEUE_KEY_PREFIX), String(Date.now()), 'PX', HEARTBEAT_LIFETIME_MILLISECONDS).catch(() => undefined);
    };
    beat();
    this.heartbeat = setInterval(beat, HEARTBEAT_EVERY_MILLISECONDS);
    this.heartbeat.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    await this.worker?.close().catch(() => undefined);
    await this.connection?.quit().catch(() => this.connection?.disconnect());
  }

  private async send(job: Job<NotificationJobData>): Promise<void> {
    const { channel, recipient, message, deadlineEpochMilliseconds } = job.data;
    if (Date.now() > deadlineEpochMilliseconds) {
      this.logger.warn(this.describe(job), 'notification dropped: past its deadline');
      return;
    }
    if (channel === 'sms') {
      const text = smsTextOf(message, this.config.PORTAL_PUBLIC_ORIGIN);
      if (text === null) throw new Error(`the ${message.template} template has no SMS`);
      await this.smsSender.send({ to: recipient, text, standInEmail: job.data.smsStandInEmail }).catch((error: unknown) => {
        throw new SendFailure(error);
      });
    } else {
      const email = emailTextOf(message, this.config.PORTAL_PUBLIC_ORIGIN);
      if (email === null) throw new Error(`the ${message.template} template has no email`);
      await this.emailSender.send({ to: recipient, ...email }).catch((error: unknown) => {
        throw new SendFailure(error);
      });
    }
    this.logger.info({ ...this.describe(job), attempt: job.attemptsMade + 1 }, 'notification sent');
  }

  private describe(job: Job<NotificationJobData>) {
    return {
      requestId: job.data.requestId,
      template: job.data.message.template,
      channel: job.data.channel,
      recipientHash: this.derivedKeys.hashIdentifier(job.data.recipient),
    };
  }
}
