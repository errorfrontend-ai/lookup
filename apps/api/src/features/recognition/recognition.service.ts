import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { RecognizeJobData, RecognizeJobResult, RecognizeRequestFields, RecognizeResponse } from '@lookup/contracts';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import type CircuitBreaker from 'opossum';
import { AppError } from '../../common/errors/app-error.js';
import { uuidVersion7 } from '../../common/identifiers/uuid-version-7.js';
import { LISTENER_INSTALL_ID } from '../../common/listener-authentication/install-token.guard.js';
import type { RateLimitRule } from '../../common/rate-limiting/rate-limit-rule.js';
import { RateLimiter } from '../../common/rate-limiting/rate-limiter.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { RecognizeJobFailed, RecognizeQueue, RecognizeWaitTimedOut } from '../../infrastructure/job-queues/recognize-queue.js';
import { assertClipSignature, correctCaptureTime } from './clip-checks.js';
import { type AnswerBasics, answerNoMatch, answerReplay, answerResolution } from './recognition-answers.js';
import { createRecognitionBreaker } from './recognition-breaker.js';
import { type Claim, type FinishedRecognition, RecognitionRecords } from './recognition-records.js';
import { resolveStation } from './resolve-station.js';

export const BUSY_RETRY_AFTER_SECONDS = 10;
export const TIMEOUT_RETRY_AFTER_SECONDS = 5;
const IN_PROGRESS_RETRY_AFTER_SECONDS = 3;

type AdmissionRefusal = 'no_worker_heartbeat' | 'queue_too_deep' | 'breaker_open';

/** Records the attempt's outcome; the hint, the latency and the fingerprint version are added for every outcome. */
type FinishAttempt = (finished: Omit<FinishedRecognition, 'latencyMilliseconds' | 'fingerprintVersion' | 'hintedStationId'>) => Promise<void>;

/**
 * The Recognition Supervisor (blueprint): for one clip, after the install token and the body have
 * been checked, it checks the clip, claims the idempotency key, decides whether to try at all
 * (admission), sends the clip to a worker through the circuit breaker and waits, resolves whose
 * buttons the matched recording gets (resolveStation, P4 design §5.1), records the outcome with the
 * stations it weighed and answers in the contract's shape. Every refusal has a catalogue code, and
 * every attempt that was claimed is finished with an outcome, so none is left PENDING.
 */
@Injectable()
export class RecognitionService {
  private readonly breaker: CircuitBreaker<[string, RecognizeJobData], RecognizeJobResult>;
  private readonly perMinuteRule: RateLimitRule;
  private readonly perDayRule: RateLimitRule;
  private readonly perAddressRule: RateLimitRule;
  private recognitionsInFlight = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly recognizeQueue: RecognizeQueue,
    private readonly records: RecognitionRecords,
    private readonly rateLimiter: RateLimiter,
    private readonly requestContext: ClsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('recognition');
    this.perMinuteRule = { counterName: 'recognitions-per-install-minute', maximumRequests: config.RECOGNITIONS_PER_INSTALL_PER_MINUTE, windowSeconds: 60 };
    this.perDayRule = { counterName: 'recognitions-per-install-day', maximumRequests: config.RECOGNITIONS_PER_INSTALL_PER_DAY, windowSeconds: 24 * 60 * 60 };
    this.perAddressRule = { counterName: 'recognitions-per-address', maximumRequests: config.RECOGNITIONS_PER_CLIENT_ADDRESS_PER_MINUTE, windowSeconds: 60 };
    // The add-and-wait runs inside the breaker, so timeouts and worker failures count against it (S3-ADMISSION-08).
    this.breaker = createRecognitionBreaker((jobId: string, data: RecognizeJobData) =>
      recognizeQueue.addAndWait(jobId, data, config.RECOGNITION_WAIT_MILLISECONDS),
    );
    this.breaker.on('open', () => this.logger.warn('the recognition breaker opened: clips are refused as busy until a trial succeeds'));
    this.breaker.on('halfOpen', () => this.logger.info('the recognition breaker is letting one trial clip through'));
    this.breaker.on('close', () => this.logger.info('the recognition breaker closed'));
  }

  /** Recognitions in progress on this instance, reading their clips included. */
  get inFlightCount(): number {
    return this.recognitionsInFlight;
  }

  /** The circuit breaker, for tests of its own behaviour. */
  get circuitBreaker(): CircuitBreaker<[string, RecognizeJobData], RecognizeJobResult> {
    return this.breaker;
  }

  /**
   * Before the body is read: per install (S3-RATELIMIT-01), and per address too, because installs cost
   * nothing to make, so one sender with many installs must not fill the queue for everyone.
   */
  async countAgainstLimits(clientAddress: string, response: Response): Promise<void> {
    const listenerInstallId = this.requestContext.get<string>(LISTENER_INSTALL_ID);
    await this.rateLimiter.countRequest(this.perMinuteRule, listenerInstallId, response);
    await this.rateLimiter.countRequest(this.perDayRule, listenerInstallId, response);
    await this.rateLimiter.countRequest(this.perAddressRule, clientAddress, response);
  }

  /**
   * One more recognition in progress on this instance, reading its clip included; refused at once past
   * the limit, so the clips held in memory stay bounded. The caller must call the returned release.
   */
  startRecognition(response: Response): () => void {
    if (this.recognitionsInFlight >= this.config.RECOGNITIONS_IN_FLIGHT_LIMIT) {
      this.logger.warn({ requestId: this.requestContext.getId(), cause: 'too_many_in_flight' }, 'recognition refused: busy');
      response.setHeader('Retry-After', String(BUSY_RETRY_AFTER_SECONDS));
      throw new AppError('RECOGNITION_BUSY', { internalDetail: 'admission refused: too_many_in_flight' });
    }
    this.recognitionsInFlight += 1;
    let isReleased = false;
    return () => {
      if (isReleased) return;
      isReleased = true;
      this.recognitionsInFlight -= 1;
    };
  }

  async recognize(fields: RecognizeRequestFields, audio: Buffer, receivedAt: Date, response: Response): Promise<RecognizeResponse> {
    const listenerInstallId = this.requestContext.get<string>(LISTENER_INSTALL_ID);
    const requestId = this.requestContext.getId();
    assertClipSignature(audio, fields.codec);
    const time = correctCaptureTime({
      capturedAt: new Date(fields.captured_at),
      sentAt: new Date(fields.sent_at),
      receivedAt,
      isDeferredByApp: fields.is_deferred,
    });

    const claim = await this.records.claim({
      listenerInstallId,
      idempotencyKey: fields.idempotency_key,
      newRecognitionId: uuidVersion7(),
      requestId,
      effectiveCapturedAt: time.effectiveCapturedAt,
      clientCapturedAt: new Date(fields.captured_at),
      clockSkewMilliseconds: time.clockSkewMilliseconds,
      receivedAt,
      isDeferred: time.isDeferred,
      clipDurationMilliseconds: fields.clip_duration_milliseconds,
    });
    const hasStationHint = fields.station_hint !== undefined;
    if (claim.claimOutcome === 'IN_PROGRESS') {
      response.setHeader('Retry-After', String(IN_PROGRESS_RETRY_AFTER_SECONDS));
      throw new AppError('RECOGNITION_IN_PROGRESS', { internalDetail: `recognition ${claim.recognitionId} is still being worked on` });
    }
    if (claim.claimOutcome === 'FINISHED') return this.replay(claim, listenerInstallId, requestId, hasStationHint);

    let isFinished = false;
    const finish: FinishAttempt = async (finished) => {
      const isRecorded = await this.records.finish(claim, {
        ...finished,
        // The listener's "My station" goes with every outcome; the database keeps it only when the station exists.
        hintedStationId: fields.station_hint ?? null,
        latencyMilliseconds: Date.now() - receivedAt.getTime(),
        fingerprintVersion: this.config.FINGERPRINT_VERSION,
      });
      isFinished = true;
      if (!isRecorded) {
        this.logger.warn({ requestId, recognitionId: claim.recognitionId, attempt: claim.attemptNumber, outcome: finished.outcome }, 'a later attempt had already taken over this recognition; this outcome was not recorded');
      }
    };
    try {
      return await this.answerClaimedRecognition(fields, audio, claim, requestId, hasStationHint, finish, response);
    } catch (error) {
      // Whatever went wrong, the attempt is finished, so it is never left PENDING (S3-RECORDING-08);
      // a repeat of the same key then starts a new attempt at once.
      if (!isFinished) {
        await finish({ outcome: 'ERROR', fallbackReason: 'unexpected_failure' }).catch((finishError: unknown) =>
          this.logger.error({ requestId, err: finishError }, 'a failed recognition could not be recorded'),
        );
      }
      throw error;
    }
  }

  private async answerClaimedRecognition(
    fields: RecognizeRequestFields,
    audio: Buffer,
    claim: Claim,
    requestId: string,
    hasStationHint: boolean,
    finish: FinishAttempt,
    response: Response,
  ): Promise<RecognizeResponse> {
    const refusal = this.admissionRefusal();
    if (refusal) {
      this.logger.warn({ requestId, cause: refusal }, 'recognition refused: busy');
      await finish({ outcome: 'BUSY', fallbackReason: refusal });
      response.setHeader('Retry-After', String(BUSY_RETRY_AFTER_SECONDS));
      throw new AppError('RECOGNITION_BUSY', { internalDetail: `admission refused: ${refusal}` });
    }

    let workerResult: RecognizeJobResult;
    try {
      workerResult = await this.breaker.fire(randomUUID(), {
        request_id: requestId,
        audio_base64: audio.toString('base64'),
        codec: fields.codec,
        deadline_epoch_milliseconds: Date.now() + this.config.RECOGNITION_WAIT_MILLISECONDS,
        fingerprint_version: this.config.FINGERPRINT_VERSION,
      });
    } catch (error) {
      throw await this.answerWorkerFailure(error, finish, response);
    }
    if (workerResult.status === 'EXPIRED') {
      await finish({ outcome: 'TIMEOUT', fallbackReason: 'worker_dropped_the_job' });
      response.setHeader('Retry-After', String(TIMEOUT_RETRY_AFTER_SECONDS));
      throw new AppError('RECOGNITION_TIMEOUT', { internalDetail: 'the worker reported the job expired' });
    }

    const matchFacts = {
      audioAssetNumber: workerResult.audio_asset_number,
      alignedHashCount: workerResult.aligned_hash_count,
      matchMargin: workerResult.match_margin,
      matchOffsetMilliseconds: workerResult.match_offset_milliseconds,
    };
    // A retry keeps the first receipt and capture times, so it is resolved at the moment the clip was first
    // heard, and answers the stored deferred flag (P4-D2).
    const basics: AnswerBasics = { recognitionId: claim.recognitionId, requestId, isDeferred: claim.isDeferred, capturedAt: claim.capturedAt };
    if (workerResult.status !== 'MATCH' || workerResult.audio_asset_number === null) {
      // AMBIGUOUS is kept as AMBIGUOUS, and the listener hears "no match" (S3-RESPONSE-16).
      const outcome = workerResult.status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'NO_MATCH';
      const answer = answerNoMatch(basics);
      await finish({ outcome, ...matchFacts });
      this.logAnswer({ requestId, recognitionId: claim.recognitionId, outcome, resolution: null, candidateCount: 0, hasStationHint, isReplay: false });
      return answer;
    }

    const resolution = resolveStation(await this.records.findStationCandidates(workerResult.audio_asset_number, claim.capturedAt), {
      capturedAt: claim.capturedAt,
      stationHint: fields.station_hint ?? null,
    });
    // The answer is built (and checked against the contract) before the outcome is recorded, so a
    // recognition is never stored as an answer the listener did not receive.
    const answer = answerResolution(basics, resolution);
    const matched = resolution.outcome === 'MATCH' || resolution.outcome === 'MATCH_DEFAULT' ? resolution.matched : null;
    await finish({
      outcome: resolution.outcome,
      fallbackReason: resolution.fallbackReason,
      resolution: resolution.resolution,
      stationId: matched?.stationId ?? null,
      campaignId: matched?.campaignId ?? null,
      actionCardId: matched?.actionCardId ?? null,
      weighedCandidates: resolution.weighedCandidates,
      ...matchFacts,
    });
    this.logAnswer({
      requestId,
      recognitionId: claim.recognitionId,
      outcome: resolution.outcome,
      resolution: resolution.resolution,
      candidateCount: resolution.weighedCandidates.length,
      hasStationHint,
      isReplay: false,
    });
    return answer;
  }

  /**
   * One line per answered recognition (P4 design §5.13): the outcome, how the station was decided and how many
   * stations were weighed. Whether a hint came, never its value: a station id with a time is a listening habit.
   */
  private logAnswer(facts: { requestId: string; recognitionId: string; outcome: string; resolution: string | null; candidateCount: number; hasStationHint: boolean; isReplay: boolean }): void {
    this.logger.info(facts, facts.isReplay ? 'recognition answered again (replay)' : 'recognition answered');
  }

  private admissionRefusal(): AdmissionRefusal | null {
    if (this.breaker.opened) return 'breaker_open';
    const { isWorkerAlive, waitingJobCount } = this.recognizeQueue.admissionState();
    if (!isWorkerAlive) return 'no_worker_heartbeat';
    if (waitingJobCount >= this.config.RECOGNITION_QUEUE_DEPTH_LIMIT) return 'queue_too_deep';
    return null;
  }

  /** What a failed attempt is recorded as, and what the caller is told (S3-D23). The worker's code never reaches the caller. */
  private async answerWorkerFailure(
    error: unknown,
    finish: FinishAttempt,
    response: Response,
  ): Promise<AppError> {
    if (error instanceof RecognizeJobFailed && error.code === 'INVALID_AUDIO') {
      await finish({ outcome: 'INVALID_AUDIO', fallbackReason: 'invalid_audio' });
      return new AppError('INVALID_AUDIO', { internalDetail: `worker: ${error.code}`, cause: error });
    }
    if (error instanceof RecognizeWaitTimedOut) {
      await finish({ outcome: 'TIMEOUT' });
      response.setHeader('Retry-After', String(TIMEOUT_RETRY_AFTER_SECONDS));
      return new AppError('RECOGNITION_TIMEOUT', { internalDetail: error.message, cause: error });
    }
    if (error instanceof RecognizeJobFailed && error.code === 'ENGINE_FAILED') {
      await finish({ outcome: 'ERROR', fallbackReason: 'engine_failed' });
      return new AppError('INTERNAL', { internalDetail: 'worker: ENGINE_FAILED', cause: error });
    }
    // The breaker opened, the queue could not be reached, the lookup timed out, or the worker runs other fingerprints.
    const cause = error instanceof RecognizeJobFailed ? error.code.toLowerCase() : (error as { code?: string }).code === 'EOPENBREAKER' ? 'breaker_open' : 'queue_unreachable';
    this.logger.warn({ requestId: this.requestContext.getId(), cause }, 'recognition refused: busy');
    await finish({ outcome: 'BUSY', fallbackReason: cause });
    response.setHeader('Retry-After', String(BUSY_RETRY_AFTER_SECONDS));
    return new AppError('RECOGNITION_BUSY', { internalDetail: `recognition failed: ${cause}`, cause: error });
  }

  /**
   * A recognition this install already finished, answered again from what was stored (P4 design §5.4): same id,
   * status and card versions, a chooser's stations in the same order, the stored deferred flag and capture time,
   * minus any station no longer ACTIVE. No job, no row and no counter changes.
   */
  private async replay(claim: Claim, listenerInstallId: string, requestId: string, hasStationHint: boolean): Promise<RecognizeResponse> {
    const rows = await this.records.describeForReplay(claim, listenerInstallId);
    const first = rows[0];
    if (!first) throw new AppError('INTERNAL', { internalDetail: `finished recognition ${claim.recognitionId} has nothing to replay` });
    if (first.outcome === 'INVALID_AUDIO') throw new AppError('INVALID_AUDIO', { internalDetail: 'replay of a clip that could not be used' });
    const answer = answerReplay({ recognitionId: claim.recognitionId, requestId }, rows);
    this.logAnswer({
      requestId,
      recognitionId: claim.recognitionId,
      outcome: answer.status,
      resolution: null,
      candidateCount: answer.status === 'CHOOSE_STATION' ? answer.candidates.length : answer.status === 'MATCH' ? 1 : 0,
      hasStationHint,
      isReplay: true,
    });
    return answer;
  }
}
