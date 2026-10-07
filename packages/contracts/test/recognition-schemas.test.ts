import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatJsonSchema, JSON_SCHEMA_FILES } from '../scripts/emit-json-schemas.js';
import { IngestJobData, RECOGNIZE_JOB_FAILURE_CODES, RecognizeJobData, RecognizeJobResult } from '../src/recognition/fingerprint-job-schemas.js';
import { RegisterInstallInput } from '../src/recognition/listener-install-schemas.js';
import { MAXIMUM_CLIP_BYTES, RecognizeRequestFields, RecognizeResponse } from '../src/recognition/recognize-schemas.js';
import { readFixtureFolder } from './fixtures.js';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default as new (options: Record<string, unknown>) => {
  compile: (schema: unknown) => (data: unknown) => boolean;
};
const schemasDirectory = resolve(import.meta.dirname, '..', 'schemas');
const committedSchema = (fileName: string) => JSON.parse(readFileSync(resolve(schemasDirectory, fileName), 'utf8')) as unknown;

describe('the committed JSON Schemas', () => {
  it.each(Object.entries(JSON_SCHEMA_FILES))('%s matches its zod schema — run `npm run emit-json-schemas` after changing it', (fileName, emit) => {
    expect(readFileSync(resolve(schemasDirectory, fileName), 'utf8')).toBe(formatJsonSchema(emit()));
  });
});

const validFields = {
  clip_duration_milliseconds: '8000',
  codec: 'aac',
  idempotency_key: '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f',
  captured_at: '2026-10-07T06:30:00Z',
  sent_at: '2026-10-07T06:30:09.250+02:00',
  is_deferred: 'false',
};

describe('the recognize request fields', () => {
  it('reads the text fields of the multipart form into their values', () => {
    expect(RecognizeRequestFields.parse({ ...validFields, is_deferred: 'true', station_hint: '0192a6c4-1111-4000-8000-000000000001' })).toEqual({
      ...validFields,
      clip_duration_milliseconds: 8000,
      is_deferred: true,
      station_hint: '0192a6c4-1111-4000-8000-000000000001',
    });
    expect(RecognizeRequestFields.parse(validFields).station_hint).toBeUndefined();
  });

  it.each([['1999', false], ['2000', true], ['15000', true], ['15001', false], ['8000.5', false], ['', false], ['-3000', false]])(
    'a clip of %s milliseconds is accepted: %s',
    (duration, accepted) => {
      expect(RecognizeRequestFields.safeParse({ ...validFields, clip_duration_milliseconds: duration }).success).toBe(accepted);
    },
  );

  it.each(['clip_duration_milliseconds', 'codec', 'idempotency_key', 'captured_at', 'sent_at', 'is_deferred'])('needs %s, live or deferred', (field) => {
    for (const isDeferred of ['false', 'true']) {
      const { [field]: _removed, ...withoutIt } = { ...validFields, is_deferred: isDeferred } as Record<string, string>;
      const parsed = RecognizeRequestFields.safeParse(withoutIt);
      expect(parsed.success, `is_deferred ${isDeferred}`).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toContain(field);
    }
  });

  it('refuses an unknown codec, a key or hint that is not a UUID, a time that is not a timestamp, and any extra field', () => {
    for (const changed of [{ codec: 'mp3' }, { idempotency_key: 'retry-1' }, { station_hint: 'station-a' }, { captured_at: 'yesterday' }, { sent_at: 'yesterday' }, { sent_at: '' }, { is_deferred: 'yes' }, { fingerprint_hashes: '1,2,3' }]) {
      expect(RecognizeRequestFields.safeParse({ ...validFields, ...changed }).success, JSON.stringify(changed)).toBe(false);
    }
  });

  it('carries the clip itself, never fingerprint hashes: the app does no fingerprinting', () => {
    const schema = committedSchema('recognize-request-fields.schema.json') as { $ref: string; $defs: Record<string, { properties: object; additionalProperties: boolean }> };
    const fields = schema.$defs.RecognizeRequestFields as { properties: object; additionalProperties: boolean };
    expect(Object.keys(fields.properties).sort()).toEqual(['captured_at', 'clip_duration_milliseconds', 'codec', 'idempotency_key', 'is_deferred', 'sent_at', 'station_hint']);
    expect(fields.additionalProperties).toBe(false);
    expect(MAXIMUM_CLIP_BYTES).toBe(256 * 1024);
  });
});

describe('the recognize response', () => {
  const validateWithJsonSchema = new Ajv2020({ strict: true, allErrors: true, formats: { uuid: true, 'date-time': true, uri: true } }).compile(
    committedSchema('recognize-response.schema.json'),
  );
  const valid = readFixtureFolder<{ response: unknown }>('recognition/recognize-response/valid');
  const invalid = readFixtureFolder<{ response: unknown }>('recognition/recognize-response/invalid');

  it.each(valid.map(({ name, fixture }) => [name, fixture.response] as const))('%s is valid for zod and for the JSON Schema', (_name, response) => {
    expect(RecognizeResponse.safeParse(response).success).toBe(true);
    expect(validateWithJsonSchema(response)).toBe(true);
  });

  it.each(invalid.map(({ name, fixture }) => [name, fixture.response] as const))('%s is refused by zod and by the JSON Schema', (_name, response) => {
    expect(RecognizeResponse.safeParse(response).success).toBe(false);
    expect(validateWithJsonSchema(response)).toBe(false);
  });

  it('a card sent to a listener keeps every rule of a saved card: a repeated button id, a short Zambian number, a link that is not canonical https, a shortener or a map at 0,0 is refused', () => {
    const match = valid.find(({ name }) => name === 'match-campaign')?.fixture.response as { result: { card: { actions: Array<Record<string, unknown>> } } };
    expect(RecognizeResponse.safeParse(match).success).toBe(true);
    const withActions = (actions: Array<Record<string, unknown>>) => ({ ...match, result: { ...match.result, card: { ...match.result.card, actions } } });
    const button = (changes: Record<string, unknown>) => ({ id: '0192a6c4-0000-4000-8000-0000000000d1', label: 'Tap', style: 'PRIMARY', ...changes });
    const refusedCards = [
      [button({ type: 'CALL', phone_number_e164: '+260977123456' }), button({ type: 'CALL', phone_number_e164: '+260966123456' })],
      [button({ type: 'CALL', phone_number_e164: '+26097712345' })],
      [button({ type: 'LINK', url: 'https://Example.com/offer' })],
      [button({ type: 'LINK', url: 'https://bit.ly/offer' })],
      [button({ type: 'MAP', latitude: 0, longitude: 0 })],
    ];
    for (const actions of refusedCards) expect(RecognizeResponse.safeParse(withActions(actions)).success, JSON.stringify(actions)).toBe(false);
    expect(RecognizeResponse.safeParse(withActions([button({ type: 'LINK', url: 'https://example.com/offer' })])).success).toBe(true);
  });

  it('has fixtures for every status it allows and the cases it must refuse', () => {
    expect(valid.length).toBeGreaterThanOrEqual(5);
    expect(invalid.length).toBeGreaterThanOrEqual(10);
  });
});

describe('install registration', () => {
  it('takes the install id, the platform and the app version, and nothing else', () => {
    const input = { install_id: '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f', platform: 'ANDROID', app_version: '1.0.0+12' };
    expect(RegisterInstallInput.parse(input)).toEqual(input);
    for (const changed of [{ platform: 'HUAWEI' }, { platform: 'android' }, { install_id: 'phone-123' }, { app_version: '' }, { app_version: 'x'.repeat(33) }, { email: 'a@b.test' }]) {
      expect(RegisterInstallInput.safeParse({ ...input, ...changed }).success, JSON.stringify(changed)).toBe(false);
    }
  });
});

describe('the fingerprint jobs', () => {
  it('a recognize job holds exactly the request id, the clip, the codec, the deadline and the fingerprint version', () => {
    const job = { request_id: 'r-1', audio_base64: 'AAAA', codec: 'aac', deadline_epoch_milliseconds: 1_791_000_000_000, fingerprint_version: 1 };
    expect(RecognizeJobData.parse(job)).toEqual(job);
    for (const extra of [{ listener_install_id: 'x' }, { station_id: 'x' }, { station_hint: 'x' }, { captured_at: 'x' }, { install_token: 'x' }]) {
      expect(RecognizeJobData.safeParse({ ...job, ...extra }).success, Object.keys(extra)[0]).toBe(false);
    }
  });

  it('a recognize result names the recording by its number and carries no infinite margin', () => {
    const match = { status: 'MATCH', audio_asset_number: 17, aligned_hash_count: 42, match_margin: null, match_offset_milliseconds: 6000 };
    expect(RecognizeJobResult.parse(match)).toEqual(match);
    expect(RecognizeJobResult.safeParse({ ...match, match_margin: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(RecognizeJobResult.safeParse({ ...match, ad_id: 'x' }).success).toBe(false);
    expect(RecognizeJobResult.safeParse({ ...match, status: 'ERROR' }).success).toBe(false);
    expect(RECOGNIZE_JOB_FAILURE_CODES).toContain('INVALID_AUDIO');
  });

  it('an ingest job carries a download address, never storage credentials', () => {
    const job = { request_id: 'r-2', ad_id: '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f', download_address: 'http://127.0.0.1:39000/b/k?X-Amz-Signature=s', deadline_epoch_milliseconds: 1, fingerprint_version: 1 };
    expect(IngestJobData.parse(job)).toEqual(job);
    expect(IngestJobData.safeParse({ ...job, access_key_id: 'x', secret_access_key: 'y' }).success).toBe(false);
  });
});
