import { z } from 'zod';

/**
 * POST /api/v1/recognitions/{recognition_id}/choice: the station the listener picked in the "Which
 * station?" sheet. The recognition is named by the path, never the body; the "Remember my station" tick
 * never leaves the phone. Answered 204 for a first choice and for a repeat of the same one.
 */
export const RecognitionStationChoiceInput = z
  .strictObject({
    station_id: z.uuid(),
  })
  .meta({ id: 'RecognitionStationChoiceInput' });
export type RecognitionStationChoiceInput = z.infer<typeof RecognitionStationChoiceInput>;

/** For the listener app, which checks every body it builds against the contract. */
export function emitRecognitionStationChoiceInputJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://contracts.lookup.invalid/recognition-station-choice-input/1.json',
    ...z.toJSONSchema(RecognitionStationChoiceInput, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' }),
  };
}
