import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  type ActionCard,
  type RecognitionResult,
  type RecognizeJobData,
  type RecognizeJobResult,
  type RecognizeRequestFields,
  RecognizeResponse,
} from '@lookup/contracts';
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
import { chooseStation } from './choose-station.js';
import { createRecognitionBreaker } from './recognition-breaker.js';
import { assertClipSignature, type CorrectedCaptureTime, correctCaptureTime } from './clip-checks.js';
import { type Claim, type DescribedRecognition, type FinishedRecognition, RecognitionRecords } from './recognition-records.js';

export const BUSY_RETRY_AFTER_SECONDS = 10;
export const TIMEOUT_RETRY_AFTER_SECONDS = 5;
const IN_PROGRESS_RETRY_AFTER_SECONDS = 3;

type AdmissionRefusal = 'no_worker_heartbeat' | 'queue_too_deep' | 'breaker_open';

/**
 * The Recognition Supervisor (blueprint): for one clip, after the install token and the body have
 * been checked, it checks the clip, claims the idempotency key, decides whether to try at all
 * (admission), sends the clip to a worker through the circuit breaker and waits, chooses the station,
 * records the outcome and answers in the contract's shape. Every refusal has a catalogue code, and
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
    if (claim.claimOutcome === 'IN_PROGRESS') {
      response.setHeader('Retry-After', String(IN_PROGRESS_RETRY_AFTER_SECONDS));
      throw new AppError('RECOGNITION_IN_PROGRESS', { internalDetail: `recognition ${claim.recognitionId} is still being worked on` });
    }
    if (claim.claimOutcome === 'FINISHED') return this.replay(claim, listenerInstallId, requestId);

    let isFinished = false;
    const finish = async (finished: Omit<FinishedRecognition, 'latencyMilliseconds' | 'fingerprintVersion'>) => {
      const isRecorded = await this.records.finish(claim, { ...finished, latencyMilliseconds: Date.now() - receivedAt.getTime(), fingerprintVersion: this.config.FINGERPRINT_VERSION });
      isFinished = true;
      if (!isRecorded) {
        this.logger.warn({ requestId, recognitionId: claim.recognitionId, attempt: claim.attemptNumber, outcome: finished.outcome }, 'a later attempt had already taken over this recognition; this outcome was not recorded');
      }
    };
    try {
      return await this.answerClaimedRecognition(fields, audio, claim, time, requestId, finish, response);
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
    time: CorrectedCaptureTime,
    requestId: string,
    finish: (finished: Omit<FinishedRecognition, 'latencyMilliseconds' | 'fingerprintVersion'>) => Promise<void>,
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
    const common = { recognitionId: claim.recognitionId, requestId, isDeferred: time.isDeferred, capturedAt: time.effectiveCapturedAt };
    if (workerResult.status !== 'MATCH' || workerResult.audio_asset_number === null) {
      // AMBIGUOUS is kept as AMBIGUOUS, and the listener hears "no match" (S3-RESPONSE-16).
      const answer = this.respond({ ...common, result: null });
      await finish({ outcome: workerResult.status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'NO_MATCH', ...matchFacts });
      return answer;
    }

    const choice = chooseStation(await this.records.findStations(workerResult.audio_asset_number, time.effectiveCapturedAt));
    if (choice.outcome === 'NO_MATCH') {
      const answer = this.respond({ ...common, result: null });
      await finish({ outcome: 'NO_MATCH', fallbackReason: choice.fallbackReason, ...matchFacts });
      return answer;
    }
    // The answer is built (and checked against the contract) before the outcome is recorded, so a
    // recognition is never stored as a match the listener did not receive.
    const answer = this.respond({
      ...common,
      result: this.resultFor(choice.kind, {
        stationId: choice.candidate.station_id,
        stationName: choice.candidate.station_name,
        frequencyLabel: choice.candidate.station_frequency_label,
        clientName: choice.candidate.client_name,
        title: choice.candidate.ad_title,
        card: choice.card,
      }),
    });
    await finish({ outcome: choice.outcome, ...matchFacts, stationId: choice.candidate.station_id, campaignId: choice.candidate.campaign_id, actionCardId: choice.actionCardId });
    return answer;
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
    finish: (finished: Omit<FinishedRecognition, 'latencyMilliseconds' | 'fingerprintVersion'>) => Promise<void>,
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

  /** A recognition this install already finished, answered again the same way: same id, same card version. */
  private async replay(claim: Claim, listenerInstallId: string, requestId: string): Promise<RecognizeResponse> {
    const described = (await this.records.describe(claim, listenerInstallId)) as DescribedRecognition;
    if (described.outcome === 'INVALID_AUDIO') throw new AppError('INVALID_AUDIO', { internalDetail: 'replay of a clip that could not be used' });
    const common = { recognitionId: claim.recognitionId, requestId, isDeferred: described.is_deferred, capturedAt: described.captured_at };
    const isMatch = (described.outcome === 'MATCH' || described.outcome === 'MATCH_DEFAULT') && described.action_card && described.station_id;
    if (!isMatch) return this.respond({ ...common, result: null });
    return this.respond({
      ...common,
      result: this.resultFor(described.outcome === 'MATCH' ? 'CAMPAIGN' : 'CLIENT_DEFAULT', {
        stationId: described.station_id as string,
        stationName: described.station_name as string,
        frequencyLabel: described.station_frequency_label as string,
        clientName: described.client_name as string,
        title: described.ad_title as string,
        card: described.action_card as ActionCard,
      }),
    });
  }

  private resultFor(
    kind: RecognitionResult['kind'],
    shown: { stationId: string; stationName: string; frequencyLabel: string; clientName: string; title: string; card: ActionCard },
  ): RecognitionResult {
    return {
      kind,
      station: { id: shown.stationId, name: shown.stationName, frequency_label: shown.frequencyLabel, logo: null },
      client: { name: shown.clientName, logo: null },
      title: shown.title,
      // No screen sets header images or logos yet (S3-D21).
      card: { schema_version: shown.card.schema_version, layout: shown.card.layout, header_image: null, actions: shown.card.actions },
    };
  }

  /** Every answer is checked against the shared contract before it leaves, so nothing outside it can. */
  private respond(answer: { recognitionId: string; requestId: string; isDeferred: boolean; capturedAt: Date; result: RecognitionResult | null }): RecognizeResponse {
    const common = { recognition_id: answer.recognitionId, request_id: answer.requestId, is_deferred: answer.isDeferred, captured_at: answer.capturedAt.toISOString() };
    return RecognizeResponse.parse(answer.result ? { status: 'MATCH', ...common, result: answer.result } : { status: 'NO_MATCH', ...common });
  }
}
