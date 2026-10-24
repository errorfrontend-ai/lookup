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

/** What an invitation is for: joining a station's team, or following one of its clients' adverts (ADR-006). */
export const INVITATION_KINDS = ['STATION_MEMBER', 'CLIENT_VIEWER'] as const;
export type InvitationKind = (typeof INVITATION_KINDS)[number];

/** What the invitation page shows before the person joins. */
export interface InvitationDescription {
  kind: InvitationKind;
  state: InvitationState;
  stationName: string | null;
  frequencyLabel: string | null;
  /** The role offered, for a team invitation; null for a client's. */
  role: StationRole | null;
  /** The client whose adverts the person will follow, for a client invitation; null for a team one. */
  clientName: string | null;
  invitedEmail: string;
  /** Whether that email already has an account: then the person signs in to accept. */
  hasAccount: boolean;
  expiresAt: string;
}

/** What accepting answers: the station the person now belongs to, or (for a client invitation) whose client they follow. */
export interface AcceptedInvitation {
  kind: InvitationKind;
  stationId: string;
  clientId: string | null;
}
