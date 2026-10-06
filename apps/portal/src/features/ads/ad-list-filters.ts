import { AD_LIST_SORTS, AD_LIST_VIEWS, type AdListSort, type AdListView, MAXIMUM_AD_SEARCH_LENGTH } from '@lookup/contracts';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

export interface AdListFilters {
  view: AdListView;
  clientId: string | undefined;
  search: string | undefined;
  sort: AdListSort;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the ads list's tab, client, search and sort from the address, ignoring anything it does not recognise. */
export function readAdListFilters(searchParams: URLSearchParams): AdListFilters {
  const view = searchParams.get('view');
  const sort = searchParams.get('sort');
  const clientId = searchParams.get('client');
  const search = searchParams.get('q')?.trim().slice(0, MAXIMUM_AD_SEARCH_LENGTH);
  return {
    view: AD_LIST_VIEWS.find((candidate) => candidate === view) ?? 'all',
    sort: AD_LIST_SORTS.find((candidate) => candidate === sort) ?? 'updated',
    clientId: clientId && UUID_PATTERN.test(clientId) ? clientId : undefined,
    search: search || undefined,
  };
}

/** The address query for a set of filters. Defaults are left out so addresses stay short and clean. */
export function adListSearchParams(filters: AdListFilters): URLSearchParams {
  const searchParams = new URLSearchParams();
  if (filters.view !== 'all') searchParams.set('view', filters.view);
  if (filters.clientId) searchParams.set('client', filters.clientId);
  if (filters.search) searchParams.set('q', filters.search);
  if (filters.sort !== 'updated') searchParams.set('sort', filters.sort);
  return searchParams;
}

/** The request the API takes for the same filters, plus the page cursor. */
export function adListRequestQuery(filters: AdListFilters, cursor?: string): string {
  const query = new URLSearchParams({ view: filters.view, sort: filters.sort });
  if (filters.clientId) query.set('clientId', filters.clientId);
  if (filters.search) query.set('search', filters.search);
  if (cursor) query.set('cursor', cursor);
  return query.toString();
}

/** The ads list's filters, kept in the address so back, refresh and sharing keep the view. */
export function useAdListFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => readAdListFilters(searchParams), [searchParams]);
  const changeFilters = useCallback(
    (changes: Partial<AdListFilters>, options: { replace?: boolean } = {}) => {
      setSearchParams(adListSearchParams({ ...readAdListFilters(searchParams), ...changes }), { replace: options.replace ?? false });
    },
    [searchParams, setSearchParams],
  );
  return { filters, changeFilters };
}
