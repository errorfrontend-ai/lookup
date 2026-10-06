import type { AdDetail, AdHistoryPage, RenameAdInput } from '@lookup/contracts';
import { type QueryClient, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { portalApi } from '../../app/portal-api';
import { stationQueryKeys } from '../stations/station-query-keys';
import { chooseAdRefreshInterval } from './choose-ad-refresh-interval';

/** One ad in full. It refreshes itself as often as its state warrants (see chooseAdRefreshInterval). */
export function useAd(stationId: string, adId: string) {
  return useQuery({
    queryKey: stationQueryKeys.adDetail(stationId, adId),
    queryFn: () => portalApi.get<AdDetail>(`/stations/${stationId}/ads/${adId}`),
    refetchInterval: (query) => (query.state.data ? chooseAdRefreshInterval(query.state.data) : false),
  });
}

/** What happened to the ad, newest first, a page at a time. */
export function useAdHistory(stationId: string, adId: string) {
  return useInfiniteQuery({
    queryKey: stationQueryKeys.adHistory(stationId, adId),
    queryFn: ({ pageParam }) => portalApi.get<AdHistoryPage>(`/stations/${stationId}/ads/${adId}/history${pageParam ? `?cursor=${pageParam}` : ''}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/**
 * After anything changes an ad: the lists, the overview and the counts (which all show it) are asked
 * again, and so is its history. `updatedDetail` puts the new version straight into the ad's own page.
 */
export function refreshAfterAdChange(queryClient: QueryClient, stationId: string, adId: string, updatedDetail?: AdDetail) {
  if (updatedDetail) queryClient.setQueryData(stationQueryKeys.adDetail(stationId, adId), updatedDetail);
  void queryClient.invalidateQueries({ queryKey: stationQueryKeys.adListPrefix(stationId) });
  void queryClient.invalidateQueries({ queryKey: stationQueryKeys.overview(stationId) });
  void queryClient.invalidateQueries({ queryKey: stationQueryKeys.clients(stationId) });
  void queryClient.invalidateQueries({ queryKey: stationQueryKeys.adHistory(stationId, adId) });
}

export function useRenameAd(stationId: string, adId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RenameAdInput) => portalApi.put<AdDetail>(`/stations/${stationId}/ads/${adId}/title`, input),
    onSuccess: (updatedDetail) => refreshAfterAdChange(queryClient, stationId, adId, updatedDetail),
  });
}

/** Removes the ad from the station's lists (it is kept for the record). */
export function useArchiveAd(stationId: string, adId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => portalApi.post<void>(`/stations/${stationId}/ads/${adId}/archive`),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: stationQueryKeys.adDetail(stationId, adId) });
      refreshAfterAdChange(queryClient, stationId, adId);
    },
  });
}
