/**
 * Writes the JSON Schema files that non-TypeScript readers (the Flutter listener app) use.
 * Run after changing a schema: `npm run emit-json-schemas -w @lookup/contracts`. A test fails when
 * the committed files and the schemas drift apart.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emitActionCardJsonSchema } from '../src/action-card/action-card-schema.js';
import { emitErrorEnvelopeJsonSchema } from '../src/errors/error-envelope-schema.js';

export const JSON_SCHEMA_FILES = {
  'action-card.schema.json': emitActionCardJsonSchema,
  'error-envelope.schema.json': emitErrorEnvelopeJsonSchema,
};

export function formatJsonSchema(schema: Record<string, unknown>): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [fileName, emit] of Object.entries(JSON_SCHEMA_FILES)) {
    writeFileSync(resolve(import.meta.dirname, '..', 'schemas', fileName), formatJsonSchema(emit()), 'utf8');
    console.log(`wrote schemas/${fileName}`);
  }
}
