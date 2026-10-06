import type { AdListPage } from '@lookup/contracts';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { portalApi } from '../../app/portal-api';
import { stationQueryKeys } from '../stations/station-query-keys';
import { type AdListFilters, adListRequestQuery } from './ad-list-filters';

const ONE_MINUTE_MILLISECONDS = 60_000;

/**
 * The station's ads for one set of filters, 20 at a time ("Show more" fetches the next page). It
 * refreshes every minute while the page is visible, so an ad going on air or ending changes by itself.
 */
export function useAdList(stationId: string, filters: AdListFilters) {
  return useInfiniteQuery({
    queryKey: stationQueryKeys.adList(stationId, filters),
    queryFn: ({ pageParam }) => portalApi.get<AdListPage>(`/stations/${stationId}/ads?${adListRequestQuery(filters, pageParam)}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: ONE_MINUTE_MILLISECONDS,
    placeholderData: keepPreviousData,
  });
}
