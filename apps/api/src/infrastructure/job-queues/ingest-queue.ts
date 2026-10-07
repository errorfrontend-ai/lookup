import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { INGEST_QUEUE_NAME, type IngestJobData } from '@lookup/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { ObjectStorage } from '../object-storage/object-storage.js';

/** How long an ingest job's download address and deadline last; the sweep makes fresh ones after. */
export const INGEST_JOB_LIFETIME_SECONDS = 30 * 60;

/**
 * The `ingest` queue: one job per ad (its id is `ingest-<ad id>`, so an ad never waits twice), tried
 * three times with a growing delay, removed as soon as it is done so its download address does not
 * linger. The address is signed for the internal storage endpoint the workers reach; the workers hold
 * no storage credentials (S3-D4, S3-D5).
 */
@Injectable()
export class IngestQueue implements OnApplicationShutdown {
  private readonly connection: Redis;
  private readonly queue: Queue;
  private readonly fingerprintVersion: number;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly objectStorage: ObjectStorage,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('ingest-queue');
    this.connection = new Redis(config.KEY_VALUE_STORE_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 3_000 });
    this.connection.on('error', (error) => this.logger.warn({ err: error }, 'ingest queue connection problem'));
    this.queue = new Queue(INGEST_QUEUE_NAME, { connection: this.connection, prefix: config.QUEUE_KEY_PREFIX });
    this.queue.on('error', (error) => this.logger.warn({ err: error }, 'ingest queue problem'));
    this.fingerprintVersion = config.FINGERPRINT_VERSION;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    await this.connection.quit().catch(() => this.connection.disconnect());
  }

  static jobIdFor(adId: string): string {
    return `ingest-${adId}`;
  }

  /** Whether the ad already has a job waiting, running or about to be retried. */
  async hasJobFor(adId: string): Promise<boolean> {
    return (await this.queue.getJob(IngestQueue.jobIdFor(adId))) !== undefined;
  }

  async enqueue(adId: string, uploadObjectKey: string, requestId: string): Promise<void> {
    const data: IngestJobData = {
      request_id: requestId,
      ad_id: adId,
      download_address: await this.objectStorage.createWorkerDownloadUrl(uploadObjectKey, INGEST_JOB_LIFETIME_SECONDS),
      deadline_epoch_milliseconds: Date.now() + INGEST_JOB_LIFETIME_SECONDS * 1000,
      fingerprint_version: this.fingerprintVersion,
    };
    await this.queue.add(INGEST_QUEUE_NAME, data, {
      jobId: IngestQueue.jobIdFor(adId),
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }
}
