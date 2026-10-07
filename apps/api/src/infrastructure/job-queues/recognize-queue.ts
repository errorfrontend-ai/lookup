import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import {
  RECOGNIZE_JOB_FAILURE_CODES,
  RECOGNIZE_QUEUE_NAME,
  type RecognizeJobData,
  type RecognizeJobFailureCode,
  RecognizeJobResult,
} from '@lookup/contracts';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { KEY_VALUE_STORE } from '../key-value-store/key-value-store.module.js';
import { workerHeartbeatKey } from './worker-heartbeat-key.js';

/** The worker answered with a failure code. Anything not in the contract's list arrives as ENGINE_FAILED. */
export class RecognizeJobFailed extends Error {
  readonly code: RecognizeJobFailureCode;

  constructor(failedReason: string) {
    const code = (RECOGNIZE_JOB_FAILURE_CODES as readonly string[]).includes(failedReason) ? (failedReason as RecognizeJobFailureCode) : 'ENGINE_FAILED';
    super(`recognize job failed: ${code}`);
    this.name = 'RecognizeJobFailed';
    this.code = code;
  }
}

/** The wait ended with no answer; the job's deadline makes the worker drop it unread. */
export class RecognizeWaitTimedOut extends Error {
  constructor(waitMilliseconds: number) {
    super(`no answer from a recognize worker within ${waitMilliseconds} ms`);
    this.name = 'RecognizeWaitTimedOut';
  }
}

export interface RecognizeAdmissionState {
  waitingJobCount: number;
  isWorkerAlive: boolean;
}

const ADMISSION_REFRESH_MILLISECONDS = 1_000;

/**
 * The `recognize` queue as the API uses it: add a clip and wait for its answer, and know cheaply
 * whether to try at all. The answer is awaited through a listener on one long-lived QueueEvents that
 * is registered BEFORE the job is added, because a fast job with removeOnComplete can finish and vanish
 * before job.waitUntilFinished would subscribe (S3-D3). The queue depth and the worker heartbeat are
 * read at most once a second in the background, never on the request path (S3-ADMISSION-03).
 */
@Injectable()
export class RecognizeQueue implements OnModuleInit, OnApplicationShutdown {
  private readonly queueConnection: Redis;
  private readonly eventsConnection: Redis;
  private readonly queue: Queue;
  private readonly events: QueueEvents;
  private readonly heartbeatKey: string;
  private admission: RecognizeAdmissionState = { waitingJobCount: 0, isWorkerAlive: false };
  private refreshTimer: NodeJS.Timeout | undefined;
  private wasStoreReachable = true;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(KEY_VALUE_STORE) private readonly keyValueStore: Redis,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('recognize-queue');
    // Fail fast when Valkey is away (the request is answered busy) rather than queueing the command.
    this.queueConnection = new Redis(config.KEY_VALUE_STORE_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 3_000 });
    // QueueEvents blocks on a stream read, which needs no retry limit.
    this.eventsConnection = new Redis(config.KEY_VALUE_STORE_URL, { maxRetriesPerRequest: null });
    for (const connection of [this.queueConnection, this.eventsConnection]) {
      connection.on('error', (error) => this.logger.warn({ err: error }, 'recognize queue connection problem'));
    }
    this.queue = new Queue(RECOGNIZE_QUEUE_NAME, { connection: this.queueConnection, prefix: config.QUEUE_KEY_PREFIX });
    this.events = new QueueEvents(RECOGNIZE_QUEUE_NAME, { connection: this.eventsConnection, prefix: config.QUEUE_KEY_PREFIX });
    this.queue.on('error', (error) => this.logger.warn({ err: error }, 'recognize queue problem'));
    this.events.on('error', (error) => this.logger.warn({ err: error }, 'recognize queue events problem'));
    this.events.setMaxListeners(0);
    this.heartbeatKey = workerHeartbeatKey(config.QUEUE_KEY_PREFIX, RECOGNIZE_QUEUE_NAME);
  }

  async onModuleInit(): Promise<void> {
    // Listen before taking any clip: an answer that came before the listener started would be missed.
    await this.events.waitUntilReady().catch((error: unknown) => this.logger.warn({ err: error }, 'recognize queue events are not ready yet'));
    await this.refreshAdmission();
    this.refreshTimer = setInterval(() => void this.refreshAdmission(), ADMISSION_REFRESH_MILLISECONDS);
    this.refreshTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.refreshTimer);
    await Promise.allSettled([this.events.close(), this.queue.close()]);
    for (const connection of [this.eventsConnection, this.queueConnection]) await connection.quit().catch(() => connection.disconnect());
  }

  /** The last background reading: how many clips are waiting, and whether a worker's heartbeat exists. */
  admissionState(): RecognizeAdmissionState {
    return this.admission;
  }

  /** Reads the depth and the heartbeat now. Called every second; tests call it to skip the wait. */
  async refreshAdmission(): Promise<void> {
    try {
      const [waitingJobCount, heartbeatCount] = await Promise.all([this.queue.getWaitingCount(), this.keyValueStore.exists(this.heartbeatKey)]);
      this.admission = { waitingJobCount, isWorkerAlive: heartbeatCount === 1 };
      if (!this.wasStoreReachable) this.logger.info('the recognize queue can be read again');
      this.wasStoreReachable = true;
    } catch (error) {
      this.admission = { waitingJobCount: 0, isWorkerAlive: false };
      if (this.wasStoreReachable) this.logger.warn({ err: error }, 'the recognize queue cannot be read; recognitions are refused as busy');
      this.wasStoreReachable = false;
    }
  }

  /** Adds one clip (tried once, removed as soon as it is done) and waits at most `waitMilliseconds` for its answer. */
  addAndWait(jobId: string, data: RecognizeJobData, waitMilliseconds: number): Promise<RecognizeJobResult> {
    return new Promise<RecognizeJobResult>((resolve, reject) => {
      // QueueEvents also emits each event under the job's own name; its types list only the shared names.
      const jobEvents = this.events as unknown as NodeJS.EventEmitter;
      const stopListening = () => {
        clearTimeout(timer);
        jobEvents.off(`completed:${jobId}`, onCompleted);
        jobEvents.off(`failed:${jobId}`, onFailed);
      };
      const onCompleted = (event: { returnvalue: unknown }) => {
        stopListening();
        const parsed = RecognizeJobResult.safeParse(event.returnvalue);
        if (parsed.success) resolve(parsed.data);
        else reject(new RecognizeJobFailed('ENGINE_FAILED'));
      };
      const onFailed = (event: { failedReason: string }) => {
        stopListening();
        reject(new RecognizeJobFailed(event.failedReason));
      };
      const timer = setTimeout(() => {
        stopListening();
        // Nobody waits for this clip any more: take it (and its audio) out of Valkey now if no worker
        // has started on it. One that has started drops it by its deadline and is removed when done.
        this.queue.remove(jobId).catch(() => undefined);
        reject(new RecognizeWaitTimedOut(waitMilliseconds));
      }, waitMilliseconds);
      jobEvents.on(`completed:${jobId}`, onCompleted);
      jobEvents.on(`failed:${jobId}`, onFailed);

      this.queue
        .add(RECOGNIZE_QUEUE_NAME, data, { jobId, attempts: 1, removeOnComplete: true, removeOnFail: true })
        .catch((error: unknown) => {
          stopListening();
          reject(error);
        });
    });
  }
}
