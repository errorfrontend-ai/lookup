import type { CreateAdInput, CreatedAd } from '@lookup/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { portalApi } from '../../app/portal-api';
import { refreshAfterAdChange } from '../ads/use-ad-detail';

/** Creates the ad (its title, client and the file's details) and gets the signed address to upload the audio to. */
export function useCreateAd(stationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAdInput) => portalApi.post<CreatedAd>(`/stations/${stationId}/ads`, input),
    onSuccess: (created) => refreshAfterAdChange(queryClient, stationId, created.adId),
  });
}
