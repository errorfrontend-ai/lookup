import { Injectable } from '@nestjs/common';
import type { ActionCard } from '@lookup/contracts';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import type { StationCandidate } from './choose-station.js';

export type ClaimOutcome = 'CLAIMED' | 'RECLAIMED' | 'IN_PROGRESS' | 'FINISHED';
export type RecognitionOutcome = 'MATCH' | 'MATCH_DEFAULT' | 'CHOOSE_STATION' | 'NO_MATCH' | 'AMBIGUOUS' | 'INVALID_AUDIO' | 'TIMEOUT' | 'BUSY' | 'ERROR';

export interface Claim {
  recognitionId: string;
  receivedAt: Date;
  /** Which attempt this is (1 for a new key; one more on each retry). Its outcome is recorded against it. */
  attemptNumber: number;
  claimOutcome: ClaimOutcome;
  previousOutcome: RecognitionOutcome | 'PENDING' | null;
}

export interface FinishedRecognition {
  outcome: RecognitionOutcome;
  fallbackReason?: string | null;
  audioAssetNumber?: number | null;
  stationId?: string | null;
  campaignId?: string | null;
  actionCardId?: string | null;
  alignedHashCount?: number | null;
  matchMargin?: number | null;
  matchOffsetMilliseconds?: number | null;
  latencyMilliseconds: number;
  fingerprintVersion: number;
}

export interface DescribedRecognition {
  outcome: RecognitionOutcome | 'PENDING';
  is_deferred: boolean;
  captured_at: Date;
  station_id: string | null;
  station_name: string | null;
  station_frequency_label: string | null;
  ad_title: string | null;
  client_name: string | null;
  action_card: ActionCard | null;
}

/**
 * The recognition functions in the database (migration EngineHookup). They are the API's only way
 * to write recognitions and to read across stations, and they return only what a listener may see.
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
    clockSkewMilliseconds: number | null;
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
    )) as Array<{ recognition_id: string; recognition_received_at: Date; attempt_number: number; claim_outcome: ClaimOutcome; previous_outcome: Claim['previousOutcome'] }>;
    const row = rows[0] as (typeof rows)[number];
    return {
      recognitionId: row.recognition_id,
      receivedAt: row.recognition_received_at,
      attemptNumber: row.attempt_number,
      claimOutcome: row.claim_outcome,
      previousOutcome: row.previous_outcome,
    };
  }

  /** Records the attempt's outcome. False when it was not this attempt's to record (a retry overtook it). */
  async finish(claim: Pick<Claim, 'recognitionId' | 'receivedAt' | 'attemptNumber'>, finished: FinishedRecognition): Promise<boolean> {
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT recognition.finish_recognition($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::smallint) AS is_recorded', [
        claim.recognitionId,
        claim.receivedAt,
        claim.attemptNumber,
        finished.outcome,
        finished.fallbackReason ?? null,
        finished.audioAssetNumber ?? null,
        finished.stationId ?? null,
        finished.campaignId ?? null,
        finished.actionCardId ?? null,
        finished.alignedHashCount ?? null,
        finished.matchMargin ?? null,
        finished.matchOffsetMilliseconds ?? null,
        finished.latencyMilliseconds,
        finished.fingerprintVersion,
      ]),
    )) as Array<{ is_recorded: boolean }>;
    return rows[0]?.is_recorded === true;
  }

  findStations(audioAssetNumber: number, effectiveCapturedAt: Date): Promise<StationCandidate[]> {
    return this.stationScopedTransaction.run((database) =>
      database.query('SELECT * FROM recognition.find_stations_for_audio($1, $2)', [audioAssetNumber, effectiveCapturedAt]),
    ) as Promise<StationCandidate[]>;
  }

  async describe(claim: Pick<Claim, 'recognitionId' | 'receivedAt'>, listenerInstallId: string): Promise<DescribedRecognition | null> {
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT * FROM recognition.describe_recognition($1, $2, $3)', [claim.recognitionId, claim.receivedAt, listenerInstallId]),
    )) as DescribedRecognition[];
    return rows[0] ?? null;
  }
}
