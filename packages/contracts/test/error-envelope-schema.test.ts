import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatJsonSchema } from '../scripts/emit-json-schemas.js';
import { emitErrorEnvelopeJsonSchema, ErrorEnvelope } from '../src/errors/error-envelope-schema.js';

const committedSchemaPath = resolve(import.meta.dirname, '..', 'schemas', 'error-envelope.schema.json');

/** S2-CONTRACTS-02: the one shape every API error takes, shared with the portal and the listener app. */
describe('error envelope', () => {
  it('the committed JSON Schema matches the zod schema — run `npm run emit-json-schemas` after changing it', () => {
    expect(readFileSync(committedSchemaPath, 'utf8')).toBe(formatJsonSchema(emitErrorEnvelopeJsonSchema()));
  });

  it('accepts a plain error and a validation error with fields', () => {
    expect(ErrorEnvelope.safeParse({ error: { code: 'NOT_FOUND', message: 'We could not find that.', request_id: 'f00dcafe' } }).success).toBe(true);
    const withFields = { error: { code: 'VALIDATION_FAILED', message: 'Check the fields.', request_id: 'f00dcafe', fields: [{ path: 'actions.0.url', code: 'link_uses_url_shortener' }] } };
    expect(ErrorEnvelope.safeParse(withFields).success).toBe(true);
    const wholeRequest = { error: { code: 'VALIDATION_FAILED', message: 'Check the fields.', request_id: 'f00dcafe', fields: [{ path: '', code: 'unrecognized_keys' }] } };
    expect(ErrorEnvelope.safeParse(wholeRequest).success).toBe(true);
  });

  it.each([
    ['an extra key (a stack, say)', { error: { code: 'INTERNAL', message: 'Something went wrong.', request_id: 'f00dcafe', stack: 'at x' } }],
    ['a missing request id', { error: { code: 'INTERNAL', message: 'Something went wrong.' } }],
    ['a code that is not a catalogue code', { error: { code: 'QueryFailedError: duplicate key', message: 'x', request_id: 'f00dcafe' } }],
    ['a field that carries its value', { error: { code: 'VALIDATION_FAILED', message: 'x', request_id: 'f00dcafe', fields: [{ path: 'email', code: 'invalid', value: 'a@b.test' }] } }],
    ['an empty fields list', { error: { code: 'VALIDATION_FAILED', message: 'x', request_id: 'f00dcafe', fields: [] } }],
  ])('refuses %s', (_case, envelope) => {
    expect(ErrorEnvelope.safeParse(envelope).success).toBe(false);
  });
});
