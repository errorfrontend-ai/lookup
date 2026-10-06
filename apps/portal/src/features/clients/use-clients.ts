import type { ClientListItem, ClientSummary, CreateClientInput } from '@lookup/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { portalApi } from '../../app/portal-api';
import { stationQueryKeys } from '../stations/station-query-keys';

/** The station's clients with how many ads each has and how many are on air now. */
export function useClients(stationId: string) {
  return useQuery({
    queryKey: stationQueryKeys.clients(stationId),
    queryFn: () => portalApi.get<ClientListItem[]>(`/stations/${stationId}/clients`),
  });
}

/** Adds a client. The clients list (and anything counting clients) refreshes afterwards. */
export function useCreateClient(stationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateClientInput) => portalApi.post<ClientSummary>(`/stations/${stationId}/clients`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: stationQueryKeys.clients(stationId) }),
  });
}
