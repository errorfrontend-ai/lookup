import type { MemberStation } from './use-current-station';

/**
 * Where a station's people land (P5A design §4.1): its overview when it is approved; its application while it is
 * signing up, under review or rejected; otherwise (suspended) its profile.
 */
export function stationHomePath(station: Pick<MemberStation, 'id' | 'status'>): string {
  if (station.status === 'ACTIVE') return `/stations/${station.id}/overview`;
  if (station.status === 'PENDING_VERIFICATION' || station.status === 'PENDING_REVIEW' || station.status === 'REJECTED') {
    return `/stations/${station.id}/application`;
  }
  return `/stations/${station.id}/profile`;
}
