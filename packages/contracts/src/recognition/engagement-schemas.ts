import { z } from 'zod';
import { RecognitionId } from './recognize-schemas.js';

/**
 * POST /api/v1/engagements: one tap of a button on a card a recognition showed, sent by the phone's
 * outbox, perhaps much later. `occurred_at` is when the button was tapped and `sent_at` when this
 * attempt left the phone, both by the phone's clock, so the server can correct a wrong clock before
 * it clamps the time. Only ids travel: never the button's type, label, number or link. Answered 204
 * whether the tap was stored, was already stored, or did not count toward a limit.
 */
export const RecordEngagementInput = z
  .strictObject({
    recognition_id: RecognitionId,
    station_id: z.uuid(),
    action_id: z.uuid(),
    occurred_at: z.iso.datetime({ offset: true }),
    sent_at: z.iso.datetime({ offset: true }),
  })
  .meta({ id: 'RecordEngagementInput' });
export type RecordEngagementInput = z.infer<typeof RecordEngagementInput>;

/** For the listener app, which checks every body it builds against the contract. */
export function emitRecordEngagementInputJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://contracts.lookup.invalid/record-engagement-input/1.json',
    ...z.toJSONSchema(RecordEngagementInput, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' }),
  };
}
