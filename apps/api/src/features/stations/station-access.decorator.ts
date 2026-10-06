import { STATION_ROLES, type StationRole } from '@lookup/contracts';
import { SetMetadata } from '@nestjs/common';

export const STATION_ACCESS_METADATA = 'lookup:station-access';

export interface StationAccessRequirement {
  /** Station roles allowed on the route. */
  allowedRoles: readonly StationRole[];
  /** Station content (clients, ads, schedules) is only available once the station is approved. */
  requiresActiveStation: boolean;
}

/** Every member may read the station's content once it is active. Used when a route declares nothing. */
export const READ_STATION_CONTENT: StationAccessRequirement = { allowedRoles: STATION_ROLES, requiresActiveStation: true };

/** Owners and managers change content; analysts only read. */
export const CHANGE_STATION_CONTENT: StationAccessRequirement = { allowedRoles: ['OWNER', 'MANAGER'], requiresActiveStation: true };

/** The station's own profile is readable while it is still being reviewed. */
export const READ_STATION_PROFILE: StationAccessRequirement = { allowedRoles: STATION_ROLES, requiresActiveStation: false };

/** Owners and managers may correct where the station is, even while it is still being reviewed. */
export const CHANGE_STATION_PROFILE: StationAccessRequirement = { allowedRoles: ['OWNER', 'MANAGER'], requiresActiveStation: false };

export const StationAccess = (requirement: StationAccessRequirement) => SetMetadata(STATION_ACCESS_METADATA, requirement);
