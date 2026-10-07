import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { IngestJobData, IngestJobResult, RecognizeJobData, RecognizeJobResult } from '../src/recognition/fingerprint-job-schemas.js';
import { readFixtureFolder } from './fixtures.js';

/**
 * The job fixtures the API and the Python workers share (S3-STRUCTURE-06): the workers' tests
 * (services/fingerprinter/tests/test_job_fixtures.py) read these same files, so both sides agree on
 * what a job and its result may hold.
 */

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default as new (options: Record<string, unknown>) => {
  compile: (schema: unknown) => (data: unknown) => boolean;
};
const schemasDirectory = resolve(import.meta.dirname, '..', 'schemas');
const committedSchema = (fileName: string) => JSON.parse(readFileSync(resolve(schemasDirectory, fileName), 'utf8')) as unknown;

const JOB_FIXTURE_FOLDERS: Array<{ folder: string; field: 'job' | 'result'; schema: z.ZodType; schemaFile: string }> = [
  { folder: 'recognition/recognize-job', field: 'job', schema: RecognizeJobData, schemaFile: 'recognize-job-data.schema.json' },
  { folder: 'recognition/recognize-job-result', field: 'result', schema: RecognizeJobResult, schemaFile: 'recognize-job-result.schema.json' },
  { folder: 'recognition/ingest-job', field: 'job', schema: IngestJobData, schemaFile: 'ingest-job-data.schema.json' },
  { folder: 'recognition/ingest-job-result', field: 'result', schema: IngestJobResult, schemaFile: 'ingest-job-result.schema.json' },
];

describe.each(JOB_FIXTURE_FOLDERS)('the $folder fixtures', ({ folder, field, schema, schemaFile }) => {
  const validateWithJsonSchema = new Ajv2020({ strict: true, allErrors: true, formats: { uuid: true, uri: true } }).compile(committedSchema(schemaFile));
  const valid = readFixtureFolder<Record<string, unknown>>(`${folder}/valid`);
  const invalid = readFixtureFolder<Record<string, unknown>>(`${folder}/invalid`);

  it.each(valid.map(({ name, fixture }) => [name, fixture[field]] as const))('%s is valid for zod and for the JSON Schema', (_name, value) => {
    expect(value).toBeTypeOf('object');
    expect(schema.safeParse(value).success).toBe(true);
    expect(validateWithJsonSchema(value)).toBe(true);
  });

  it.each(invalid.map(({ name, fixture }) => [name, fixture[field]] as const))('%s is refused by zod and by the JSON Schema', (_name, value) => {
    expect(value).toBeTypeOf('object');
    expect(schema.safeParse(value).success).toBe(false);
    expect(validateWithJsonSchema(value)).toBe(false);
  });

  it('has cases it must accept and cases it must refuse, each with a description', () => {
    expect(valid.length).toBeGreaterThanOrEqual(3);
    expect(invalid.length).toBeGreaterThanOrEqual(5);
    for (const { name, fixture } of [...valid, ...invalid]) {
      expect(Object.keys(fixture).sort(), name).toEqual(['description', field].sort());
    }
  });
});
