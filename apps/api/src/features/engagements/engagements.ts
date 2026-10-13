import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { uuidVersion7 } from '../../common/identifiers/uuid-version-7.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';

/** What recognition.record_engagement answers, one code per outcome (P4 design §4.4, §5.8). */
export const ENGAGEMENT_ANSWERS = ['RECORDED', 'ALREADY_RECORDED', 'NOT_FOUND', 'NOT_A_CANDIDATE', 'ANOTHER_STATION_CHOSEN', 'ACTION_NOT_ON_CARD'] as const;
export type EngagementAnswer = (typeof ENGAGEMENT_ANSWERS)[number];

export interface CorrectedTapTime {
  correctedOccurredAt: Date;
  clockSkewMilliseconds: number;
}

/**
 * The phone's clock may be wrong, so a tap's time is corrected by how far the phone's "sent at" is from the moment
 * the server received it (P4-ENGAGEMENTS-03, Q14): corrected = occurred_at + (received − sent_at). The database then
 * clamps it between the recognition's receipt and the tap's arrival, so a clock however wrong never stores a tap
 * before its recognition or after now.
 */
export function correctTapTime(times: { occurredAt: Date; sentAt: Date; receivedAt: Date }): CorrectedTapTime {
  const skew = times.receivedAt.getTime() - times.sentAt.getTime();
  const corrected = new Date(times.occurredAt.getTime() + skew);
  // Beyond what a date can hold (two absurd phone times far apart): the arrival, which the clamp would choose anyway.
  return { correctedOccurredAt: Number.isNaN(corrected.getTime()) ? times.receivedAt : corrected, clockSkewMilliseconds: skew };
}

/**
 * Button taps in the database: one definer function checks the tap belongs to a finished recognition of this
 * install, on a card it showed, records the choice of an unanswered chooser (A4), stores the tap once per
 * recognition and button, and counts it toward the campaign's limit, within the install's own daily cap.
 */
@Injectable()
export class Engagements {
  constructor(
    private readonly stationScopedTransaction: StationScopedTransaction,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async record(tap: {
    recognitionId: string;
    listenerInstallId: string;
    stationId: string;
    actionId: string;
    occurredAt: Date;
    sentAt: Date;
    receivedAt: Date;
    requestId: string;
  }): Promise<EngagementAnswer> {
    const time = correctTapTime(tap);
    const perInstallCap = this.config.ENGAGEMENTS_COUNTED_PER_INSTALL_PER_CAMPAIGN_PER_DAY;
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT recognition.record_engagement($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS answer', [
        uuidVersion7(),
        tap.recognitionId,
        tap.listenerInstallId,
        tap.stationId,
        tap.actionId,
        time.correctedOccurredAt,
        tap.occurredAt,
        time.clockSkewMilliseconds,
        tap.receivedAt,
        tap.requestId,
        // 0 switches the per-install cap off (P4-D10, Q12).
        perInstallCap === 0 ? null : perInstallCap,
      ]),
    )) as Array<{ answer: string }>;
    const answer = rows[0]?.answer;
    if (!(ENGAGEMENT_ANSWERS as readonly string[]).includes(answer ?? '')) {
      throw new AppError('INTERNAL', { internalDetail: `record_engagement gave an answer this API does not know: ${String(answer).slice(0, 40)}` });
    }
    return answer as EngagementAnswer;
  }
}
