import { z } from 'zod';

/** At most this many field problems are reported for one request. */
export const MAXIMUM_REPORTED_FIELD_PROBLEMS = 20;

/**
 * A request field that was refused: where it is ("actions.0.url", or "" for the request as a whole,
 * such as an unknown top-level key) and why, as a reason code.
 */
export const FieldProblem = z
  .strictObject({
    path: z.string().max(120),
    code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  })
  .meta({ id: 'FieldProblem' });
export type FieldProblem = z.infer<typeof FieldProblem>;

/**
 * Every error the API returns, whatever went wrong: a catalogue code, a message written for people,
 * and the request id a station quotes to support. Validation and publish refusals add the fields
 * that were refused, by path and reason code, never their values. Nothing else is ever included.
 */
export const ErrorEnvelope = z
  .strictObject({
    error: z.strictObject({
      code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
      message: z.string().min(1).max(300),
      request_id: z.string().min(1).max(64),
      fields: z.array(FieldProblem).min(1).max(MAXIMUM_REPORTED_FIELD_PROBLEMS).optional(),
    }),
  })
  .meta({ id: 'ErrorEnvelope' });
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export function emitErrorEnvelopeJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://contracts.lookup.invalid/error-envelope/1.json',
    ...z.toJSONSchema(ErrorEnvelope, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' }),
  };
}
