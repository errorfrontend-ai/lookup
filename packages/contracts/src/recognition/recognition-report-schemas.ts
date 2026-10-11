import { z } from 'zod';

/** Why a listener reports a result, from four fixed choices: there is no free text. */
export const RECOGNITION_REPORT_REASONS = ['WRONG_OR_MISLEADING_BUTTONS', 'NUMBER_OR_LINK_DOES_NOT_WORK', 'LOOKS_LIKE_A_SCAM', 'SOMETHING_ELSE'] as const;
export type RecognitionReportReason = (typeof RECOGNITION_REPORT_REASONS)[number];

/**
 * POST /api/v1/recognitions/{recognition_id}/report ("Report this"): the station whose card was shown
 * and one of the four reasons. The recognition is named by the path. One report per recognition: the
 * first wins, and a repeat is answered 204 like the first, even with another reason.
 */
export const ReportRecognitionInput = z
  .strictObject({
    station_id: z.uuid(),
    reason: z.enum(RECOGNITION_REPORT_REASONS),
  })
  .meta({ id: 'ReportRecognitionInput' });
export type ReportRecognitionInput = z.infer<typeof ReportRecognitionInput>;

/** For the listener app, which checks every body it builds against the contract. */
export function emitReportRecognitionInputJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://contracts.lookup.invalid/report-recognition-input/1.json',
    ...z.toJSONSchema(ReportRecognitionInput, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' }),
  };
}
