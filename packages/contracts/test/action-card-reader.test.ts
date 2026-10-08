import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readActionCard } from '../src/action-card/action-card-reader.js';
import { buildActionUri } from '../src/action-card/action-uris.js';
import { FIXTURES_DIRECTORY, readFixtureFile, readFixtureFolder } from './fixtures.js';

interface ReaderFixture {
  description: string;
  card: unknown;
  expected: {
    visible_action_ids: string[];
    more_options_action_ids: string[];
    styles: string[];
    skipped_unknown_type_count: number;
    skipped_invalid_count: number;
    shows_update_app_hint: boolean;
  };
}

describe('tolerant card reader (the rules every app and preview follow)', () => {
  const readerFixtures = readFixtureFolder<ReaderFixture>('action-card/reader');

  it('has fixtures for every reader rule', () => {
    expect(readerFixtures.length).toBeGreaterThanOrEqual(18);
  });

  it.each(readerFixtures.map(({ name, fixture }) => [name, fixture] as const))('%s', (_name, fixture) => {
    const readCard = readActionCard(fixture.card);
    const shownActions = [...readCard.visibleActions, ...readCard.moreOptionsActions];
    expect({
      visible_action_ids: readCard.visibleActions.map((action) => action.id),
      more_options_action_ids: readCard.moreOptionsActions.map((action) => action.id),
      styles: shownActions.map((action) => action.style),
      skipped_unknown_type_count: readCard.skippedUnknownTypeCount,
      skipped_invalid_count: readCard.skippedInvalidCount,
      shows_update_app_hint: readCard.showsUpdateAppHint,
    }).toEqual(fixture.expected);
  });

  it('never throws, whatever it is given', () => {
    for (const notACard of [undefined, null, 0, 'text', [], {}, { actions: 'x' }, { schema_version: '1' }, { schema_version: 1.5 }]) {
      expect(() => readActionCard(notACard)).not.toThrow();
    }
  });

  // JSON.parse cannot tell 1.0 from 1, so the file itself must keep 1.0 for the Dart reader to meet it.
  it('keeps the traps between JavaScript and Dart: 1.0 as written, a label of only U+0085, a latitude of minus zero', () => {
    const fixtureNamed = (name: string) => readerFixtures.find((candidate) => candidate.name === name)?.fixture;
    const onePointZeroText = readFileSync(resolve(FIXTURES_DIRECTORY, 'action-card/reader/schema-version-written-as-one-point-zero.json'), 'utf8');
    expect(onePointZeroText).toContain('"schema_version": 1.0,');
    const labelCard = readActionCard(fixtureNamed('label-only-next-line-character-still-shown')?.card);
    expect(labelCard.visibleActions.map((action) => action.label)).toEqual(['\u0085']);
    const mapAction = readActionCard(fixtureNamed('map-latitude-minus-zero-still-shown')?.card).visibleActions[0];
    expect(mapAction?.type === 'MAP' && Object.is(mapAction.latitude, -0)).toBe(true);
  });
});

describe('button addresses', () => {
  const uriFixtures = readFixtureFile<Array<{ description: string; action: unknown; expected_uri: string | null }>>(
    'action-card/action-uris.json',
  );

  it.each(uriFixtures.map((fixture) => [fixture.description, fixture] as const))('%s', (_description, fixture) => {
    const readCard = readActionCard({ schema_version: 1, layout: 'VERTICAL_STACK', actions: [fixture.action] });
    const readAction = readCard.visibleActions[0];
    expect(readAction ? buildActionUri(readAction) : null).toBe(fixture.expected_uri);
  });
});
