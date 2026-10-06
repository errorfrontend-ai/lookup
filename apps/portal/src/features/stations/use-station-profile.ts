import type { StationProfile, UpdateStationProfileInput } from '@lookup/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

/** Saves where the station is. The profile shows the new details straight away. */
export function useUpdateStationProfile(stationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateStationProfileInput) => portalApi.put<StationProfile>(`/stations/${stationId}/profile`, input),
    onSuccess: (updatedProfile) => queryClient.setQueryData(stationQueryKeys.profile(stationId), updatedProfile),
  });
}
