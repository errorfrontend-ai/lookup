import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { type JobRun, repeatJob, runJob } from '../../infrastructure/scheduled-jobs/run-job.js';

const JOB_NAME = 'recognition-idempotency-key-clean-up';
/** A capture older than 24 hours is refused before any claim, so a key this old can never be needed again. */
export const IDEMPOTENCY_KEY_KEPT_FOR = '48 hours';
/** Keys deleted per call, and calls per run: a run never holds the table for long, and a big backlog takes a few days. */
export const IDEMPOTENCY_KEYS_PER_CALL = 1_000;
export const IDEMPOTENCY_KEY_CALLS_PER_RUN = 20;

/**
 * Deletes the recognition idempotency keys that can no longer matter (P4 design §5.12, P4-IDEMPOTENCY-19): daily,
 * through runJob, in batches of 1,000 until a call deletes fewer or 20 calls have run, logging the count. The
 * recognitions themselves stay. Several API instances running it at once is harmless: the database skips keys a
 * claim holds locked, and each delete is its own statement. RECOGNITION_IDEMPOTENCY_KEY_CLEAN_UP_INTERVAL_SECONDS
 * at 0 switches it off (tests run it by hand).
 */
@Injectable()
export class RecognitionIdempotencyKeyCleanUp implements OnApplicationBootstrap, OnApplicationShutdown {
  private stopRuns: (() => void) | undefined;

  constructor(
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly logger: PinoLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.logger.setContext(JOB_NAME);
  }

  onApplicationBootstrap(): void {
    const intervalSeconds = this.config.RECOGNITION_IDEMPOTENCY_KEY_CLEAN_UP_INTERVAL_SECONDS;
    if (intervalSeconds === 0) return;
    this.stopRuns = repeatJob(this.logger, JOB_NAME, intervalSeconds * 1000, (run) => this.deleteExpiredKeys(run));
  }

  onApplicationShutdown(): void {
    this.stopRuns?.();
  }

  /** One run now; resolves to how many keys went (0 when the run failed and was logged). */
  async runOnce(): Promise<number> {
    return (await runJob(this.logger, JOB_NAME, (run) => this.deleteExpiredKeys(run))) ?? 0;
  }

  private async deleteExpiredKeys(run: JobRun): Promise<number> {
    let deletedCount = 0;
    for (let call = 0; call < IDEMPOTENCY_KEY_CALLS_PER_RUN; call += 1) {
      // One transaction per batch, with no station in its context: the definer function needs none.
      const [result] = (await this.stationScopedTransaction.run((database) =>
        database.query('SELECT recognition.delete_expired_recognition_idempotency_keys($1::interval, $2) AS deleted_count', [
          IDEMPOTENCY_KEY_KEPT_FOR,
          IDEMPOTENCY_KEYS_PER_CALL,
        ]),
      )) as Array<{ deleted_count: number }>;
      const deletedNow = result?.deleted_count ?? 0;
      deletedCount += deletedNow;
      if (deletedNow < IDEMPOTENCY_KEYS_PER_CALL) break;
    }
    run.logger.info({ deletedCount }, 'deleted expired recognition idempotency keys');
    return deletedCount;
  }
}
