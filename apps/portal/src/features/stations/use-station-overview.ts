import type { StationOverview } from '@lookup/contracts';
import { useQuery } from '@tanstack/react-query';
import { portalApi } from '../../app/portal-api';
import { stationQueryKeys } from './station-query-keys';

const ONE_MINUTE_MILLISECONDS = 60_000;

/**
 * How many ads fall under each tab, what is on air, what needs attention. Only an approved station
 * has any (the API refuses the others), so `enabled` keeps the others from asking. Refreshes every
 * minute while the page is visible.
 */
export function useStationOverview(stationId: string, enabled: boolean) {
  return useQuery({
    queryKey: stationQueryKeys.overview(stationId),
    queryFn: () => portalApi.get<StationOverview>(`/stations/${stationId}/overview`),
    enabled,
    refetchInterval: ONE_MINUTE_MILLISECONDS,
  });
}
