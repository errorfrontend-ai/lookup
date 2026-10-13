import type { RecognitionReportReason } from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';

/** What recognition.record_recognition_report answers, one code per outcome (P4 design §4.4, §5.9). */
export const RECOGNITION_REPORT_ANSWERS = ['RECORDED', 'ALREADY_RECORDED', 'NOT_FOUND', 'NOT_A_CANDIDATE', 'ANOTHER_STATION_CHOSEN'] as const;
export type RecognitionReportAnswer = (typeof RECOGNITION_REPORT_ANSWERS)[number];

/**
 * "Report this" in the database: one definer function checks that the recognition is this install's and finished
 * with the reported station shown, and stores the report with the install's keyed hash, never its id.
 */
@Injectable()
export class RecognitionReports {
  constructor(private readonly stationScopedTransaction: StationScopedTransaction) {}

  async record(report: {
    recognitionId: string;
    listenerInstallId: string;
    listenerInstallHash: string;
    stationId: string;
    reason: RecognitionReportReason;
    receivedAt: Date;
    requestId: string;
  }): Promise<RecognitionReportAnswer> {
    const rows = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT recognition.record_recognition_report($1, $2, $3, $4, $5, $6, $7) AS answer', [
        report.recognitionId,
        report.listenerInstallId,
        report.listenerInstallHash,
        report.stationId,
        report.reason,
        report.receivedAt,
        report.requestId,
      ]),
    )) as Array<{ answer: string }>;
    const answer = rows[0]?.answer;
    if (!(RECOGNITION_REPORT_ANSWERS as readonly string[]).includes(answer ?? '')) {
      throw new AppError('INTERNAL', { internalDetail: `record_recognition_report gave an answer this API does not know: ${String(answer).slice(0, 40)}` });
    }
    return answer as RecognitionReportAnswer;
  }
}
