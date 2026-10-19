import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatJsonSchema, JSON_SCHEMA_FILES } from '../scripts/emit-json-schemas.js';
import { IngestJobData, RECOGNIZE_JOB_FAILURE_CODES, RecognizeJobData, RecognizeJobResult } from '../src/recognition/fingerprint-job-schemas.js';
import { RegisterInstallInput } from '../src/recognition/listener-install-schemas.js';
import { ListenerStation } from '../src/recognition/listener-station-schemas.js';
import {
  MAXIMUM_CHOOSER_CANDIDATES,
  MAXIMUM_CLIP_BYTES,
  MINIMUM_CHOOSER_CANDIDATES,
  RecognitionId,
  RecognitionResult,
  RecognizeRequestFields,
  RecognizeResponse,
} from '../src/recognition/recognize-schemas.js';
import { type ExpectedIssue, issuesFoundBy, readFixtureFolder } from './fixtures.js';

/** An invalid fixture names why it is refused; `zod_only` marks a rule JSON Schema cannot express. */
interface InvalidFixture {
  description: string;
  zod_only?: boolean;
  expected_issues: ExpectedIssue[];
}

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

describe('the recognize request fixtures (the text fields the listener app sends)', () => {
  const validateWithJsonSchema = new Ajv2020({ strict: true, allErrors: true, formats: { uuid: true, 'date-time': true } }).compile(
    committedSchema('recognize-request-fields.schema.json'),
  );
  const valid = readFixtureFolder<{ fields: unknown }>('recognition/recognize-request/valid');
  const invalid = readFixtureFolder<InvalidFixture & { fields: unknown }>('recognition/recognize-request/invalid');

  it.each(valid.map(({ name, fixture }) => [name, fixture.fields] as const))('%s is valid for zod and for the JSON Schema', (_name, fields) => {
    expect(RecognizeRequestFields.safeParse(fields).success).toBe(true);
    expect(validateWithJsonSchema(fields)).toBe(true);
  });

  // The exact path and code: what the API relays in VALIDATION_FAILED.fields, and why the case was written.
  it.each(invalid.map(({ name, fixture }) => [name, fixture] as const))('%s is refused by zod for its expected reason and by the JSON Schema', (_name, fixture) => {
    expect(issuesFoundBy(RecognizeRequestFields, fixture.fields)).toEqual(fixture.expected_issues);
    expect(validateWithJsonSchema(fixture.fields)).toBe(false);
  });

  it('has the live and deferred sends the app makes, with and without a hint, and the mistakes it must not make', () => {
    expect(valid.map(({ name }) => name).sort()).toEqual(['deferred-send-from-the-outbox', 'live-identify', 'live-identify-with-station-hint']);
    expect(invalid.map(({ name }) => name).sort()).toEqual(['is-deferred-as-yes', 'listener-install-id', 'station-hint-not-a-uuid', 'times-without-a-time-zone']);
  });

  it('a send from the outbox says so, keeps the capture time and the key, and carries the hint taken at capture', () => {
    const deferred = RecognizeRequestFields.parse(valid.find(({ name }) => name === 'deferred-send-from-the-outbox')?.fixture.fields);
    expect(deferred).toMatchObject({ is_deferred: true, captured_at: '2026-10-08T10:00:00.000Z', sent_at: '2026-10-08T11:30:00.000Z' });
    expect(deferred.station_hint).toMatch(/^[0-9a-f-]{36}$/);
    const live = valid.find(({ name }) => name === 'live-identify')?.fixture.fields as Record<string, string>;
    const hinted = valid.find(({ name }) => name === 'live-identify-with-station-hint')?.fixture.fields as Record<string, string>;
    // The same live fields, with the hint added last (the text fields all come before the audio part).
    expect(Object.keys(hinted)).toEqual([...Object.keys(live), 'station_hint']);
    expect({ ...hinted, station_hint: undefined }).toEqual({ ...live, station_hint: undefined });
  });
});

describe('the recognize response', () => {
  const validateWithJsonSchema = new Ajv2020({ strict: true, allErrors: true, formats: { uuid: true, 'date-time': true, uri: true } }).compile(
    committedSchema('recognize-response.schema.json'),
  );
  const valid = readFixtureFolder<{ response: unknown }>('recognition/recognize-response/valid');
  const invalid = readFixtureFolder<InvalidFixture & { response: unknown }>('recognition/recognize-response/invalid');

  it.each(valid.map(({ name, fixture }) => [name, fixture.response] as const))('%s is valid for zod and for the JSON Schema', (_name, response) => {
    expect(RecognizeResponse.safeParse(response).success).toBe(true);
    expect(validateWithJsonSchema(response)).toBe(true);
  });

  it.each(invalid.map(({ name, fixture }) => [name, fixture] as const))('%s is refused by zod for its expected reason, and by the JSON Schema unless zod only', (_name, fixture) => {
    expect(issuesFoundBy(RecognizeResponse, fixture.response)).toEqual(fixture.expected_issues);
    // A zod-only rule must really be beyond JSON Schema, or the flag would hide a gap in the emitted file.
    expect(validateWithJsonSchema(fixture.response)).toBe(fixture.zod_only === true);
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

  it('has fixtures for every status it allows, every kind of chooser, and the cases it must refuse', () => {
    expect(valid.map(({ name }) => name).sort()).toEqual([
      'account-required',
      'account-required-deferred',
      'choose-station',
      'choose-station-deferred',
      'choose-station-four-candidates',
      'choose-station-out-of-window',
      'choose-station-three-candidates',
      'match-campaign',
      'match-campaign-station-b',
      'match-client-default',
      'match-station-without-city',
      'match-with-images',
      'no-match',
      'no-match-deferred-with-offset',
    ]);
    expect(invalid.map(({ name }) => name).sort()).toEqual([
      'account-required-with-result',
      'account-required-with-station-name',
      'ambiguous-status',
      'audio-asset-number',
      'candidate-with-campaign-id',
      'choose-station-five-candidates',
      'choose-station-one-candidate',
      'choose-station-same-station-twice',
      'choose-station-with-result',
      'header-image-not-https',
      'match-found-status',
      'match-scores',
      'match-without-result',
      'missing-is-deferred',
      'no-match-with-candidates',
      'no-match-with-result',
      'recognition-id-version-4',
      'station-engagement-limit',
      'station-without-city-field',
      'tenant-id',
      'unknown-result-kind',
    ]);
  });

  it('P4-CHOOSER-01: a chooser answer carries its candidates and no top-level result, for zod and for the JSON Schema', () => {
    const choosers = valid.filter(({ name }) => name.startsWith('choose-station'));
    expect(choosers.length).toBeGreaterThanOrEqual(5);
    for (const { name, fixture } of choosers) {
      const response = fixture.response as Record<string, unknown>;
      expect(Array.isArray(response.candidates), name).toBe(true);
      expect(response, name).not.toHaveProperty('result');
    }
    const withResult = invalid.find(({ name }) => name === 'choose-station-with-result')?.fixture.response;
    expect(RecognizeResponse.safeParse(withResult).success).toBe(false);
    expect(validateWithJsonSchema(withResult)).toBe(false);
  });

  it('the choosers offer 2, 3 and 4 stations with a card each, every one a default card only out of window', () => {
    type Chooser = { is_deferred: boolean; candidates: Array<{ kind: string; card: { actions: Array<{ id: string }> } }> };
    const chooser = (name: string) => valid.find((fixture) => fixture.name === name)?.fixture.response as Chooser;
    expect(['choose-station', 'choose-station-three-candidates', 'choose-station-four-candidates'].map((name) => chooser(name).candidates.length)).toEqual([2, 3, 4]);
    for (const name of ['choose-station', 'choose-station-three-candidates', 'choose-station-four-candidates', 'choose-station-out-of-window', 'choose-station-deferred']) {
      // Each card has its own button ids, so a tap names exactly one card.
      const actionIds = chooser(name).candidates.flatMap((candidate) => candidate.card.actions.map((action) => action.id));
      expect(new Set(actionIds).size, name).toBe(actionIds.length);
    }
    expect(chooser('choose-station').candidates.map((candidate) => candidate.kind)).toEqual(['CAMPAIGN', 'CAMPAIGN']);
    expect(chooser('choose-station-four-candidates').candidates.map((candidate) => candidate.kind)).toEqual(['CAMPAIGN', 'CAMPAIGN', 'CAMPAIGN', 'CLIENT_DEFAULT']);
    expect(chooser('choose-station-out-of-window').candidates.map((candidate) => candidate.kind)).toEqual(['CLIENT_DEFAULT', 'CLIENT_DEFAULT']);
    expect(chooser('choose-station-deferred').is_deferred).toBe(true);
  });

  it('every number in the answers is from the drama range and every link on example.com, each card of a chooser with its own numbers', () => {
    const numbersAndLinks: Array<[string, string]> = [];
    const collect = (name: string, node: unknown) => {
      if (Array.isArray(node)) node.forEach((item) => collect(name, item));
      else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if ((key === 'phone_number_e164' || key === 'url') && typeof value === 'string') numbersAndLinks.push([name, value]);
          else collect(name, value);
        }
      }
    };
    for (const { name, fixture } of [...valid, ...invalid]) collect(name, fixture.response);
    expect(numbersAndLinks.length).toBeGreaterThan(50);
    for (const [name, value] of numbersAndLinks) expect(value, name).toMatch(/^(?:\+447700900\d{3}|https:\/\/example\.com\/.*)$/);
    for (const { name, fixture } of valid.filter((fixture) => fixture.name.startsWith('choose-station'))) {
      const cards = (fixture.response as { candidates: Array<{ card: { actions: Array<{ phone_number_e164?: string }> } }> }).candidates;
      const numbers = cards.flatMap((candidate) => [...new Set(candidate.card.actions.flatMap((action) => action.phone_number_e164 ?? []))]);
      expect(new Set(numbers).size, name).toBe(numbers.length);
    }
  });
});

describe('the chooser and the shared listener station', () => {
  const match = readFixtureFolder<{ response: z.infer<typeof RecognizeResponse> & { status: 'MATCH' } }>('recognition/recognize-response/valid').find(
    ({ name }) => name === 'match-campaign',
  )?.fixture.response as z.infer<typeof RecognizeResponse> & { status: 'MATCH' };
  const { result: matchResult, ...matchWithoutResult } = match;
  const candidate = (stationId: string) => ({ ...matchResult, station: { ...matchResult.station, id: stationId } });
  const chooser = (stationIds: string[]) => ({ ...matchWithoutResult, status: 'CHOOSE_STATION', candidates: stationIds.map(candidate) });
  const stationIds = [1, 2, 3, 4, 5].map((number) => `0192a6c4-1111-4000-8000-00000000000${number}`);

  it('offers from 2 to 4 stations', () => {
    expect([MINIMUM_CHOOSER_CANDIDATES, MAXIMUM_CHOOSER_CANDIDATES]).toEqual([2, 4]);
    const accepted = [1, 2, 3, 4, 5].map((count) => RecognizeResponse.safeParse(chooser(stationIds.slice(0, count))).success);
    expect(accepted).toEqual([false, true, true, true, false]);
  });

  it('names each station once, wherever the repeat is', () => {
    const [first, second, third] = stationIds as [string, string, string];
    expect(issuesFoundBy(RecognizeResponse, chooser([first, second, first]))).toEqual([{ path: 'candidates.2.station.id', code: 'candidate_station_repeated' }]);
    expect(issuesFoundBy(RecognizeResponse, chooser([first, second, second, third]))).toEqual([{ path: 'candidates.2.station.id', code: 'candidate_station_repeated' }]);
    expect(issuesFoundBy(RecognizeResponse, chooser([first, second, third]))).toEqual([]);
  });

  it('a result and a candidate carry the same public station: id, name, frequency, city (null when unknown) and logo', () => {
    expect(RecognitionResult.shape.station).toBe(ListenerStation);
    expect(Object.keys(ListenerStation.shape)).toEqual(['id', 'name', 'frequency_label', 'city', 'logo']);
    expect(ListenerStation.safeParse({ ...matchResult.station, city: null }).success).toBe(true);
    expect(ListenerStation.safeParse({ ...matchResult.station, city: 'x'.repeat(80) }).success).toBe(true);
    expect(ListenerStation.safeParse({ ...matchResult.station, city: '' }).success).toBe(false);
    expect(ListenerStation.safeParse({ ...matchResult.station, city: 'x'.repeat(81) }).success).toBe(false);
  });

  it('the recognition id is a lower-case UUID version 7 with no registry id of its own (amendment A5)', () => {
    expect(z.globalRegistry.get(RecognitionId)?.id).toBeUndefined();
    expect(RecognitionId.safeParse('0199b2c4-5a6e-7c3d-8f10-2b3c4d5e6f70').success).toBe(true);
    for (const refused of ['0199B2C4-5A6E-7C3D-8F10-2B3C4D5E6F70', '6f1c2d3e-4b5a-4c7d-9e8f-0a1b2c3d4e5f', '0199b2c4-5a6e-7c3d-cf10-2b3c4d5e6f70', '']) {
      expect(RecognitionId.safeParse(refused).success, refused).toBe(false);
    }
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
