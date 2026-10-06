import { z } from 'zod';
import type { StationRole, StationStatus } from '../authentication/authentication-schemas.js';

export const MAXIMUM_CLIENT_NAME_LENGTH = 80;

export const CreateClientInput = z.strictObject({
  name: z.string().trim().min(1).max(MAXIMUM_CLIENT_NAME_LENGTH),
});
export type CreateClientInput = z.infer<typeof CreateClientInput>;

/** GET /stations/{stationId} */
export interface StationProfile {
  id: string;
  name: string;
  frequencyLabel: string;
  province: string | null;
  city: string | null;
  timeZone: string;
  status: StationStatus;
  isListedInApp: boolean;
  yourRole: StationRole;
}

/** A station's advertiser, as listed in the portal. */
export interface ClientSummary {
  id: string;
  name: string;
}

/** A client in the clients list: how many ads the station has for it, and how many are on air right now. */
export interface ClientListItem extends ClientSummary {
  adCount: number;
  liveNowAdCount: number;
}
