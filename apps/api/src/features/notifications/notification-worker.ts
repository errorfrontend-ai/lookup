import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { type Job, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { DerivedKeys } from '../../common/security/derived-keys.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { workerHeartbeatKey } from '../../infrastructure/job-queues/worker-heartbeat-key.js';
import { emailTextOf, pushNoticeOf, smsTextOf } from './notification-messages.js';
import { NOTIFICATION_ATTEMPTS, NOTIFY_QUEUE_NAME, type NotificationJobData } from './notification-queue.js';
import { EMAIL_SENDER, SMS_SENDER, type EmailSender, type SmsSender } from './notification-senders.js';
import { PUSH_SENDER, type PushSender } from './web-push.js';

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
    @Inject(PUSH_SENDER) private readonly pushSender: PushSender,
    private readonly stationScopedTransaction: StationScopedTransaction,
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
    if (channel === 'push') {
      await this.sendPush(job);
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


  /**
   * One notice to every device of the person (ADR-006): a device the push service no longer knows is forgotten, a sent
   * one noted. The job is tried again only when no device took it, so a phone that did never gets it twice.
   */
  private async sendPush(job: Job<NotificationJobData>): Promise<void> {
    const push = pushNoticeOf(job.data.message);
    if (push === null) throw new Error(`the ${job.data.message.template} template has no push notice`);
    // No station in the transaction's context: the definer functions need none, and nothing else is reachable.
    const devices = (await this.stationScopedTransaction.run((database) => database.query('SELECT * FROM app.list_web_push_subscriptions_of($1)', [job.data.recipient]))) as Array<{
      endpoint: string;
      endpoint_hash: Buffer;
      receiver_public_key: string;
      authentication_secret: string;
    }>;
    let sent = 0;
    let gone = 0;
    let lastFailure: unknown = null;
    for (const device of devices) {
      try {
        const outcome = await this.pushSender.send({ endpoint: device.endpoint, receiverPublicKey: device.receiver_public_key, authenticationSecret: device.authentication_secret }, push.notice, push.ttlSeconds);
        if (outcome === 'GONE') {
          gone += 1;
          await this.stationScopedTransaction.run((database) => database.query('SELECT app.forget_web_push_subscription($1)', [device.endpoint_hash]));
        } else {
          sent += 1;
          await this.stationScopedTransaction.run((database) => database.query('SELECT app.note_web_push_sent($1)', [device.endpoint_hash]));
        }
      } catch (problem) {
        lastFailure = problem;
      }
    }
    this.logger.info({ ...this.describe(job), attempt: job.attemptsMade + 1, devices: devices.length, sent, gone, failed: devices.length - sent - gone }, 'push notice sent');
    if (sent === 0 && lastFailure !== null) throw new SendFailure(lastFailure);
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
