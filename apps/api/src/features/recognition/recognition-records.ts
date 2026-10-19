import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import type { ReplayRow } from './recognition-answers.js';
import type { StationCandidateRow, StationResolutionName, WeighedCandidate } from './resolve-station.js';

export type ClaimOutcome = 'CLAIMED' | 'RECLAIMED' | 'IN_PROGRESS' | 'FINISHED';
export type RecognitionOutcome = 'MATCH' | 'MATCH_DEFAULT' | 'CHOOSE_STATION' | 'NO_MATCH' | 'AMBIGUOUS' | 'INVALID_AUDIO' | 'TIMEOUT' | 'BUSY' | 'ERROR';

/** What recognition.record_station_choice answers, one code per outcome (P4 design §4.4, §5.5). */
export const STATION_CHOICE_ANSWERS = ['CHOSEN', 'ALREADY_CHOSEN', 'NOT_FOUND', 'NOT_A_CANDIDATE', 'ANOTHER_STATION_CHOSEN'] as const;
export type StationChoiceAnswer = (typeof STATION_CHOICE_ANSWERS)[number];

export interface Claim {
  recognitionId: string;
  /** When the server first received this key: the recognition's partition key, kept by every retry. */
  receivedAt: Date;
  /** When the clip was first heard, corrected for the phone's clock: a retry is resolved at this same moment. */
  capturedAt: Date;
  /** Which attempt this is (1 for a new key; one more on each retry). Its outcome is recorded against it. */
  attemptNumber: number;
  claimOutcome: ClaimOutcome;
  previousOutcome: RecognitionOutcome | 'PENDING' | null;
  /** As stored: deferred if any attempt was (true is never turned back to false). */
  isDeferred: boolean;
}

export interface FinishedRecognition {
  outcome: RecognitionOutcome;
  fallbackReason?: string | null;
  audioAssetNumber?: number | null;
  stationId?: string | null;
  campaignId?: string | null;
  actionCardId?: string | null;
  resolution?: StationResolutionName | null;
  /** The listener's "My station" as sent; the database keeps it only when that station exists. */
  hintedStationId?: string | null;
  /** Every station that could show a card, one candidate row each (P4-D8). */
  weighedCandidates?: readonly WeighedCandidate[];
  alignedHashCount?: number | null;
  matchMargin?: number | null;
  matchOffsetMilliseconds?: number | null;
  latencyMilliseconds: number;
  fingerprintVersion: number;
}

/**
 * The recognition functions in the database (migrations EngineHookup and StationResolution). They are the API's
 * only way to write recognitions and to read across stations, and they return only what a listener may see.
 */
@Injectable()
export class RecognitionRecords {
  constructor(private readonly stationScopedTransaction: StationScopedTransaction) {}

  async claim(input: {
    listenerInstallId: string;
    idempotencyKey: string;
    newRecognitionId: string;
    requestId: string;
    effectiveCapturedAt: Date;
    clientCapturedAt: Date;
    clockSkewMilliseconds: number;
    receivedAt: Date;
    isDeferred: boolean;
    clipDurationMilliseconds: number;
  }): Promise<Claim> {
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT * FROM recognition.claim_recognition($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [
        input.listenerInstallId,
        input.idempotencyKey,
        input.newRecognitionId,
        input.requestId,
        input.effectiveCapturedAt,
        input.clientCapturedAt,
        input.clockSkewMilliseconds,
        input.receivedAt,
        input.isDeferred,
        input.clipDurationMilliseconds,
      ]),
    )) as Array<{
      recognition_id: string;
      recognition_received_at: Date;
      recognition_captured_at: Date;
      attempt_number: number;
      claim_outcome: ClaimOutcome;
      previous_outcome: Claim['previousOutcome'];
      is_deferred: boolean;
    }>;
    const row = rows[0] as (typeof rows)[number];
    return {
      recognitionId: row.recognition_id,
      receivedAt: row.recognition_received_at,
      capturedAt: row.recognition_captured_at,
      attemptNumber: row.attempt_number,
      claimOutcome: row.claim_outcome,
      previousOutcome: row.previous_outcome,
      isDeferred: row.is_deferred,
    };
  }

  /**
   * Records the attempt's outcome, how its station was resolved, the hint and the weighed stations, in one
   * transaction. False when it was not this attempt's to record (a retry overtook it). The database refuses,
   * storing nothing, anything that does not fit together.
   */
  async finish(claim: Pick<Claim, 'recognitionId' | 'receivedAt' | 'attemptNumber'>, finished: FinishedRecognition): Promise<boolean> {
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query(
        'SELECT recognition.finish_recognition($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17::smallint) AS is_recorded',
        [
          claim.recognitionId,
          claim.receivedAt,
          claim.attemptNumber,
          finished.outcome,
          finished.fallbackReason ?? null,
          finished.audioAssetNumber ?? null,
          finished.stationId ?? null,
          finished.campaignId ?? null,
          finished.actionCardId ?? null,
          finished.resolution ?? null,
          finished.hintedStationId ?? null,
          JSON.stringify(finished.weighedCandidates ?? []),
          finished.alignedHashCount ?? null,
          finished.matchMargin ?? null,
          finished.matchOffsetMilliseconds ?? null,
          finished.latencyMilliseconds,
          finished.fingerprintVersion,
        ],
      ),
    )) as Array<{ is_recorded: boolean }>;
    return rows[0]?.is_recorded === true;
  }

  /** One row per campaign that makes its station an owner of the recording, judged at the given capture moment. */
  findStationCandidates(audioAssetNumber: number, capturedAt: Date): Promise<StationCandidateRow[]> {
    return this.stationScopedTransaction.run((database) =>
      database.query('SELECT * FROM recognition.find_station_candidates($1, $2)', [audioAssetNumber, capturedAt]),
    ) as Promise<StationCandidateRow[]>;
  }

  /**
   * The partition key of a finished recognition this install made, found from its id; null for an unknown id,
   * another install's or one still being worked on (all look the same). For the reveal route (ADR-005).
   */
  async findReceivedAtOfOwnRecognition(recognitionId: string, listenerInstallId: string): Promise<Date | null> {
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT recognition.find_received_at_of_own_recognition($1, $2) AS received_at', [recognitionId, listenerInstallId]),
    )) as Array<{ received_at: Date | null }>;
    return rows[0]?.received_at ?? null;
  }

  /** What a finished recognition showed, for the install that made it (no rows for any other install). */
  describeForReplay(claim: Pick<Claim, 'recognitionId' | 'receivedAt'>, listenerInstallId: string): Promise<ReplayRow[]> {
    return this.stationScopedTransaction.run((database) =>
      database.query('SELECT * FROM recognition.describe_recognition_for_replay($1, $2, $3)', [claim.recognitionId, claim.receivedAt, listenerInstallId]),
    ) as Promise<ReplayRow[]>;
  }

  /**
   * How many attempts a key this install already holds has had, or null for a key it does not hold (unknown, or
   * another install's). Read when a recognize request's fields arrive, to choose its allowance (P4-D14).
   */
  async countAttempts(listenerInstallId: string, idempotencyKey: string): Promise<number | null> {
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT recognition.count_recognition_attempts($1, $2) AS attempt_count', [listenerInstallId, idempotencyKey]),
    )) as Array<{ attempt_count: number | null }>;
    return rows[0]?.attempt_count ?? null;
  }

  /**
   * The listener's answer to a chooser, recorded under a lock on the recognition: the first choice wins, the same
   * station again changes nothing, and an unknown id, another install's recognition or one that is not a chooser
   * are all NOT_FOUND. No counter moves.
   */
  async recordStationChoice(recognitionId: string, listenerInstallId: string, stationId: string): Promise<StationChoiceAnswer> {
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT recognition.record_station_choice($1, $2, $3) AS answer', [recognitionId, listenerInstallId, stationId]),
    )) as Array<{ answer: string }>;
    const answer = rows[0]?.answer;
    if (!(STATION_CHOICE_ANSWERS as readonly string[]).includes(answer ?? '')) {
      throw new AppError('INTERNAL', { internalDetail: `record_station_choice gave an answer this API does not know: ${String(answer).slice(0, 40)}` });
    }
    return answer as StationChoiceAnswer;
  }
}
