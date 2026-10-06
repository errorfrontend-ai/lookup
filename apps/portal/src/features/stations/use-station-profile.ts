import type { StationProfile } from '@lookup/contracts';
import { useQuery } from '@tanstack/react-query';
import { portalApi } from '../../app/portal-api';
import { stationQueryKeys } from './station-query-keys';

const FIVE_MINUTES_MILLISECONDS = 5 * 60 * 1000;

/** The station's own details: name, frequency, place, time zone and status. */
export function useStationProfile(stationId: string) {
  return useQuery({
    queryKey: stationQueryKeys.profile(stationId),
    queryFn: () => portalApi.get<StationProfile>(`/stations/${stationId}`),
    staleTime: FIVE_MINUTES_MILLISECONDS,
  });
}
