import { describe, expect, it } from 'vitest';
import { readActionCard } from '../src/action-card/action-card-reader.js';
import { buildActionUri } from '../src/action-card/action-uris.js';
import { readFixtureFile, readFixtureFolder } from './fixtures.js';

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
    expect(readerFixtures.length).toBeGreaterThanOrEqual(15);
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
