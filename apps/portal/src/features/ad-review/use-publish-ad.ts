import type { AdDetail } from '@lookup/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { portalApi } from '../../app/portal-api';
import { refreshAfterAdChange } from '../ads/use-ad-detail';

/** Puts the ad on air by its schedule. The API checks everything again and names what is missing if it is not ready. */
export function usePublishAd(stationId: string, adId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => portalApi.post<AdDetail>(`/stations/${stationId}/ads/${adId}/publish`),
    onSuccess: (publishedDetail) => refreshAfterAdChange(queryClient, stationId, adId, publishedDetail),
  });
}
