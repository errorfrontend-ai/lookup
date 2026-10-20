import type { ListenerFiguresRange, ListenerMix } from '@lookup/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { portalApi } from '../../app/portal-api';
import { stationQueryKeys } from './station-query-keys';

const ONE_MINUTE_MILLISECONDS = 60_000;

/**
 * Who is listening to the station's ads, or to one of them (ADR-005; LA-STATS-07): listeners by gender and by age band,
 * as groups of at least 10. Refreshes every minute while the page is visible; changing the range keeps the last numbers
 * on screen until the new ones arrive.
 */
export function useListenerMix(stationId: string, range: ListenerFiguresRange, adId?: string) {
  return useQuery({
    queryKey: adId ? stationQueryKeys.adListenerMix(stationId, adId, range) : stationQueryKeys.listenerMix(stationId, range),
    queryFn: () => portalApi.get<ListenerMix>(`/stations/${stationId}${adId ? `/ads/${adId}` : ''}/listener-mix?range=${range}`),
    refetchInterval: ONE_MINUTE_MILLISECONDS,
    placeholderData: keepPreviousData,
  });
}
