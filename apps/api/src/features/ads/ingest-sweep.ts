import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { IngestQueue } from '../../infrastructure/job-queues/ingest-queue.js';
import { KEY_VALUE_STORE } from '../../infrastructure/key-value-store/key-value-store.module.js';

/** An ad waiting this long for its fingerprints with no job is given one again. */
const WAITED_BEFORE_SWEEP = '5 minutes';
const ADS_PER_SWEEP = 50;
const ADS_LOOKED_AT_PER_SWEEP = 500;
/** An ad the sweep has re-queued waits this long before it is re-queued again, so ads that keep failing never crowd out the rest. */
const SWEEP_COOLDOWN_SECONDS = 15 * 60;
/** Re-queued this many times (in a week) and still waiting: logged as an error, for someone to look at. */
const SWEEPS_BEFORE_ALERT = 12;

/**
 * Re-adds ingest jobs for ads that have waited in PROCESSING with none: ads Step 2 left there, ads
 * whose job could not be added while Valkey was away, and ads whose retries ran out on a temporary
 * failure (S3-D4). Each gets a fresh download address. Runs every INGEST_SWEEP_INTERVAL_SECONDS
 * (0 switches it off), each run with its own request id for the logs.
 */
@Injectable()
export class IngestSweep implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private isRunning = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(KEY_VALUE_STORE) private readonly keyValueStore: Redis,
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly ingestQueue: IngestQueue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('ingest-sweep');
  }

  onModuleInit(): void {
    if (this.config.INGEST_SWEEP_INTERVAL_SECONDS === 0) return;
    this.timer = setInterval(() => void this.run(), this.config.INGEST_SWEEP_INTERVAL_SECONDS * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** One sweep. Returns the ads given a job. */
  async run(waited = WAITED_BEFORE_SWEEP): Promise<string[]> {
    if (this.isRunning) return [];
    this.isRunning = true;
    const requestId = `ingest-sweep-${randomUUID()}`;
    try {
      const waiting = (await this.stationScopedTransaction.run((database) =>
        database.query('SELECT ad_id, upload_object_key FROM app.find_ads_waiting_for_ingest($1::interval, $2)', [waited, ADS_LOOKED_AT_PER_SWEEP]),
      )) as Array<{ ad_id: string; upload_object_key: string }>;
      const queued: string[] = [];
      const prefix = this.config.QUEUE_KEY_PREFIX;
      for (const ad of waiting) {
        if (queued.length >= ADS_PER_SWEEP) break;
        if (await this.ingestQueue.hasJobFor(ad.ad_id)) continue;
        // At most once per cooldown per ad: oldest first would otherwise re-queue the same failing ads every minute.
        const isDue = await this.keyValueStore.set(`${prefix}:ingest-sweep-cooldown:${ad.ad_id}`, '1', 'EX', SWEEP_COOLDOWN_SECONDS, 'NX');
        if (isDue !== 'OK') continue;
        await this.ingestQueue.enqueue(ad.ad_id, ad.upload_object_key, requestId);
        queued.push(ad.ad_id);
        const sweepCountKey = `${prefix}:ingest-sweep-count:${ad.ad_id}`;
        const sweepCount = await this.keyValueStore.incr(sweepCountKey);
        await this.keyValueStore.expire(sweepCountKey, 7 * 24 * 60 * 60);
        if (sweepCount >= SWEEPS_BEFORE_ALERT) {
          this.logger.error({ requestId, adId: ad.ad_id, sweepCount }, 'an ad keeps failing to be prepared for recognition; its upload or the ingest worker needs looking at');
        }
      }
      if (queued.length > 0) this.logger.info({ requestId, adCount: queued.length }, 'ingest jobs added again for ads that were waiting');
      return queued;
    } catch (error) {
      this.logger.error({ requestId, err: error }, 'the ingest sweep failed; it runs again next interval');
      return [];
    } finally {
      this.isRunning = false;
    }
  }
}
