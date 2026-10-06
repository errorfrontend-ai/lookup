import type { MemberStation } from './use-current-station';

/** Where a station's people land: its ads when it is approved, otherwise its profile (which works while under review). */
export function stationHomePath(station: Pick<MemberStation, 'id' | 'status'>): string {
  return station.status === 'ACTIVE' ? `/stations/${station.id}/ads` : `/stations/${station.id}/profile`;
}
