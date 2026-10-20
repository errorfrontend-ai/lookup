import { describe, expect, it } from 'vitest';
import { LISTENER_AGE_BANDS, LISTENER_GENDERS } from '../src/listener-accounts/listener-account-schemas.js';
import { LISTENER_FIGURES_RANGES } from '../src/stations/listener-figures-schemas.js';
import { LISTENER_MIX_MINIMUM_GROUP_SIZE, ListenerMix, ListenerMixQuery, OTHER_LISTENER_GROUPS } from '../src/stations/listener-mix-schemas.js';

const valid = {
  range: 'last7Days',
  firstDay: '2026-10-14',
  lastDay: '2026-10-20',
  listeners: 40,
  knownListeners: 32,
  notKnownYetListeners: 8,
  genders: [
    { group: 'FEMALE', listeners: 20 },
    { group: 'MALE', listeners: 12 },
    { group: 'ANOTHER', listeners: 0 },
    { group: 'PREFER_NOT_TO_SAY', listeners: 0 },
  ],
  ageBands: [
    { group: 'AGE_18_TO_24', listeners: 15 },
    { group: 'AGE_25_TO_34', listeners: 17 },
  ],
};

describe('who is listening (LA-STATS-04, -05)', () => {
  it('LA-STATS-05: the ranges are the same three as the listener figures, the last 7 days by default', () => {
    expect(ListenerMixQuery.parse({})).toEqual({ range: 'last7Days' });
    for (const range of LISTENER_FIGURES_RANGES) expect(ListenerMixQuery.parse({ range })).toEqual({ range });
    expect(ListenerMixQuery.safeParse({ range: '1d' }).success).toBe(false);
    expect(ListenerMixQuery.safeParse({ range: 'today', extra: '1' }).success).toBe(false);
  });

  it('LA-STATS-04: the answer is counts of groups: the two breakdowns, or nothing while there are too few known listeners', () => {
    expect(ListenerMix.parse(valid)).toEqual(valid);
    expect(ListenerMix.parse({ ...valid, genders: null, ageBands: null })).toMatchObject({ genders: null, ageBands: null });
    expect(LISTENER_MIX_MINIMUM_GROUP_SIZE).toBe(10);
  });

  it('LA-STATS-04, LA-PRIVACY-05: nothing about a person can be added to it: no email, gender or age of anyone, no id, no row per listener, no grid', () => {
    for (const extra of [
      { email: 'listener@example.com' },
      { gender: 'FEMALE' },
      { age: 34 },
      { listenerId: 'x' },
      { listeners_list: [] },
      { genderByAgeBand: [] },
    ]) {
      expect(ListenerMix.safeParse({ ...valid, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(ListenerMix.safeParse({ ...valid, genders: [{ group: 'FEMALE', listeners: 20, ageBand: 'AGE_18_TO_24' }] }).success).toBe(false);
    expect(ListenerMix.safeParse({ ...valid, genders: [{ group: 'FEMALE', listeners: 20, id: 'x' }] }).success).toBe(false);
  });

  it('LA-STATS-04: a group is one of the contract\'s genders or age bands, or "other groups", and a count is a whole number from 0', () => {
    for (const group of [...LISTENER_GENDERS, OTHER_LISTENER_GROUPS]) expect(ListenerMix.safeParse({ ...valid, genders: [{ group, listeners: 12 }] }).success, group).toBe(true);
    for (const group of [...LISTENER_AGE_BANDS, OTHER_LISTENER_GROUPS]) expect(ListenerMix.safeParse({ ...valid, ageBands: [{ group, listeners: 12 }] }).success, group).toBe(true);
    expect(ListenerMix.safeParse({ ...valid, genders: [{ group: 'AGE_18_TO_24', listeners: 12 }] }).success).toBe(false);
    expect(ListenerMix.safeParse({ ...valid, ageBands: [{ group: 'FEMALE', listeners: 12 }] }).success).toBe(false);
    for (const listeners of [-1, 1.5, '12']) {
      expect(ListenerMix.safeParse({ ...valid, genders: [{ group: 'FEMALE', listeners }] }).success, String(listeners)).toBe(false);
    }
  });
});
