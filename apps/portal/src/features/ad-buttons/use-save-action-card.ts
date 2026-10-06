import type { ActionCard, AdDetail } from '@lookup/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { portalApi } from '../../app/portal-api';
import { refreshAfterAdChange } from '../ads/use-ad-detail';

/**
 * Saves the ad's buttons. Every save is a new version of the card; a campaign that is already on air
 * switches to it at once. The ad's own page gets the saved version straight away.
 */
export function useSaveActionCard(stationId: string, adId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (card: ActionCard) => portalApi.put<AdDetail>(`/stations/${stationId}/ads/${adId}/card`, card),
    onSuccess: (updatedDetail) => refreshAfterAdChange(queryClient, stationId, adId, updatedDetail),
  });
}
