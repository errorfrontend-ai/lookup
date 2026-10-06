import type { SignedInPortalUser, StationRole } from '@lookup/contracts';
import { createContext, useContext } from 'react';
import { useParams } from 'react-router';
import { useSignedInUser } from '../session/use-signed-in-user';

export type MemberStation = SignedInPortalUser['stations'][number];

/** Roles that may change a station's content (the API's CHANGE_STATION_CONTENT rule). */
const ROLES_THAT_CHANGE_CONTENT: ReadonlySet<StationRole> = new Set(['OWNER', 'MANAGER']);

/** Owners and managers may correct where the station is, even while it is still being reviewed. */
export function canChangeStationProfile(station: MemberStation): boolean {
  return ROLES_THAT_CHANGE_CONTENT.has(station.role);
}

export function canChangeStationContent(station: MemberStation): boolean {
  return ROLES_THAT_CHANGE_CONTENT.has(station.role) && station.status === 'ACTIVE';
}

/**
 * The station named in the address, if the signed-in person belongs to it. A station they don't
 * belong to is treated as not found, the same answer the API gives.
 */
export function useCurrentStation(): MemberStation | null {
  const { stationId } = useParams();
  const signedInUser = useSignedInUser();
  return signedInUser.data?.stations.find((station) => station.id === stationId) ?? null;
}

/**
 * The current station, handed down by StationScope to everything inside it. Screens never look the
 * station up themselves, so if the session ends the scope steps aside first and they simply go away.
 */
export const StationContext = createContext<MemberStation | null>(null);

/** The current station, for screens that only render inside a station. */
export function useRequiredCurrentStation(): MemberStation {
  const station = useContext(StationContext);
  if (!station) throw new Error('useRequiredCurrentStation used outside a station route');
  return station;
}
