import type { ListenerFigures, ListenerFiguresRange } from '@lookup/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { portalApi } from '../../app/portal-api';
import { stationQueryKeys } from './station-query-keys';

const ONE_MINUTE_MILLISECONDS = 60_000;

/**
 * How listeners responded to the station's ads over a range of its days (P5B-OVERVIEW-04 to -16). Refreshes every
 * minute while the page is visible; changing the range keeps the last numbers on screen until the new ones arrive.
 */
export function useListenerFigures(stationId: string, range: ListenerFiguresRange) {
  return useQuery({
    queryKey: stationQueryKeys.listenerFigures(stationId, range),
    queryFn: () => portalApi.get<ListenerFigures>(`/stations/${stationId}/listener-figures?range=${range}`),
    refetchInterval: ONE_MINUTE_MILLISECONDS,
    placeholderData: keepPreviousData,
  });
}
