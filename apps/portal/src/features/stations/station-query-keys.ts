/**
 * Every react-query key for station data, from one place. All of them start with the station, so
 * everything one station has cached can be found (or cleared) together.
 */
export const stationQueryKeys = {
  station: (stationId: string) => ['stations', stationId] as const,
  profile: (stationId: string) => ['stations', stationId, 'profile'] as const,
  overview: (stationId: string) => ['stations', stationId, 'overview'] as const,
  clients: (stationId: string) => ['stations', stationId, 'clients'] as const,
  adListPrefix: (stationId: string) => ['stations', stationId, 'ads', 'list'] as const,
  adList: (stationId: string, filters: object) => ['stations', stationId, 'ads', 'list', filters] as const,
  adDetail: (stationId: string, adId: string) => ['stations', stationId, 'ads', 'detail', adId] as const,
  adHistory: (stationId: string, adId: string) => ['stations', stationId, 'ads', 'detail', adId, 'history'] as const,
  playbackUrl: (stationId: string, adId: string) => ['stations', stationId, 'ads', 'detail', adId, 'playback-url'] as const,
};
