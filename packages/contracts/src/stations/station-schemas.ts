import { z } from 'zod';
import type { StationRole, StationStatus } from '../authentication/authentication-schemas.js';
import { EmailAddress } from '../registration/email-address.js';

export const MAXIMUM_CLIENT_NAME_LENGTH = 80;

export const CreateClientInput = z.strictObject({
  name: z.string().trim().min(1).max(MAXIMUM_CLIENT_NAME_LENGTH),
  /** The client's email (ADR-006): when given, the client is invited to view their adverts in the same step. */
  email: EmailAddress.optional(),
});
export type CreateClientInput = z.infer<typeof CreateClientInput>;

/**
 * Why a client's usual card was refused, relayed in VALIDATION_FAILED (path `actionCardId`): the card is not one
 * of this client's saved card versions (another client's, another station's, or none at all).
 */
export const CLIENT_DEFAULT_CARD_REASONS = ['card_not_of_this_client'] as const;
export type ClientDefaultCardReason = (typeof CLIENT_DEFAULT_CARD_REASONS)[number];

/**
 * PUT /stations/{stationId}/clients/{clientId}/default-action-card: the client's usual card, which listeners get
 * when its ad is heard out of its slots, after its campaign was paused or ended, or once the campaign reached its
 * tap limit; null takes it away. It must be one of this client's saved card versions.
 */
export const SetClientDefaultActionCardInput = z.strictObject({
  actionCardId: z.uuid().nullable(),
});
export type SetClientDefaultActionCardInput = z.infer<typeof SetClientDefaultActionCardInput>;

/** The ten provinces of Zambia, as the profile offers them. */
export const ZAMBIAN_PROVINCES = ['Central', 'Copperbelt', 'Eastern', 'Luapula', 'Lusaka', 'Muchinga', 'Northern', 'North-Western', 'Southern', 'Western'] as const;
export type ZambianProvince = (typeof ZAMBIAN_PROVINCES)[number];
export const MAXIMUM_CITY_LENGTH = 80;

/**
 * PUT /stations/{stationId}/profile. Where the station is. The name, frequency and licence go through
 * review, and the time zone is fixed because changing it would shift every schedule's start and end,
 * so none of those can be changed here.
 */
export const UpdateStationProfileInput = z.strictObject({
  province: z.enum(ZAMBIAN_PROVINCES).nullable(),
  city: z.string().trim().min(1).max(MAXIMUM_CITY_LENGTH).nullable(),
});
export type UpdateStationProfileInput = z.infer<typeof UpdateStationProfileInput>;

/** GET /stations/{stationId} */
export interface StationProfile {
  id: string;
  /** Null only while the station is still signing up (PENDING_VERIFICATION, before step 3; P5A-D2). */
  name: string | null;
  frequencyLabel: string | null;
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

/** What adding a client answers: the client, and the email invited to view its adverts (null when none was given). */
export interface CreatedClient extends ClientSummary {
  invitedEmail: string | null;
}

/** A client in the clients list: how many ads the station has for it, how many are on air right now, and who can view them. */
export interface ClientListItem extends ClientSummary {
  adCount: number;
  liveNowAdCount: number;
  /** People who follow this client's adverts (ADR-006). */
  viewerCount: number;
  /** Invitations to view them not yet accepted or cancelled (expired ones too). */
  pendingInvitationCount: number;
}
