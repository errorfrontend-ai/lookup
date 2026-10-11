import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ListenerStation, ListenerStationList, MAXIMUM_LISTED_STATIONS } from '../src/recognition/listener-station-schemas.js';
import { type ExpectedIssue, issuesFoundBy, readFixtureFolder } from './fixtures.js';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default as new (options: Record<string, unknown>) => {
  compile: (schema: unknown) => (data: unknown) => boolean;
};

interface ListFixture {
  description: string;
  response: { stations: Array<Record<string, unknown>> };
}
interface InvalidListFixture extends ListFixture {
  zod_only?: boolean;
  expected_issues: ExpectedIssue[];
}

/** GET /api/v1/stations, the "My station" picker's list: only public facts about each listed station. */
describe('the listener station list', () => {
  const validateWithJsonSchema = new Ajv2020({ strict: true, allErrors: true, formats: { uuid: true } }).compile(
    JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'schemas', 'listener-station-list.schema.json'), 'utf8')),
  );
  const valid = readFixtureFolder<ListFixture>('recognition/listener-station-list/valid');
  const invalid = readFixtureFolder<InvalidListFixture>('recognition/listener-station-list/invalid');

  it('has the fixtures the contract lists', () => {
    expect(valid.map(({ name }) => name).sort()).toEqual(['no-stations', 'station-without-city', 'two-stations']);
    expect(invalid.map(({ name }) => name).sort()).toEqual(['listed-flag-included', 'same-station-twice', 'station-id-not-a-uuid', 'station-status-included']);
  });

  it.each(valid.map(({ name, fixture }) => [name, fixture] as const))('%s is valid for zod and for the JSON Schema', (_name, fixture) => {
    expect(ListenerStationList.safeParse(fixture.response).success).toBe(true);
    expect(validateWithJsonSchema(fixture.response)).toBe(true);
  });

  it.each(invalid.map(({ name, fixture }) => [name, fixture] as const))('%s is refused by zod for its expected reason, and by the JSON Schema unless zod only', (_name, fixture) => {
    expect(issuesFoundBy(ListenerStationList, fixture.response)).toEqual(fixture.expected_issues);
    expect(validateWithJsonSchema(fixture.response)).toBe(fixture.zod_only === true);
  });

  it('lists stations by name, sends city as null when there is none, and allows an empty list', () => {
    const list = (name: string) => valid.find((fixture) => fixture.name === name)?.fixture.response.stations ?? [];
    expect(list('two-stations').map((station) => station.name)).toEqual(['Station A', 'Station B']);
    expect(list('station-without-city').some((station) => station.city === null)).toBe(true);
    expect(list('no-stations')).toEqual([]);
  });

  it('holds at most 1,000 stations', () => {
    const station = valid.find(({ name }) => name === 'two-stations')?.fixture.response.stations[0] as Record<string, unknown>;
    const stations = (count: number) => Array.from({ length: count }, (_unused, index) => ({ ...station, id: `0192a6c4-1111-4000-8000-${String(index).padStart(12, '0')}` }));
    expect(MAXIMUM_LISTED_STATIONS).toBe(1_000);
    expect(ListenerStationList.safeParse({ stations: stations(1_000) }).success).toBe(true);
    expect(ListenerStationList.safeParse({ stations: stations(1_001) }).success).toBe(false);
    expect(validateWithJsonSchema({ stations: stations(1_001) })).toBe(false);
  });

  it('a station never carries its status, its listing flag or any other field', () => {
    expect(Object.keys(ListenerStation.shape)).toEqual(['id', 'name', 'frequency_label', 'city', 'logo']);
  });
});
