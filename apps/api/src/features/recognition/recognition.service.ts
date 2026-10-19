import { randomInt, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type RecognizeJobData, type RecognizeJobResult, RecognizeRequestFields, type RecognizeResponse } from '@lookup/contracts';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import type CircuitBreaker from 'opossum';
import { AppError } from '../../common/errors/app-error.js';
import { uuidVersion7 } from '../../common/identifiers/uuid-version-7.js';
import { isAccountRequiredAndMissing } from '../../common/listener-authentication/account-required.js';
import { LISTENER_INSTALL_ID } from '../../common/listener-authentication/install-token.guard.js';
import type { RateLimitRule } from '../../common/rate-limiting/rate-limit-rule.js';
import { RateLimiter } from '../../common/rate-limiting/rate-limiter.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { RecognizeJobFailed, RecognizeQueue, RecognizeWaitTimedOut } from '../../infrastructure/job-queues/recognize-queue.js';
import { assertClipSignature, correctCaptureTime } from './clip-checks.js';
import { type AnswerBasics, answerNoMatch, answerReplay, answerResolution, withholdAdResult } from './recognition-answers.js';
import { createRecognitionBreaker } from './recognition-breaker.js';
import { type Claim, type FinishedRecognition, RecognitionRecords } from './recognition-records.js';
import { resolveStation } from './resolve-station.js';

export const BUSY_RETRY_AFTER_SECONDS = 10;
export const TIMEOUT_RETRY_AFTER_SECONDS = 5;
const IN_PROGRESS_RETRY_AFTER_SECONDS = 3;
/** A key this install already holds is exempt from the live and deferred allowances until its fifth attempt (P4-D14). */
export const ATTEMPTS_EXEMPT_FROM_THE_ALLOWANCES = 5;
/** BullMQ priority of a deferred job: prioritised jobs wait behind every plain waiting (live) job (P4 design §5.3). */
export const DEFERRED_JOB_PRIORITY = 10;

/**
 * Live (the listener is waiting) or deferred (the outbox sends a clip saved earlier), chosen by the `is_deferred` field
 * as sent, never by the computed flag: it picks the allowance, the place in flight, the queue depth, the breaker, the
 * Retry-After, the priority and the wait (P4 design §5.3, P4-D14).
 */
export type SendKind = 'live' | 'deferred';

type AdmissionRefusal = 'no_worker_heartbeat' | 'queue_too_deep' | 'breaker_open' | 'deferred_breaker_open';

/** The fields RecognizeRequestFields requires; a request missing one of them is read to the end before it is judged. */
const REQUIRED_FIELD_NAMES = Object.entries(RecognizeRequestFields.shape)
  .filter(([, schema]) => !schema.safeParse(undefined).success)
  .map(([name]) => name);

/**
 * The place a recognize request holds on this instance while its clip is read and worked on (P4 design §5.2): taken
 * when its text fields arrive, released once when the request ends, whatever happened.
 */
export class PlacesInFlight {
  private releaseHeld: (() => void) | null = null;

  get isHeld(): boolean {
    return this.releaseHeld !== null;
  }

  hold(release: () => void): void {
    this.releaseHeld = release;
  }

  release(): void {
    const release = this.releaseHeld;
    this.releaseHeld = null;
    release?.();
  }
}

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
  private readonly liveBreaker: CircuitBreaker<[string, RecognizeJobData], RecognizeJobResult>;
  private readonly deferredBreaker: CircuitBreaker<[string, RecognizeJobData], RecognizeJobResult>;
  private readonly perMinuteRule: RateLimitRule;
  private readonly perDayRule: RateLimitRule;
  private readonly deferredPerHourRule: RateLimitRule;
  private readonly replaysPerHourRule: RateLimitRule;
  private readonly perAddressRule: RateLimitRule;
  private readonly fieldsPipe = new ZodValidationPipe(RecognizeRequestFields);
  private recognitionsInFlight = 0;
  private deferredRecognitionsInFlight = 0;

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
    this.deferredPerHourRule = {
      counterName: 'deferred-recognitions-per-install-hour',
      maximumRequests: config.RECOGNITIONS_DEFERRED_PER_INSTALL_PER_HOUR,
      windowSeconds: 60 * 60,
    };
    this.replaysPerHourRule = {
      counterName: 'recognition-replays-per-install-hour',
      maximumRequests: config.RECOGNITION_REPLAYS_PER_INSTALL_PER_HOUR,
      windowSeconds: 60 * 60,
    };
    this.perAddressRule = { counterName: 'recognitions-per-address', maximumRequests: config.RECOGNITIONS_PER_CLIENT_ADDRESS_PER_MINUTE, windowSeconds: 60 };
    // The add-and-wait runs inside a breaker, so timeouts and worker failures count against it (S3-ADMISSION-08).
    // Deferred sends have their own (P4-D15): they wait at a lower priority and time out by design under load, which
    // must never refuse live clips.
    this.liveBreaker = createRecognitionBreaker((jobId: string, data: RecognizeJobData) =>
      recognizeQueue.addAndWait(jobId, data, config.RECOGNITION_WAIT_MILLISECONDS),
    );
    this.deferredBreaker = createRecognitionBreaker((jobId: string, data: RecognizeJobData) =>
      recognizeQueue.addAndWait(jobId, data, config.RECOGNITION_DEFERRED_WAIT_MILLISECONDS, { priority: DEFERRED_JOB_PRIORITY }),
    );
    for (const [breaker, sendKind] of [
      [this.liveBreaker, 'live'],
      [this.deferredBreaker, 'deferred'],
    ] as const) {
      breaker.on('open', () => this.logger.warn({ sendKind }, `the ${sendKind} recognition breaker opened: clips are refused as busy until a trial succeeds`));
      breaker.on('halfOpen', () => this.logger.info({ sendKind }, `the ${sendKind} recognition breaker is letting one trial clip through`));
      breaker.on('close', () => this.logger.info({ sendKind }, `the ${sendKind} recognition breaker closed`));
    }
  }

  /** Recognitions in progress on this instance, reading their clips included. */
  get inFlightCount(): number {
    return this.recognitionsInFlight;
  }

  /** Of those, the ones sent from the outbox (is_deferred "true"). */
  get deferredInFlightCount(): number {
    return this.deferredRecognitionsInFlight;
  }

  /** The live circuit breaker, for tests of its own behaviour. */
  get circuitBreaker(): CircuitBreaker<[string, RecognizeJobData], RecognizeJobResult> {
    return this.liveBreaker;
  }

  /** The deferred sends' circuit breaker, for tests of its own behaviour. */
  get deferredCircuitBreaker(): CircuitBreaker<[string, RecognizeJobData], RecognizeJobResult> {
    return this.deferredBreaker;
  }

  /**
   * Before the body is read: per address, because installs cost nothing to make, so one sender with many installs
   * must not fill the queue for everyone. The per-install allowance waits for the text fields (admitBeforeAudio).
   */
  async countAgainstAddressLimit(clientAddress: string, response: Response): Promise<void> {
    await this.rateLimiter.countRequest(this.perAddressRule, clientAddress, response);
  }

  /** A place for one request, held from when its fields arrive until it ends. */
  newPlacesInFlight(): PlacesInFlight {
    return new PlacesInFlight();
  }

  /**
   * When the text fields have arrived and before any audio is read (P4 design §5.2, step 7): a place in flight
   * (503 past the limit, never counted against the listener), then one request against the allowance the fields
   * name: the replay allowance for a key this install already holds with fewer than 5 attempts, otherwise the
   * deferred or the live one (429). Fields that are all present but invalid count as live and are refused here
   * (400); a missing field counts as live, and the request is judged once the whole body has arrived.
   */
  async admitBeforeAudio(fieldsBeforeAudio: Readonly<Record<string, string>>, places: PlacesInFlight, response: Response): Promise<void> {
    const parsed = RecognizeRequestFields.safeParse(fieldsBeforeAudio);
    const sendKind: SendKind = parsed.success && parsed.data.is_deferred ? 'deferred' : 'live';
    this.takePlace(places, sendKind, response);
    if (parsed.success) {
      const listenerInstallId = this.requestContext.get<string>(LISTENER_INSTALL_ID);
      const attemptCount = await this.records.countAttempts(listenerInstallId, parsed.data.idempotency_key);
      if (attemptCount !== null && attemptCount < ATTEMPTS_EXEMPT_FROM_THE_ALLOWANCES) {
        await this.rateLimiter.countRequest(this.replaysPerHourRule, listenerInstallId, response);
      } else if (sendKind === 'deferred') {
        await this.rateLimiter.countRequest(this.deferredPerHourRule, listenerInstallId, response);
      } else {
        await this.countAgainstLiveAllowance(response);
      }
      return;
    }
    await this.countAgainstLiveAllowance(response);
    if (REQUIRED_FIELD_NAMES.every((name) => Object.hasOwn(fieldsBeforeAudio, name))) this.fieldsPipe.transform(fieldsBeforeAudio);
  }

  /** One request against the live per-install allowance: 6 a minute and 60 a day (S3-RATELIMIT-01). */
  async countAgainstLiveAllowance(response: Response): Promise<void> {
    const listenerInstallId = this.requestContext.get<string>(LISTENER_INSTALL_ID);
    await this.rateLimiter.countRequest(this.perMinuteRule, listenerInstallId, response);
    await this.rateLimiter.countRequest(this.perDayRule, listenerInstallId, response);
  }

  /**
   * One of this instance's places, refused at once past the limit so the clips held in memory stay bounded; a
   * deferred send must also find one of the deferred places, so live clips always find the rest (P4-D15).
   */
  private takePlace(places: PlacesInFlight, sendKind: SendKind, response: Response): void {
    if (places.isHeld) return;
    const hasNoDeferredPlace = sendKind === 'deferred' && this.deferredRecognitionsInFlight >= this.config.RECOGNITIONS_DEFERRED_IN_FLIGHT_LIMIT;
    if (this.recognitionsInFlight >= this.config.RECOGNITIONS_IN_FLIGHT_LIMIT || hasNoDeferredPlace) {
      const cause = hasNoDeferredPlace ? 'too_many_deferred_in_flight' : 'too_many_in_flight';
      this.logger.warn({ requestId: this.requestContext.getId(), cause, sendKind }, 'recognition refused: busy');
      response.setHeader('Retry-After', String(this.retryAfterSeconds(sendKind, BUSY_RETRY_AFTER_SECONDS)));
      throw new AppError('RECOGNITION_BUSY', { internalDetail: `admission refused: ${cause}` });
    }
    this.recognitionsInFlight += 1;
    if (sendKind === 'deferred') this.deferredRecognitionsInFlight += 1;
    places.hold(() => {
      this.recognitionsInFlight -= 1;
      if (sendKind === 'deferred') this.deferredRecognitionsInFlight -= 1;
    });
  }

  /**
   * The Retry-After of a 503: the live value, or for a deferred send a new random whole number of seconds in the
   * configured range on every answer, so a crowd of phones whose tower has just come back spreads out (P4-DEFERRED-06).
   */
  private retryAfterSeconds(sendKind: SendKind, liveSeconds: number): number {
    if (sendKind === 'live') return liveSeconds;
    return randomInt(this.config.RECOGNITION_DEFERRED_RETRY_AFTER_MINIMUM_SECONDS, this.config.RECOGNITION_DEFERRED_RETRY_AFTER_MAXIMUM_SECONDS + 1);
  }

  async recognize(fields: RecognizeRequestFields, audio: Buffer, receivedAt: Date, response: Response): Promise<RecognizeResponse> {
    const listenerInstallId = this.requestContext.get<string>(LISTENER_INSTALL_ID);
    const requestId = this.requestContext.getId();
    const sendKind: SendKind = fields.is_deferred ? 'deferred' : 'live';
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
    if (claim.claimOutcome === 'FINISHED') return this.holdBackAdResult(await this.replay(claim, listenerInstallId, requestId, hasStationHint));

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
      return this.holdBackAdResult(await this.answerClaimedRecognition(fields, audio, claim, requestId, hasStationHint, finish, response, sendKind));
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

  /**
   * The one place an ad's result is held back (ADR-005, LA-GATE-01..04): while accounts are required, an install with
   * no account gets ACCOUNT_REQUIRED instead of a match or a chooser. It runs after the outcome is recorded (the scan
   * still counts) and on both paths that answer a clip, the fresh one and the replay of a finished key, so sending
   * a clip again never gets the card. A no-match and every error are not ad results and pass through.
   */
  private holdBackAdResult(answer: RecognizeResponse): RecognizeResponse {
    if (!isAccountRequiredAndMissing(this.config, this.requestContext)) return answer;
    const heldBack = withholdAdResult(answer);
    if (heldBack !== answer) this.logger.info({ requestId: this.requestContext.getId(), recognitionId: answer.recognition_id }, 'ad result held back until the listener has an account');
    return heldBack;
  }

  /**
   * The result of a recognition this install made, once it has an account (ADR-005, LA-GATE-06): the same answer the
   * scan would have had, as it is replayed from what was stored. An install with no account still gets
   * ACCOUNT_REQUIRED; an unknown id, another install's and one that was not an ad's result are all 404.
   */
  async reveal(recognitionId: string): Promise<RecognizeResponse> {
    const listenerInstallId = this.requestContext.get<string>(LISTENER_INSTALL_ID);
    const receivedAt = await this.records.findReceivedAtOfOwnRecognition(recognitionId, listenerInstallId);
    const rows = receivedAt ? await this.records.describeForReplay({ recognitionId, receivedAt }, listenerInstallId) : [];
    const first = rows[0];
    if (!first || !['MATCH', 'MATCH_DEFAULT', 'CHOOSE_STATION'].includes(first.outcome)) {
      throw new AppError('NOT_FOUND', { internalDetail: 'no finished ad recognition of this install has that id' });
    }
    const answer = answerReplay({ recognitionId, requestId: this.requestContext.getId() }, rows);
    this.logAnswer({
      requestId: this.requestContext.getId(),
      recognitionId,
      outcome: answer.status,
      resolution: null,
      candidateCount: answer.status === 'CHOOSE_STATION' ? answer.candidates.length : answer.status === 'MATCH' ? 1 : 0,
      hasStationHint: false,
      isReplay: true,
    });
    return this.holdBackAdResult(answer);
  }

  private async answerClaimedRecognition(
    fields: RecognizeRequestFields,
    audio: Buffer,
    claim: Claim,
    requestId: string,
    hasStationHint: boolean,
    finish: FinishAttempt,
    response: Response,
    sendKind: SendKind,
  ): Promise<RecognizeResponse> {
    const refusal = this.admissionRefusal(sendKind);
    if (refusal) {
      this.logger.warn({ requestId, cause: refusal, sendKind }, 'recognition refused: busy');
      await finish({ outcome: 'BUSY', fallbackReason: refusal });
      response.setHeader('Retry-After', String(this.retryAfterSeconds(sendKind, BUSY_RETRY_AFTER_SECONDS)));
      throw new AppError('RECOGNITION_BUSY', { internalDetail: `admission refused: ${refusal}` });
    }

    let workerResult: RecognizeJobResult;
    const waitMilliseconds = sendKind === 'deferred' ? this.config.RECOGNITION_DEFERRED_WAIT_MILLISECONDS : this.config.RECOGNITION_WAIT_MILLISECONDS;
    try {
      workerResult = await (sendKind === 'deferred' ? this.deferredBreaker : this.liveBreaker).fire(randomUUID(), {
        request_id: requestId,
        audio_base64: audio.toString('base64'),
        codec: fields.codec,
        deadline_epoch_milliseconds: Date.now() + waitMilliseconds,
        fingerprint_version: this.config.FINGERPRINT_VERSION,
      });
    } catch (error) {
      throw await this.answerWorkerFailure(error, finish, response, sendKind);
    }
    if (workerResult.status === 'EXPIRED') {
      await finish({ outcome: 'TIMEOUT', fallbackReason: 'worker_dropped_the_job' });
      response.setHeader('Retry-After', String(this.retryAfterSeconds(sendKind, TIMEOUT_RETRY_AFTER_SECONDS)));
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

  /**
   * Whether to try at all (P4 design §5.3): live clips look only at the live breaker; deferred sends are refused while
   * either breaker is open, since a live failure means the workers are in trouble for everyone. Deferred sends are
   * refused at a lower queue depth, so they are shed first.
   */
  private admissionRefusal(sendKind: SendKind): AdmissionRefusal | null {
    if (this.liveBreaker.opened) return 'breaker_open';
    if (sendKind === 'deferred' && this.deferredBreaker.opened) return 'deferred_breaker_open';
    const { isWorkerAlive, waitingJobCount } = this.recognizeQueue.admissionState();
    if (!isWorkerAlive) return 'no_worker_heartbeat';
    const depthLimit = sendKind === 'deferred' ? this.config.RECOGNITION_DEFERRED_QUEUE_DEPTH_LIMIT : this.config.RECOGNITION_QUEUE_DEPTH_LIMIT;
    if (waitingJobCount >= depthLimit) return 'queue_too_deep';
    return null;
  }

  /** What a failed attempt is recorded as, and what the caller is told (S3-D23). The worker's code never reaches the caller. */
  private async answerWorkerFailure(
    error: unknown,
    finish: FinishAttempt,
    response: Response,
    sendKind: SendKind,
  ): Promise<AppError> {
    if (error instanceof RecognizeJobFailed && error.code === 'INVALID_AUDIO') {
      await finish({ outcome: 'INVALID_AUDIO', fallbackReason: 'invalid_audio' });
      return new AppError('INVALID_AUDIO', { internalDetail: `worker: ${error.code}`, cause: error });
    }
    if (error instanceof RecognizeWaitTimedOut) {
      await finish({ outcome: 'TIMEOUT' });
      response.setHeader('Retry-After', String(this.retryAfterSeconds(sendKind, TIMEOUT_RETRY_AFTER_SECONDS)));
      return new AppError('RECOGNITION_TIMEOUT', { internalDetail: error.message, cause: error });
    }
    if (error instanceof RecognizeJobFailed && error.code === 'ENGINE_FAILED') {
      await finish({ outcome: 'ERROR', fallbackReason: 'engine_failed' });
      return new AppError('INTERNAL', { internalDetail: 'worker: ENGINE_FAILED', cause: error });
    }
    // The breaker opened, the queue could not be reached, the lookup timed out, or the worker runs other fingerprints.
    const cause = error instanceof RecognizeJobFailed ? error.code.toLowerCase() : (error as { code?: string }).code === 'EOPENBREAKER' ? 'breaker_open' : 'queue_unreachable';
    this.logger.warn({ requestId: this.requestContext.getId(), cause, sendKind }, 'recognition refused: busy');
    await finish({ outcome: 'BUSY', fallbackReason: cause });
    response.setHeader('Retry-After', String(this.retryAfterSeconds(sendKind, BUSY_RETRY_AFTER_SECONDS)));
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
