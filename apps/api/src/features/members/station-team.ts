import { randomBytes } from 'node:crypto';
import type { AcceptedInvitation, AcceptInvitationWithNewAccountInput, InvitationDescription, InviteStationMemberInput, StationRole, StationTeam } from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import type { DataSource } from 'typeorm';
import { AppError } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/errors/database-errors.js';
import type { RateLimitRule } from '../../common/rate-limiting/rate-limit-rule.js';
import { RateLimiter } from '../../common/rate-limiting/rate-limiter.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { AuthenticationService, normalizeEmail, type RequestFacts } from '../authentication/authentication.service.js';
import { PasswordHasher } from '../authentication/password-hasher.js';
import { PasswordPolicy } from '../authentication/password-policy.js';
import { createRefreshToken, hashRefreshToken } from '../authentication/session-cookies.js';
import { NotificationQueue } from '../notifications/notification-queue.js';
import { hashLinkToken } from '../registration/registration.service.js';

/** P5A design §3.4: at most 20 invitations a station a day, refused when the counter store is down. */
export const INVITATIONS_PER_STATION: RateLimitRule = { counterName: 'invitations-per-station', maximumRequests: 20, windowSeconds: 24 * 60 * 60, refuseWhenStoreUnavailable: true };
/** Describing or accepting an invitation, per address (the token is 32 random bytes; this stops noise). */
export const INVITATION_LINKS_PER_ADDRESS: RateLimitRule = { counterName: 'invitation-links-per-address', maximumRequests: 20, windowSeconds: 10 * 60, refuseWhenStoreUnavailable: true };

/**
 * A station's team (P5A design §3.3, §4.5; journey F; P5A-TEAM-*, P5A-D16): an owner invites by email with a role,
 * revokes an invitation, and removes members, never the last owner. The invitee opens the link, then creates an
 * account or signs in with the invited email. Every change goes through a database function that checks the caller.
 */
@Injectable()
export class StationTeams {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly requestContext: ClsService,
    private readonly rateLimiter: RateLimiter,
    private readonly authenticationService: AuthenticationService,
    private readonly passwordHasher: PasswordHasher,
    private readonly passwordPolicy: PasswordPolicy,
    private readonly notifications: NotificationQueue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('team');
  }

  /** Members and open invitations (never their tokens); any member reads it, an owner may change it. */
  async read(): Promise<StationTeam> {
    const userId = this.requestContext.get<string>('userId');
    const role = this.requestContext.get<StationRole>('stationRole');
    return this.stationScopedTransaction.run(async (database) => {
      const members = (await database.query(
        `SELECT member.id, member.full_name, member.email::text AS email, membership.role
           FROM app.station_memberships AS membership JOIN app.portal_users AS member ON member.id = membership.portal_user_id
          WHERE membership.station_id = app.current_station_id()
          ORDER BY CASE membership.role WHEN 'OWNER' THEN 0 WHEN 'MANAGER' THEN 1 ELSE 2 END, member.full_name, member.id`,
      )) as Array<{ id: string; full_name: string; email: string; role: StationRole }>;
      const invitations = (await database.query(
        `SELECT id, invited_email::text AS invited_email, station_role, created_at, expires_at FROM app.invitations
          WHERE station_id = app.current_station_id() AND kind = 'STATION_MEMBER'
            AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC`,
      )) as Array<{ id: string; invited_email: string; station_role: StationRole; created_at: Date; expires_at: Date }>;
      const [station] = (await database.query('SELECT status FROM app.stations WHERE id = app.current_station_id()')) as Array<{ status: string }>;
      return {
        members: members.map((member) => ({ portalUserId: member.id, fullName: member.full_name, email: member.email, role: member.role, isYou: member.id === userId })),
        pendingInvitations: invitations.map((invitation) => ({
          id: invitation.id,
          email: invitation.invited_email,
          role: invitation.station_role,
          invitedAt: invitation.created_at.toISOString(),
          expiresAt: invitation.expires_at.toISOString(),
        })),
        canManage: role === 'OWNER' && station?.status === 'ACTIVE',
      };
    });
  }

  async invite(input: InviteStationMemberInput, request: RequestFacts, response: Response): Promise<StationTeam> {
    const stationId = this.requestContext.get<string>('stationId');
    await this.rateLimiter.countRequest(INVITATIONS_PER_STATION, stationId, response);
    const linkToken = randomBytes(32).toString('base64url');
    const email = normalizeEmail(input.email);
    let created: { outcome: string; station_name: string | null };
    try {
      [created] = (await this.stationScopedTransaction.run(async (database) => {
        const [row] = (await database.query('SELECT outcome FROM app.create_station_invitation(app.current_station_id(), $1, $2, $3, $4)', [
          email,
          input.role,
          hashLinkToken(linkToken),
          request.requestId,
        ])) as Array<{ outcome: string }>;
        const [station] = (await database.query('SELECT name FROM app.stations WHERE id = app.current_station_id()')) as Array<{ name: string | null }>;
        return [{ outcome: row?.outcome ?? 'none', station_name: station?.name ?? null }];
      })) as [typeof created];
    } catch (problem) {
      // Two invitations to one email at the same moment: the second meets the one-open-invitation index.
      if (isUniqueViolation(problem, 'invitations_one_open_per_email_unique_index')) {
        throw new AppError('CONFLICT', { internalDetail: 'an invitation to that email was made at the same moment', cause: problem });
      }
      throw problem;
    }
    if (created.outcome === 'ALREADY_A_MEMBER') throw new AppError('ALREADY_A_MEMBER', { internalDetail: 'the invited email belongs to a member' });
    if (created.outcome === 'STATION_NOT_ACTIVE') throw new AppError('STATION_NOT_ACTIVE', { internalDetail: 'only an approved station invites' });
    if (created.outcome !== 'CREATED') throw new AppError('FORBIDDEN', { internalDetail: `invitation refused: ${created.outcome}` });
    await this.notifications.enqueue(
      'email',
      email,
      { template: 'team_invitation', linkToken, stationName: created.station_name ?? '', stationRole: input.role },
      request.requestId,
    );
    return this.read();
  }

  async revoke(invitationId: string, request: RequestFacts): Promise<StationTeam> {
    const [result] = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT app.revoke_station_invitation(app.current_station_id(), $1, $2) AS outcome', [invitationId, request.requestId]),
    )) as Array<{ outcome: string }>;
    if (result?.outcome === 'NOT_FOUND') throw new AppError('NOT_FOUND', { internalDetail: 'no open invitation with that id' });
    if (result?.outcome !== 'REVOKED') throw new AppError('FORBIDDEN', { internalDetail: `revocation refused: ${result?.outcome}` });
    return this.read();
  }

  async removeMember(portalUserId: string, request: RequestFacts): Promise<StationTeam> {
    const [result] = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT app.remove_station_member(app.current_station_id(), $1, $2) AS outcome', [portalUserId, request.requestId]),
    )) as Array<{ outcome: string }>;
    if (result?.outcome === 'NOT_FOUND') throw new AppError('NOT_FOUND', { internalDetail: 'not a member of this station' });
    if (result?.outcome === 'LAST_OWNER') throw new AppError('LAST_OWNER', { internalDetail: 'the last owner cannot be removed' });
    if (result?.outcome !== 'REMOVED') throw new AppError('FORBIDDEN', { internalDetail: `removal refused: ${result?.outcome}` });
    return this.read();
  }

  // ---- the invitee -------------------------------------------------------------------------------------------

  /**
   * What the invitation page shows before anyone signs in. One link page serves both kinds of invitation: joining the
   * station's team, and following one of its clients' adverts (ADR-006), each with its own database function.
   */
  async describeInvitation(linkToken: string): Promise<InvitationDescription> {
    const tokenHash = hashLinkToken(linkToken);
    const [member] = (await this.dataSource.query('SELECT * FROM app.describe_invitation($1)', [tokenHash])) as Array<{
      invitation_state: InvitationDescription['state'];
      station_name: string | null;
      station_frequency_label: string | null;
      invited_role: StationRole;
      invited_email: string;
      has_account: boolean;
      invitation_expires_at: Date;
    }>;
    if (member) {
      return {
        kind: 'STATION_MEMBER',
        state: member.invitation_state,
        stationName: member.station_name,
        frequencyLabel: member.station_frequency_label,
        role: member.invited_role,
        clientName: null,
        invitedEmail: member.invited_email,
        hasAccount: member.has_account,
        expiresAt: member.invitation_expires_at.toISOString(),
      };
    }
    const [client] = (await this.dataSource.query('SELECT * FROM app.describe_client_viewer_invitation($1)', [tokenHash])) as Array<{
      invitation_state: InvitationDescription['state'];
      station_name: string | null;
      station_frequency_label: string | null;
      client_name: string;
      invited_email: string;
      has_account: boolean;
      invitation_expires_at: Date;
    }>;
    if (!client) throw new AppError('INVITATION_NOT_VALID', { internalDetail: 'no invitation with that token' });
    return {
      kind: 'CLIENT_VIEWER',
      state: client.invitation_state,
      stationName: client.station_name,
      frequencyLabel: client.station_frequency_label,
      role: null,
      clientName: client.client_name,
      invitedEmail: client.invited_email,
      hasAccount: client.has_account,
      expiresAt: client.invitation_expires_at.toISOString(),
    };
  }

  /** Joins (or starts following the client) with a new account for the invited email (the link proves it) and signs in. */
  async acceptWithNewAccount(input: AcceptInvitationWithNewAccountInput & { mobileNumber: string | null }, request: RequestFacts, response: Response): Promise<AcceptedInvitation> {
    const invitation = await this.describeInvitation(input.token);
    const refusalReason = this.passwordPolicy.check(input.password, {
      fullName: input.fullName,
      email: invitation.invitedEmail,
      stationNames: [invitation.stationName, invitation.clientName].filter((name): name is string => Boolean(name)),
    });
    if (refusalReason) {
      throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'password', code: refusalReason }], internalDetail: `invitee password refused: ${refusalReason}` });
    }
    const passwordHash = await this.passwordHasher.hashNewPassword(input.password);
    const refreshToken = createRefreshToken();
    const isClientInvitation = invitation.kind === 'CLIENT_VIEWER';
    let accepted: {
      outcome: string;
      new_portal_user_id: string | null;
      joined_station_id: string | null;
      joined_client_id?: string | null;
      new_portal_session_id: string | null;
      new_refresh_token_expires_at: Date | null;
    };
    try {
      [accepted] = (await this.dataSource.query(
        isClientInvitation
          ? 'SELECT * FROM app.accept_client_viewer_invitation_with_new_account($1, $2, $3, $4, $5, $6)'
          : 'SELECT * FROM app.accept_invitation_with_new_account($1, $2, $3, $4, $5, $6)',
        [hashLinkToken(input.token), input.fullName, input.mobileNumber, passwordHash, hashRefreshToken(refreshToken), request.requestId],
      )) as [typeof accepted];
    } catch (problem) {
      if (isUniqueViolation(problem, 'portal_users_email_unique')) throw new AppError('EMAIL_ALREADY_REGISTERED', { internalDetail: 'invited email took an account meanwhile', cause: problem });
      throw problem;
    }
    if (accepted.outcome === 'ACCOUNT_EXISTS') throw new AppError('EMAIL_ALREADY_REGISTERED', { internalDetail: 'the invited email has an account: sign in to accept' });
    this.throwUnlessAccepted(accepted.outcome);
    await this.authenticationService.startBrowserSession(
      response,
      accepted.new_portal_user_id as string,
      accepted.new_portal_session_id as string,
      refreshToken,
      accepted.new_refresh_token_expires_at as Date,
    );
    return { kind: invitation.kind, stationId: accepted.joined_station_id as string, clientId: accepted.joined_client_id ?? null };
  }

  /** Joins (or starts following the client) as the signed-in person, whose email must be the invited one. */
  async acceptSignedIn(linkToken: string, request: RequestFacts): Promise<AcceptedInvitation> {
    const tokenHash = hashLinkToken(linkToken);
    // One transaction finds which kind of invitation the link is and accepts it.
    const result = (await this.stationScopedTransaction.run(
      async (database) => {
        const [clientInvitation] = (await database.query('SELECT 1 FROM app.describe_client_viewer_invitation($1)', [tokenHash])) as unknown[];
        const [accepted] = (await database.query(
          clientInvitation
            ? 'SELECT * FROM app.accept_client_viewer_invitation_for_signed_in_user($1, $2)'
            : 'SELECT * FROM app.accept_invitation_for_signed_in_user($1, $2)',
          [tokenHash, request.requestId],
        )) as Array<{ outcome: string; joined_station_id: string | null; joined_client_id?: string | null }>;
        return { kind: clientInvitation ? ('CLIENT_VIEWER' as const) : ('STATION_MEMBER' as const), ...accepted };
      },
      { stationId: '' },
    )) as { kind: AcceptedInvitation['kind']; outcome?: string; joined_station_id?: string | null; joined_client_id?: string | null };
    if (result.outcome === 'FOR_ANOTHER_EMAIL') throw new AppError('INVITATION_FOR_ANOTHER_EMAIL', { internalDetail: 'signed in with another email' });
    // Already in the team: joining again changes nothing, and the person goes to the station.
    if (result.kind === 'STATION_MEMBER' && result.outcome === 'ALREADY_A_MEMBER' && result.joined_station_id) {
      return { kind: 'STATION_MEMBER', stationId: result.joined_station_id, clientId: null };
    }
    this.throwUnlessAccepted(result.outcome);
    return { kind: result.kind, stationId: result.joined_station_id as string, clientId: result.joined_client_id ?? null };
  }

  private throwUnlessAccepted(outcome: string | undefined): void {
    if (outcome === 'ACCEPTED') return;
    if (outcome === 'EXPIRED') throw new AppError('INVITATION_EXPIRED', { internalDetail: 'invitation expired' });
    throw new AppError('INVITATION_NOT_VALID', { internalDetail: `invitation refused: ${outcome ?? 'no result'}` });
  }
}
