import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const FIXTURES_DIRECTORY = resolve(import.meta.dirname, '..', 'fixtures');

export interface ExpectedIssue {
  path: string;
  code: string;
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
