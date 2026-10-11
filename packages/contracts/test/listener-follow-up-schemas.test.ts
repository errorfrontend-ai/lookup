import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { RecordEngagementInput } from '../src/recognition/engagement-schemas.js';
import { RECOGNITION_REPORT_REASONS, ReportRecognitionInput } from '../src/recognition/recognition-report-schemas.js';
import { RecognitionStationChoiceInput } from '../src/recognition/station-choice-schemas.js';
import { type ExpectedIssue, issuesFoundBy, readFixtureFolder } from './fixtures.js';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default as new (options: Record<string, unknown>) => {
  compile: (schema: unknown) => (data: unknown) => boolean;
};
const committedSchema = (fileName: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'schemas', fileName), 'utf8')) as {
    $ref?: string;
    $defs?: Record<string, { type?: string; properties?: Record<string, Record<string, unknown>>; additionalProperties?: boolean }>;
  };

interface BodyFixture {
  description: string;
  body: Record<string, unknown>;
}
interface InvalidBodyFixture extends BodyFixture {
  expected_issues: ExpectedIssue[];
}

/**
 * The bodies the listener app's outbox sends after a recognition: the station chosen in the chooser,
 * a button tap and "Report this". Each is checked by zod (the API) and by the emitted JSON Schema (the
 * app's checker), and each invalid fixture names the exact field and reason the API relays.
 */
const FOLLOW_UPS = [
  {
    folder: 'recognition/station-choice-input',
    schema: RecognitionStationChoiceInput as z.ZodType,
    schemaFile: 'recognition-station-choice-input.schema.json',
    validNames: ['choose-station-b'],
    invalidNames: ['missing-station-id', 'recognition-id-in-body', 'remember-flag-in-body', 'station-id-not-a-uuid'],
  },
  {
    folder: 'recognition/engagement-input',
    schema: RecordEngagementInput as z.ZodType,
    schemaFile: 'record-engagement-input.schema.json',
    validNames: ['call-button-tap', 'tap-sent-later-with-offset'],
    invalidNames: ['action-type-in-body', 'missing-occurred-at', 'missing-sent-at', 'occurred-at-without-time-zone', 'phone-number-in-body', 'recognition-id-version-4'],
  },
  {
    folder: 'recognition/recognition-report-input',
    schema: ReportRecognitionInput as z.ZodType,
    schemaFile: 'report-recognition-input.schema.json',
    validNames: ['looks-like-a-scam'],
    invalidNames: ['free-text-comment', 'unknown-reason'],
  },
] as const;

describe.each(FOLLOW_UPS)('$folder', ({ folder, schema, schemaFile, validNames, invalidNames }) => {
  const validateWithJsonSchema = new Ajv2020({ strict: true, allErrors: true, formats: { uuid: true, 'date-time': true } }).compile(committedSchema(schemaFile));
  const valid = readFixtureFolder<BodyFixture>(`${folder}/valid`);
  const invalid = readFixtureFolder<InvalidBodyFixture>(`${folder}/invalid`);

  it('has the fixtures the contract lists', () => {
    expect(valid.map(({ name }) => name).sort()).toEqual([...validNames]);
    expect(invalid.map(({ name }) => name).sort()).toEqual([...invalidNames]);
  });

  it.each(valid.map(({ name, fixture }) => [name, fixture] as const))('%s is valid for zod and for the JSON Schema, every value a string', (_name, fixture) => {
    expect(schema.safeParse(fixture.body).success).toBe(true);
    expect(validateWithJsonSchema(fixture.body)).toBe(true);
    for (const value of Object.values(fixture.body)) expect(typeof value).toBe('string');
  });

  // The exact path and code: what the API relays in VALIDATION_FAILED.fields, and why the case was written.
  it.each(invalid.map(({ name, fixture }) => [name, fixture] as const))('%s is refused by zod for its expected reason and by the JSON Schema', (_name, fixture) => {
    expect(fixture.expected_issues.length).toBeGreaterThan(0);
    expect(issuesFoundBy(schema, fixture.body)).toEqual(fixture.expected_issues);
    expect(validateWithJsonSchema(fixture.body)).toBe(false);
  });
});

describe('what a follow-up carries', () => {
  it('a choice names only the station; the recognition is in the path', () => {
    expect(Object.keys(RecognitionStationChoiceInput.shape)).toEqual(['station_id']);
  });

  it('a tap names the recognition, the station, the button and two phone times: never the button type, label, number or link', () => {
    expect(Object.keys(RecordEngagementInput.shape)).toEqual(['recognition_id', 'station_id', 'action_id', 'occurred_at', 'sent_at']);
  });

  it('a report names the station and one of exactly four reasons, with no free text', () => {
    expect(Object.keys(ReportRecognitionInput.shape)).toEqual(['station_id', 'reason']);
    expect(RECOGNITION_REPORT_REASONS).toEqual(['WRONG_OR_MISLEADING_BUTTONS', 'NUMBER_OR_LINK_DOES_NOT_WORK', 'LOOKS_LIKE_A_SCAM', 'SOMETHING_ELSE']);
  });
});

/**
 * The listener app's `ContractSchemaChecker` reads flat objects of strings only: it follows a top-level
 * `$ref` and understands these keywords, and fails on any other. Amendment A5: the follow-ups' bodies
 * must stay that way (no nested `$ref`, such as a recognition id with a registry id of its own would
 * make). The other bodies the app checks are held to the same rule.
 */
const KEYWORDS_THE_APP_CHECKER_READS = {
  object: new Set(['type', 'properties', 'required', 'additionalProperties', 'description']),
  property: new Set(['type', 'enum', 'const', 'pattern', 'format', 'minLength', 'maxLength', 'description']),
};

describe.each([
  'recognition-station-choice-input.schema.json',
  'record-engagement-input.schema.json',
  'report-recognition-input.schema.json',
  'recognize-request-fields.schema.json',
  'register-install-input.schema.json',
  'client-error-report.schema.json',
])('%s, as the listener app reads it', (schemaFile) => {
  const schema = committedSchema(schemaFile);
  const definitionName = schema.$ref?.replace('#/$defs/', '') ?? '';
  const definition = schema.$defs?.[definitionName];

  it('is one flat object definition reached by its top-level $ref, with nothing else defined', () => {
    expect(schema.$ref).toBe(`#/$defs/${definitionName}`);
    expect(Object.keys(schema.$defs ?? {})).toEqual([definitionName]);
    expect(definition?.type).toBe('object');
    expect(definition?.additionalProperties).toBe(false);
    for (const keyword of Object.keys(definition ?? {})) expect(KEYWORDS_THE_APP_CHECKER_READS.object.has(keyword), keyword).toBe(true);
  });

  it('holds only plain string properties, with no nested $ref, and a pattern wherever there is a format', () => {
    const properties = Object.entries(definition?.properties ?? {});
    expect(properties.length).toBeGreaterThan(0);
    for (const [name, property] of properties) {
      expect(property.type, name).toBe('string');
      expect(JSON.stringify(property), name).not.toContain('$ref');
      for (const keyword of Object.keys(property)) expect(KEYWORDS_THE_APP_CHECKER_READS.property.has(keyword), `${name}.${keyword}`).toBe(true);
      if ('format' in property) expect(property.pattern, name).toEqual(expect.any(String));
    }
  });
});
