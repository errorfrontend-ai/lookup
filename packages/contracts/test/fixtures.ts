import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { z } from 'zod';

export const FIXTURES_DIRECTORY = resolve(import.meta.dirname, '..', 'fixtures');

export interface ExpectedIssue {
  path: string;
  code: string;
}

/**
 * The problems zod finds, as the listener fixtures record them in `expected_issues`: the path joined
 * with dots ("" for the object as a whole) and zod's code, or for a rule of ours its reason. For a
 * request body that is exactly what the API relays in VALIDATION_FAILED.fields.
 */
export function issuesFoundBy(schema: z.ZodType, value: unknown): ExpectedIssue[] {
  const result = schema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code: issue.code === 'custom' ? String((issue as { params?: { reason?: unknown } }).params?.reason) : issue.code,
  }));
}

export function readFixtureFolder<Fixture>(relativeFolder: string): Array<{ name: string; fixture: Fixture }> {
  const folder = resolve(FIXTURES_DIRECTORY, relativeFolder);
  return readdirSync(folder)
    .filter((fileName) => fileName.endsWith('.json'))
    .sort()
    .map((fileName) => ({
      name: fileName.replace(/\.json$/, ''),
      fixture: JSON.parse(readFileSync(resolve(folder, fileName), 'utf8')) as Fixture,
    }));
}

export function readFixtureFile<Fixture>(relativePath: string): Fixture {
  return JSON.parse(readFileSync(resolve(FIXTURES_DIRECTORY, relativePath), 'utf8')) as Fixture;
}
