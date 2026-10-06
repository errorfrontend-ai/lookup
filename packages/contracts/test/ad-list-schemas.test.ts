import { describe, expect, it } from 'vitest';
import { AD_LIST_SORTS, AD_LIST_VIEWS, AdListQuery, MAXIMUM_AD_SEARCH_LENGTH } from '../src/ads/ad-list-schemas.js';

describe('AdListQuery (the ads list request)', () => {
  it('needs nothing: it defaults to every ad, last updated first', () => {
    expect(AdListQuery.parse({})).toEqual({ view: 'all', sort: 'updated' });
  });

  it('accepts every tab and sort', () => {
    for (const view of AD_LIST_VIEWS) expect(AdListQuery.safeParse({ view }).success, view).toBe(true);
    for (const sort of AD_LIST_SORTS) expect(AdListQuery.safeParse({ sort }).success, sort).toBe(true);
  });

  it('trims the search, and refuses an empty or over-long one', () => {
    expect(AdListQuery.parse({ search: '  summer  ' }).search).toBe('summer');
    expect(AdListQuery.safeParse({ search: '   ' }).success).toBe(false);
    expect(AdListQuery.safeParse({ search: 'x'.repeat(MAXIMUM_AD_SEARCH_LENGTH + 1) }).success).toBe(false);
    expect(AdListQuery.safeParse({ search: 'x'.repeat(MAXIMUM_AD_SEARCH_LENGTH) }).success).toBe(true);
  });

  it.each([
    ['an unknown view', { view: 'everything' }],
    ['an unknown sort', { sort: 'loudest' }],
    ['a client id that is not a UUID', { clientId: 'brand-a' }],
    ['an unknown parameter', { page: '2' }],
    ['an empty cursor', { cursor: '' }],
  ])('refuses %s', (_case, query) => {
    expect(AdListQuery.safeParse(query).success).toBe(false);
  });
});
