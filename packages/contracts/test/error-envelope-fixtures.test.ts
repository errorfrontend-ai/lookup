import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ErrorEnvelope } from '../src/errors/error-envelope-schema.js';
import { readFixtureFolder } from './fixtures.js';

/**
 * One error envelope per code the listener app maps to a screen (§3.11 of the Step 4 design), with
 * the HTTP status and Retry-After it comes with. The app's tests read these same files, so they are
 * checked here against the contract and against the API's own catalogue, which is read from its
 * source: the API is a separate workspace and nothing else of it is needed.
 */
interface EnvelopeFixture {
  description: string;
  http_status: number;
  retry_after_seconds?: number;
  body: { error: { code: string; message: string; request_id: string; fields?: unknown[] } };
}

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default as new (options: Record<string, unknown>) => {
  compile: (schema: unknown) => (data: unknown) => boolean;
};
const apiSourceDirectory = resolve(import.meta.dirname, '..', '..', '..', 'apps', 'api', 'src');
const { ERROR_CATALOG } = (await import(pathToFileURL(resolve(apiSourceDirectory, 'common', 'errors', 'error-catalog.ts')).href)) as {
  ERROR_CATALOG: Record<string, { httpStatus: number; message: string }>;
};
const recognitionServiceSource = readFileSync(resolve(apiSourceDirectory, 'features', 'recognition', 'recognition.service.ts'), 'utf8');
const retryAfterConstant = (name: string) => Number(new RegExp(`const ${name} = (\\d+);`).exec(recognitionServiceSource)?.[1]);

/** The fixed Retry-After the API sends with each code; RATE_LIMITED sends the seconds left in its window instead. */
const FIXED_RETRY_AFTER_SECONDS: Record<string, number> = {
  RECOGNITION_BUSY: retryAfterConstant('BUSY_RETRY_AFTER_SECONDS'),
  RECOGNITION_TIMEOUT: retryAfterConstant('TIMEOUT_RETRY_AFTER_SECONDS'),
  RECOGNITION_IN_PROGRESS: retryAfterConstant('IN_PROGRESS_RETRY_AFTER_SECONDS'),
};

const CODES_THE_APP_MAPS = [
  'RECOGNITION_BUSY',
  'RECOGNITION_TIMEOUT',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
  'RATE_LIMITED',
  'INSTALL_TOKEN_INVALID',
  'INVALID_AUDIO',
  'RECOGNITION_IN_PROGRESS',
  'VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'CAPTURE_EXPIRED',
  'CAPTURE_TIME_INVALID',
  'FORBIDDEN',
];

describe('the error envelopes the listener app maps', () => {
  const envelopes = readFixtureFolder<EnvelopeFixture>('errors/envelopes');
  const validateWithJsonSchema = new Ajv2020({ strict: true, allErrors: true }).compile(
    JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'schemas', 'error-envelope.schema.json'), 'utf8')),
  );

  it.each(envelopes.map(({ name, fixture }) => [name, fixture] as const))('%s is valid for zod and for the JSON Schema', (_name, fixture) => {
    expect(ErrorEnvelope.safeParse(fixture.body).success).toBe(true);
    expect(validateWithJsonSchema(fixture.body)).toBe(true);
  });

  it.each(envelopes.map(({ name, fixture }) => [name, fixture] as const))(
    "%s has the HTTP status and message the API's catalogue gives its code",
    (_name, fixture) => {
      const catalogueEntry = ERROR_CATALOG[fixture.body.error.code];
      expect(catalogueEntry).toBeDefined();
      expect(fixture.http_status).toBe(catalogueEntry?.httpStatus);
      expect(fixture.body.error.message).toBe(catalogueEntry?.message);
    },
  );

  it.each(envelopes.map(({ name, fixture }) => [name, fixture] as const))('%s has the Retry-After the API sends with it', (_name, fixture) => {
    const code = fixture.body.error.code;
    if (code === 'RATE_LIMITED') {
      expect(Number.isInteger(fixture.retry_after_seconds) && (fixture.retry_after_seconds ?? 0) >= 1).toBe(true);
    } else if (code in FIXED_RETRY_AFTER_SECONDS) {
      expect(FIXED_RETRY_AFTER_SECONDS[code]).toBeGreaterThan(0);
      expect(fixture.retry_after_seconds).toBe(FIXED_RETRY_AFTER_SECONDS[code]);
    } else {
      expect(fixture.retry_after_seconds).toBeUndefined();
    }
  });

  it('has one envelope for every code the app maps, and only those fields', () => {
    expect(envelopes.map(({ fixture }) => fixture.body.error.code).sort()).toEqual([...CODES_THE_APP_MAPS].sort());
    for (const { name, fixture } of envelopes) {
      const expectedKeys = ['body', 'description', 'http_status', ...(fixture.retry_after_seconds === undefined ? [] : ['retry_after_seconds'])];
      expect(Object.keys(fixture).sort(), name).toEqual(expectedKeys);
    }
    const validationFailed = envelopes.find(({ fixture }) => fixture.body.error.code === 'VALIDATION_FAILED');
    expect(validationFailed?.fixture.body.error.fields?.length).toBeGreaterThan(0);
  });
});
