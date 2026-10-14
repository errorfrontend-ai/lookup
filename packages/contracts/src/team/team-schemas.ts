import { z } from 'zod';
import { STATION_ROLES, type StationRole } from '../authentication/authentication-schemas.js';
import { EmailAddress, FullName, LinkToken, ZambianMobileNumber } from '../registration/registration-schemas.js';

/** A station's team and its invitations (design §2.5, §3.3, §4.5). Only an OWNER manages the team. */

/** Invitations last a week and can be used once (design P5A-D16). */
export const INVITATION_LIFETIME_DAYS = 7;

/** POST /stations/{stationId}/invitations */
export const InviteStationMemberInput = z.strictObject({
  email: EmailAddress,
  role: z.enum(STATION_ROLES),
});
export type InviteStationMemberInput = z.infer<typeof InviteStationMemberInput>;

/** GET /stations/{stationId}/members */
export interface StationTeam {
  members: Array<{ portalUserId: string; fullName: string; email: string; role: StationRole; isYou: boolean }>;
  pendingInvitations: Array<{ id: string; email: string; role: StationRole; invitedAt: string; expiresAt: string }>;
  /** True for an OWNER: the page shows the invite and remove controls. */
  canManage: boolean;
}

/** POST /invitations/description and POST /invitations/acceptance */
export const InvitationTokenInput = z.strictObject({ token: LinkToken });
export type InvitationTokenInput = z.infer<typeof InvitationTokenInput>;

/** POST /invitations/acceptance-with-new-account */
export const AcceptInvitationWithNewAccountInput = z.strictObject({
  token: LinkToken,
  fullName: FullName,
  mobileNumber: ZambianMobileNumber.nullable(),
  password: z.string().min(1).max(1024),
});
export type AcceptInvitationWithNewAccountInput = z.input<typeof AcceptInvitationWithNewAccountInput>;

export const INVITATION_STATES = ['OPEN', 'EXPIRED', 'ACCEPTED', 'REVOKED'] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];

/** What the invitation page shows before the person joins. */
export interface InvitationDescription {
  state: InvitationState;
  stationName: string | null;
  frequencyLabel: string | null;
  role: StationRole;
  invitedEmail: string;
  /** Whether that email already has an account: then the person signs in to accept. */
  hasAccount: boolean;
  expiresAt: string;
}

/** What accepting answers: the station the person now belongs to. */
export interface AcceptedInvitation {
  stationId: string;
}
