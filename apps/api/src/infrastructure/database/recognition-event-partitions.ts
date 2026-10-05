import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { PinoLogger } from 'nestjs-pino';
import type { DataSource } from 'typeorm';

/** How many months of partitions to keep ready beyond the current one. */
export const PARTITION_MONTHS_AHEAD = 3;
const ONE_DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/**
 * Keeps recognition_events partitions in place for the coming months: once when the API starts and
 * then daily. If a month had no partition, its events would land in the default partition, and the
 * month's partition could then no longer be created. Each run is idempotent, so several API
 * instances running it is harmless.
 */
@Injectable()
export class RecognitionEventPartitions implements OnApplicationBootstrap, OnApplicationShutdown {
  private dailyTimer: NodeJS.Timeout | undefined;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('recognition-event-partitions');
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.topUp();
    this.dailyTimer = setInterval(() => void this.topUp(), ONE_DAY_MILLISECONDS);
    this.dailyTimer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.dailyTimer);
  }

  /** Creates any missing partitions; a failure is logged and retried on the next run, never thrown. */
  async topUp(): Promise<number> {
    try {
      const [result] = (await this.dataSource.query('SELECT app.create_recognition_event_partitions($1) AS created_count', [
        PARTITION_MONTHS_AHEAD,
      ])) as Array<{ created_count: number }>;
      const createdCount = result?.created_count ?? 0;
      if (createdCount > 0) this.logger.info({ createdCount }, 'created recognition event partitions');
      return createdCount;
    } catch (error) {
      this.logger.error({ err: error }, 'could not create recognition event partitions; will retry');
      return 0;
    }
  }
}
