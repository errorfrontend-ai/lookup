import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { PinoLogger } from 'nestjs-pino';
import type { DataSource } from 'typeorm';
import { type JobRun, repeatJob, runJob } from '../scheduled-jobs/run-job.js';

/** How many months of partitions to keep ready beyond the current one. */
export const PARTITION_MONTHS_AHEAD = 3;
const ONE_DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const JOB_NAME = 'listener-traffic-partitions';

/**
 * Keeps the monthly partitions of the tables that grow with listener traffic (recognition_events,
 * recognition_candidates, engagement_events) in place for the coming months: once when the API starts and then
 * daily, each run through runJob (P4 design §5.12). If a month had no partition, its rows would land in the
 * default partition, and the month's partition could then no longer be created. Each run is idempotent, so
 * several API instances running it is harmless; a failed run is logged and the next one still happens.
 */
@Injectable()
export class ListenerTrafficPartitions implements OnApplicationBootstrap, OnApplicationShutdown {
  private stopDailyRuns: (() => void) | undefined;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(JOB_NAME);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.topUp();
    this.stopDailyRuns = repeatJob(this.logger, JOB_NAME, ONE_DAY_MILLISECONDS, (run) => this.createMissingPartitions(run));
  }

  onApplicationShutdown(): void {
    this.stopDailyRuns?.();
  }

  /** Creates any missing partitions now; resolves to how many were made (0 when the run failed and was logged). */
  async topUp(): Promise<number> {
    return (await runJob(this.logger, JOB_NAME, (run) => this.createMissingPartitions(run))) ?? 0;
  }

  private async createMissingPartitions(run: JobRun): Promise<number> {
    const [result] = (await this.dataSource.query('SELECT app.create_listener_traffic_partitions($1) AS created_count', [PARTITION_MONTHS_AHEAD])) as Array<{
      created_count: number;
    }>;
    const createdCount = result?.created_count ?? 0;
    if (createdCount > 0) run.logger.info({ createdCount }, 'created listener traffic partitions');
    return createdCount;
  }
}
