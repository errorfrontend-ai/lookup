import { LISTENER_AGE_BANDS, LISTENER_GENDERS, LISTENER_MIX_MINIMUM_GROUP_SIZE, OTHER_LISTENER_GROUPS } from '@lookup/contracts';
import { describe, expect, it } from 'vitest';
import { type ListenerGroupCount, suppressSmallGroups } from '../src/features/station-overview/listener-mix-suppression.js';

const OTHER = OTHER_LISTENER_GROUPS;
const genders = (female: number, male: number, another: number, preferNotToSay: number): Array<ListenerGroupCount<(typeof LISTENER_GENDERS)[number]>> => [
  { group: 'FEMALE', listeners: female },
  { group: 'MALE', listeners: male },
  { group: 'ANOTHER', listeners: another },
  { group: 'PREFER_NOT_TO_SAY', listeners: preferNotToSay },
];
const total = (counts: number[]) => counts.reduce((sum, count) => sum + count, 0);

/** Every way of splitting `known` listeners into `parts` groups, counted from 0. */
function* compositions(known: number, parts: number): Generator<number[]> {
  if (parts === 1) {
    yield [known];
    return;
  }
  for (let first = 0; first <= known; first++) for (const rest of compositions(known - first, parts - 1)) yield [first, ...rest];
}

describe('the small-group rule (LA-STATS-03)', () => {
  it('shows no breakdown below 10 known listeners: 0, 9', () => {
    expect(suppressSmallGroups(genders(0, 0, 0, 0), 0)).toBeNull();
    expect(suppressSmallGroups(genders(9, 0, 0, 0), 9)).toBeNull();
    expect(suppressSmallGroups(genders(5, 4, 0, 0), 9)).toBeNull();
  });

  it('at exactly 10 known listeners a group that is all of them is shown, with the zeros as 0', () => {
    expect(suppressSmallGroups(genders(10, 0, 0, 0), 10)).toEqual(genders(10, 0, 0, 0));
  });

  it('at 10, two small groups that add up to 10 become one "other groups" line, and the zeros stay as 0', () => {
    expect(suppressSmallGroups(genders(9, 1, 0, 0), 10)).toEqual([
      { group: 'ANOTHER', listeners: 0 },
      { group: 'PREFER_NOT_TO_SAY', listeners: 0 },
      { group: OTHER, listeners: 10 },
    ]);
  });

  it('at 11, a lone small group takes the smallest shown group in with it, so a small number cannot be taken from the total', () => {
    // 10 and 1: the 1 would be found as 11 minus 10, so the 10 joins it.
    expect(suppressSmallGroups(genders(10, 1, 0, 0), 11)).toEqual([
      { group: 'ANOTHER', listeners: 0 },
      { group: 'PREFER_NOT_TO_SAY', listeners: 0 },
      { group: OTHER, listeners: 11 },
    ]);
  });

  it('shows every group of 10 or more and every zero as it is, with no "other" line, when none is small', () => {
    expect(suppressSmallGroups(genders(12, 10, 0, 28), 50)).toEqual(genders(12, 10, 0, 28));
  });

  it('keeps the groups shown in their order, with "other groups" last', () => {
    expect(suppressSmallGroups(genders(25, 5, 5, 0), 35)).toEqual([
      { group: 'FEMALE', listeners: 25 },
      { group: 'PREFER_NOT_TO_SAY', listeners: 0 },
      { group: OTHER, listeners: 10 },
    ]);
  });

  it('adds the smallest shown group when the small ones add up to under 10, then again if it is still not enough', () => {
    // 2 + 3 = 5 is under 10: the smallest shown (MALE 12) joins, giving 17.
    expect(suppressSmallGroups(genders(25, 12, 2, 3), 42)).toEqual([
      { group: 'FEMALE', listeners: 25 },
      { group: OTHER, listeners: 17 },
    ]);
    // 1 + 1 = 2, then the 10 gives 12, which stands for three groups: enough.
    expect(suppressSmallGroups(genders(30, 10, 1, 1), 42)).toEqual([
      { group: 'FEMALE', listeners: 30 },
      { group: OTHER, listeners: 12 },
    ]);
  });

  it('a tie between the smallest shown groups is broken by the order they are shown in', () => {
    expect(suppressSmallGroups(genders(12, 12, 1, 0), 25)).toEqual([
      { group: 'MALE', listeners: 12 },
      { group: 'PREFER_NOT_TO_SAY', listeners: 0 },
      { group: OTHER, listeners: 13 },
    ]);
  });

  it('works for the six age bands in the same way', () => {
    const bands = LISTENER_AGE_BANDS.map((group, index) => ({ group, listeners: [0, 4, 30, 3, 0, 9][index]! }));
    expect(suppressSmallGroups(bands, 46)).toEqual([
      { group: 'UNDER_18', listeners: 0 },
      { group: 'AGE_25_TO_34', listeners: 30 },
      { group: 'AGE_45_TO_54', listeners: 0 },
      { group: OTHER, listeners: 16 },
    ]);
  });

  it('does not change what it is given', () => {
    const given = genders(25, 5, 5, 0);
    const copy = structuredClone(given);
    suppressSmallGroups(given, 35);
    expect(given).toEqual(copy);
  });

  it('shows nothing rather than something unsafe when the counts do not add up to the known listeners', () => {
    // 11 known, but the groups hold only 3, so the line could never be made safe.
    expect(suppressSmallGroups(genders(3, 0, 0, 0), 11)).toBeNull();
    expect(suppressSmallGroups(genders(1, 2, 0, 0), 12)).toBeNull();
  });

  describe.each([
    ['gender', 4],
    ['age band', 6],
  ])('for every way of splitting 10 to %s listeners into the %s groups', (_name, groupCount) => {
    it(`never shows a number from 1 to 9, an "other" line for fewer than two groups, or one under 10, and loses nobody (${groupCount} groups)`, () => {
      const upTo = groupCount === 4 ? 24 : 16;
      const names = groupCount === 4 ? LISTENER_GENDERS : LISTENER_AGE_BANDS;
      let checked = 0;
      for (let known = LISTENER_MIX_MINIMUM_GROUP_SIZE; known <= upTo; known++) {
        for (const counts of compositions(known, groupCount)) {
          const groups = names.map((group, index) => ({ group, listeners: counts[index]! }));
          const shown = suppressSmallGroups(groups, known);
          checked += 1;
          expect(shown, counts.join(',')).not.toBeNull();
          if (shown === null) continue;
          expect(total(shown.map((group) => group.listeners)), counts.join(',')).toBe(known);
          for (const group of shown) {
            if (group.group === OTHER) expect(group.listeners, counts.join(',')).toBeGreaterThanOrEqual(LISTENER_MIX_MINIMUM_GROUP_SIZE);
            else expect(group.listeners === 0 || group.listeners >= LISTENER_MIX_MINIMUM_GROUP_SIZE, `${counts.join(',')}: ${group.group}`).toBe(true);
          }
          const shownWithListeners = shown.filter((group) => group.group !== OTHER && group.listeners > 0).length;
          const inputWithListeners = counts.filter((count) => count > 0).length;
          if (shown.some((group) => group.group === OTHER)) {
            expect(inputWithListeners - shownWithListeners, `${counts.join(',')}: the other line stands for at least two groups`).toBeGreaterThanOrEqual(2);
          } else {
            expect(shown.map((group) => group.listeners), counts.join(',')).toEqual(counts);
          }
        }
      }
      expect(checked).toBeGreaterThan(1_000);
    });
  });
});
