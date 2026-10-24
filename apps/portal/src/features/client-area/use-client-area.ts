import type { ClientAdDetail, ClientAdFigures, ClientHome, ListenerFiguresRange, ListenerMix } from '@lookup/contracts';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { portalApi } from '../../app/portal-api';

const ONE_MINUTE_MILLISECONDS = 60_000;

/** Everything a client's pages ask for sits under 'client', so signing out or losing access clears it all at once. */
export const clientQueryKeys = {
  all: ['client'] as const,
  home: ['client', 'home'] as const,
  ad: (stationId: string, adId: string) => ['client', 'stations', stationId, 'ads', adId] as const,
  adFigures: (stationId: string, adId: string, range: ListenerFiguresRange) => ['client', 'stations', stationId, 'ads', adId, 'figures', range] as const,
  adListenerMix: (stationId: string, adId: string, range: ListenerFiguresRange) => ['client', 'stations', stationId, 'ads', adId, 'listener-mix', range] as const,
};

/** The client's home: one section per station that gave access (ADR-006 decision 4). Fresh every minute while open. */
export function useClientHome() {
  return useQuery({
    queryKey: clientQueryKeys.home,
    queryFn: () => portalApi.get<ClientHome>('/client/home'),
    refetchInterval: ONE_MINUTE_MILLISECONDS,
  });
}

/** One advert as its client sees it: dates, slots, next times on air, the card and the station's contact. */
export function useClientAd(stationId: string, adId: string) {
  return useQuery({
    queryKey: clientQueryKeys.ad(stationId, adId),
    queryFn: () => portalApi.get<ClientAdDetail>(`/client/stations/${stationId}/ads/${adId}`),
    refetchInterval: ONE_MINUTE_MILLISECONDS,
  });
}

/** What listeners did with one advert over [range]; changing the range keeps the last numbers until the new ones arrive. */
export function useClientAdFigures(stationId: string, adId: string, range: ListenerFiguresRange) {
  return useQuery({
    queryKey: clientQueryKeys.adFigures(stationId, adId, range),
    queryFn: () => portalApi.get<ClientAdFigures>(`/client/stations/${stationId}/ads/${adId}/figures?range=${range}`),
    refetchInterval: ONE_MINUTE_MILLISECONDS,
    placeholderData: keepPreviousData,
  });
}

/** Who is listening to one advert, as groups of at least 10 (ADR-005's rule, the same as the station's). */
export function useClientListenerMix(stationId: string, adId: string, range: ListenerFiguresRange) {
  return useQuery({
    queryKey: clientQueryKeys.adListenerMix(stationId, adId, range),
    queryFn: () => portalApi.get<ListenerMix>(`/client/stations/${stationId}/ads/${adId}/listener-mix?range=${range}`),
    refetchInterval: ONE_MINUTE_MILLISECONDS,
    placeholderData: keepPreviousData,
  });
}

/** Saves one station's spreadsheet (the last 30 days) through the browser's own download. */
export function useSpreadsheetDownload(stationId: string) {
  return useMutation({
    mutationFn: async () => {
      const file = await portalApi.getFile(`/client/stations/${stationId}/export.csv`);
      const address = URL.createObjectURL(file.blob);
      try {
        const link = document.createElement('a');
        link.href = address;
        link.download = file.fileName ?? 'look-up-figures.csv';
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        // The browser has taken the file by now; a moment later the address is let go.
        setTimeout(() => URL.revokeObjectURL(address), 1_000);
      }
    },
  });
}
