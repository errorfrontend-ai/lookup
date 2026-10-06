import { describe, expect, it } from 'vitest';
import { adListRequestQuery, adListSearchParams, readAdListFilters } from './ad-list-filters';

const CLIENT_ID = '0190f1a2-0000-7000-8000-0000000000a1';

describe('the ads list filters in the address', () => {
  it('an empty address means every ad, last changed first', () => {
    expect(readAdListFilters(new URLSearchParams(''))).toEqual({ view: 'all', clientId: undefined, search: undefined, sort: 'updated' });
  });

  it('reads each filter', () => {
    const filters = readAdListFilters(new URLSearchParams(`view=live&client=${CLIENT_ID}&q=%20summer%20&sort=title`));
    expect(filters).toEqual({ view: 'live', clientId: CLIENT_ID, search: 'summer', sort: 'title' });
  });

  it('ignores anything it does not recognise, so a hand-edited address never breaks the page', () => {
    expect(readAdListFilters(new URLSearchParams('view=everything&client=not-a-uuid&sort=loudest&q=%20%20'))).toEqual({
      view: 'all',
      clientId: undefined,
      search: undefined,
      sort: 'updated',
    });
    expect(readAdListFilters(new URLSearchParams(`q=${'x'.repeat(200)}`)).search).toHaveLength(80);
  });

  it('writes only what differs from the defaults, so addresses stay short', () => {
    expect(adListSearchParams({ view: 'all', clientId: undefined, search: undefined, sort: 'updated' }).toString()).toBe('');
    expect(adListSearchParams({ view: 'attention', clientId: CLIENT_ID, search: 'a b', sort: 'startDate' }).toString()).toBe(
      `view=attention&client=${CLIENT_ID}&q=a+b&sort=startDate`,
    );
  });

  it('what is written is read back the same', () => {
    const filters = { view: 'scheduled', clientId: CLIENT_ID, search: '100% juice', sort: 'title' } as const;
    expect(readAdListFilters(adListSearchParams(filters))).toEqual(filters);
  });

  it('asks the API with its own parameter names, adding the cursor for later pages', () => {
    const filters = { view: 'live', clientId: CLIENT_ID, search: 'summer', sort: 'title' } as const;
    expect(new URLSearchParams(adListRequestQuery(filters)).get('clientId')).toBe(CLIENT_ID);
    expect(new URLSearchParams(adListRequestQuery(filters)).get('search')).toBe('summer');
    expect(new URLSearchParams(adListRequestQuery(filters, 'next-page')).get('cursor')).toBe('next-page');
    expect(new URLSearchParams(adListRequestQuery({ view: 'all', clientId: undefined, search: undefined, sort: 'updated' })).toString()).toBe('view=all&sort=updated');
  });
});
