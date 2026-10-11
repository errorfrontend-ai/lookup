import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClientErrorReport } from '../src/client-errors/client-error-schemas.js';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default as new (options: Record<string, unknown>) => {
  compile: (schema: unknown) => (data: unknown) => boolean;
};

/** The listener app checks the crash reports it builds against this file; the drift test is with the other emitted schemas. */
describe('client error report JSON Schema (for the listener app)', () => {
  // Strict mode refuses unknown keywords and formats, so this also proves the file is clean JSON Schema.
  const validateWithJsonSchema = new Ajv2020({ strict: true, allErrors: true, formats: { uuid: true, 'date-time': true } }).compile(
    JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'schemas', 'client-error-report.schema.json'), 'utf8')),
  );
  const listenerAppReport = {
    source: 'listener-app',
    kind: 'reported',
    message: 'RecorderFailure: the recorder could not start',
    stack: '#0      Recorder.start (package:lookup/listening/data/recorder.dart:42:7)',
    location: '/listening',
    relatedRequestId: '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f',
    appVersion: '1.0.0+1',
  };

  it('accepts a report the listener app sends, for zod and for the JSON Schema', () => {
    expect(ClientErrorReport.safeParse(listenerAppReport).success).toBe(true);
    expect(validateWithJsonSchema(listenerAppReport)).toBe(true);
  });

  it('accepts a report queued offline with the time it happened, in UTC or with an offset', () => {
    for (const occurredAt of ['2026-10-08T09:15:02.123Z', '2026-10-08T11:15:02.123+02:00']) {
      expect(ClientErrorReport.safeParse({ ...listenerAppReport, occurredAt }).success, occurredAt).toBe(true);
      expect(validateWithJsonSchema({ ...listenerAppReport, occurredAt }), occurredAt).toBe(true);
    }
  });

  it.each([
    ['a time it happened with no time zone', { ...listenerAppReport, occurredAt: '2026-10-08T11:15:02.123' }],
    ['a time it happened that is not a time', { ...listenerAppReport, occurredAt: 'yesterday' }],
    ['an install token', { ...listenerAppReport, installToken: 'abc' }],
    ['an empty message', { ...listenerAppReport, message: '' }],
    ['a message over 500 characters', { ...listenerAppReport, message: 'x'.repeat(501) }],
    ['a source that is not a client', { ...listenerAppReport, source: 'api' }],
    ['a related request id that is not a UUID', { ...listenerAppReport, relatedRequestId: 'request-1' }],
  ])('refuses a report with %s, for zod and for the JSON Schema', (_case, report) => {
    expect(ClientErrorReport.safeParse(report).success).toBe(false);
    expect(validateWithJsonSchema(report)).toBe(false);
  });
});
