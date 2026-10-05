import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatJsonSchema } from '../scripts/emit-json-schemas.js';
import { emitActionCardJsonSchema } from '../src/action-card/action-card-schema.js';
import { readFixtureFolder } from './fixtures.js';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default as new (options: Record<string, unknown>) => {
  compile: (schema: unknown) => (data: unknown) => boolean;
};

const committedSchemaPath = resolve(import.meta.dirname, '..', 'schemas', 'action-card.schema.json');

describe('action card JSON Schema (for the listener app)', () => {
  it('the committed file matches the zod schema — run `npm run emit-json-schemas` after changing it', () => {
    expect(readFileSync(committedSchemaPath, 'utf8')).toBe(formatJsonSchema(emitActionCardJsonSchema()));
  });

  // Strict mode refuses unknown keywords and formats, so this also proves the file is clean JSON Schema.
  const validateWithJsonSchema = new Ajv2020({ strict: true, allErrors: true, formats: { uuid: true } }).compile(
    JSON.parse(readFileSync(committedSchemaPath, 'utf8')),
  );

  it.each(readFixtureFolder<{ card: unknown }>('action-card/valid').map(({ name, fixture }) => [name, fixture] as const))(
    'agrees with zod that %s is valid',
    (_name, fixture) => {
      expect(validateWithJsonSchema(fixture.card)).toBe(true);
    },
  );

  const invalidFixtures = readFixtureFolder<{ card: unknown; zod_only: boolean }>('action-card/invalid');
  it.each(invalidFixtures.filter(({ fixture }) => !fixture.zod_only).map(({ name, fixture }) => [name, fixture] as const))(
    'agrees with zod that %s is invalid',
    (_name, fixture) => {
      expect(validateWithJsonSchema(fixture.card)).toBe(false);
    },
  );

  // Rules JSON Schema cannot express are documented as zod-only; the reader applies its own checks.
  it.each(invalidFixtures.filter(({ fixture }) => fixture.zod_only).map(({ name, fixture }) => [name, fixture] as const))(
    'leaves the zod-only rule in %s to zod',
    (_name, fixture) => {
      expect(validateWithJsonSchema(fixture.card)).toBe(true);
    },
  );
});
