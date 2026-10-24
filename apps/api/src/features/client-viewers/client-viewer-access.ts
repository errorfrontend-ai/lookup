import { randomBytes } from 'node:crypto';
import type { ClientViewerAccessList, InviteClientViewerInput, StationRole } from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import type { EntityManager } from 'typeorm';
import { AppError } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/errors/database-errors.js';
import { RateLimiter } from '../../common/rate-limiting/rate-limiter.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { normalizeEmail, type RequestFacts } from '../authentication/authentication.service.js';
import { INVITATIONS_PER_STATION } from '../members/station-team.js';
import { NotificationQueue } from '../notifications/notification-queue.js';
import { hashLinkToken } from '../registration/registration.service.js';

/** An invitation made, waiting for its email to be queued once the transaction holding it has committed. */
export interface CreatedClientViewerInvitation {
  email: string;
  linkToken: string;
  stationName: string;
  frequencyLabel: string | null;
  clientName: string;
}

interface CreatedRow {
  outcome: string;
  station_name: string | null;
  station_frequency_label: string | null;
  client_name: string | null;
}

/**
 * Who can view a client's adverts (ADR-006; design §3.1): the station's owners and managers invite by email, send an
 * invitation again, cancel it, and remove access; every member sees the list. It works as the station's own team does
 * (the same limits, the same 7-day single-use links, the same words), and every change goes through a database function
 * that checks the caller and writes the audit row.
 */
@Injectable()
export class ClientViewerAccess {
  constructor(
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly requestContext: ClsService,
    private readonly rateLimiter: RateLimiter,
    private readonly notifications: NotificationQueue,
  ) {}

  /** The people who view one client's adverts and the invitations not yet accepted; any member reads it. */
  read(clientId: string): Promise<ClientViewerAccessList> {
    const role = this.requestContext.get<StationRole>('stationRole');
    return this.stationScopedTransaction.run(async (database) => {
      const [client] = (await database.query('SELECT name FROM app.clients WHERE id = $1 AND station_id = app.current_station_id()', [clientId])) as Array<{
        name: string;
      }>;
      if (!client) throw new AppError('NOT_FOUND', { internalDetail: 'client not found at this station' });
      const rows = (await database.query('SELECT * FROM app.list_client_viewers(app.current_station_id(), $1)', [clientId])) as Array<{
        entry_kind: 'VIEWER' | 'INVITATION';
        portal_user_id: string | null;
        full_name: string | null;
        email: string;
        invitation_id: string | null;
        invited_at: Date | null;
        expires_at: Date | null;
        joined_at: Date | null;
      }>;
      const [station] = (await database.query('SELECT status FROM app.stations WHERE id = app.current_station_id()')) as Array<{ status: string }>;
      const now = Date.now();
      return {
        clientId,
        clientName: client.name,
        people: rows
          .filter((row) => row.entry_kind === 'VIEWER')
          .map((row) => ({ portalUserId: row.portal_user_id as string, fullName: row.full_name ?? '', email: row.email, joinedAt: (row.joined_at as Date).toISOString() })),
        pendingInvitations: rows
          .filter((row) => row.entry_kind === 'INVITATION')
          .map((row) => ({
            id: row.invitation_id as string,
            email: row.email,
            invitedAt: (row.invited_at as Date).toISOString(),
            expiresAt: (row.expires_at as Date).toISOString(),
            isExpired: (row.expires_at as Date).getTime() <= now,
          })),
        canManage: (role === 'OWNER' || role === 'MANAGER') && station?.status === 'ACTIVE',
      };
    });
  }

  /** Invites someone by email to view one client's adverts, then answers the list as it now stands. */
  async invite(clientId: string, input: InviteClientViewerInput, request: RequestFacts, response: Response): Promise<ClientViewerAccessList> {
    await this.countInvitation(response);
    const created = await this.stationScopedTransaction.run((database) => this.inviteInTransaction(database, clientId, input.email, request));
    await this.queueInvitationEmail(created, request);
    return this.read(clientId);
  }

  /**
   * Makes the invitation inside the caller's transaction (so adding a client and inviting its email are one step, and
   * a refusal adds nothing). The email is queued by the caller once the transaction has committed.
   */
  async inviteInTransaction(database: EntityManager, clientId: string, invitedEmail: string, request: RequestFacts): Promise<CreatedClientViewerInvitation> {
    const linkToken = randomBytes(32).toString('base64url');
    const email = normalizeEmail(invitedEmail);
    let row: CreatedRow | undefined;
    try {
      [row] = (await database.query('SELECT * FROM app.create_client_viewer_invitation(app.current_station_id(), $1, $2, $3, $4)', [
        clientId,
        email,
        hashLinkToken(linkToken),
        request.requestId,
      ])) as CreatedRow[];
    } catch (problem) {
      // Two invitations to one email for one client at the same moment: the second meets the one-open-invitation index.
      if (isUniqueViolation(problem, 'invitations_one_open_per_email_unique_index')) {
        throw new AppError('CONFLICT', { internalDetail: 'an invitation to that email was made at the same moment', cause: problem });
      }
      throw problem;
    }
    return { email, linkToken, ...this.createdOrThrow(row) };
  }

  /** "Send again": a new link to the same email (the old one stops working) and another 7 days. */
  async resend(clientId: string, invitationId: string, request: RequestFacts, response: Response): Promise<ClientViewerAccessList> {
    await this.countInvitation(response);
    const linkToken = randomBytes(32).toString('base64url');
    const [row] = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT * FROM app.resend_client_viewer_invitation(app.current_station_id(), $1, $2, $3, $4)', [
        clientId,
        invitationId,
        hashLinkToken(linkToken),
        request.requestId,
      ]),
    )) as Array<CreatedRow & { invited_email: string | null }>;
    if (row?.outcome === 'NOT_FOUND') throw new AppError('NOT_FOUND', { internalDetail: 'no open client invitation with that id' });
    const created = this.createdOrThrow(row);
    await this.queueInvitationEmail({ email: row?.invited_email as string, linkToken, ...created }, request);
    return this.read(clientId);
  }

  async revoke(clientId: string, invitationId: string, request: RequestFacts): Promise<ClientViewerAccessList> {
    const [row] = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT app.revoke_client_viewer_invitation(app.current_station_id(), $1, $2, $3) AS outcome', [clientId, invitationId, request.requestId]),
    )) as Array<{ outcome: string }>;
    if (row?.outcome === 'NOT_FOUND') throw new AppError('NOT_FOUND', { internalDetail: 'no open client invitation with that id' });
    if (row?.outcome !== 'REVOKED') throw new AppError('FORBIDDEN', { internalDetail: `client invitation not cancelled: ${row?.outcome}` });
    return this.read(clientId);
  }

  async remove(clientId: string, portalUserId: string, request: RequestFacts): Promise<ClientViewerAccessList> {
    const [row] = (await this.stationScopedTransaction.run((database) =>
      database.query('SELECT app.remove_client_viewer(app.current_station_id(), $1, $2, $3) AS outcome', [clientId, portalUserId, request.requestId]),
    )) as Array<{ outcome: string }>;
    if (row?.outcome === 'NOT_FOUND') throw new AppError('NOT_FOUND', { internalDetail: 'that person does not view this client' });
    if (row?.outcome !== 'REMOVED') throw new AppError('FORBIDDEN', { internalDetail: `client access not removed: ${row?.outcome}` });
    return this.read(clientId);
  }

  /** P5A design §3.4's limit, shared with the team's invitations: 20 a station a day. */
  async countInvitation(response: Response): Promise<void> {
    await this.rateLimiter.countRequest(INVITATIONS_PER_STATION, this.requestContext.get<string>('stationId'), response);
  }

  async queueInvitationEmail(created: CreatedClientViewerInvitation, request: RequestFacts): Promise<void> {
    await this.notifications.enqueue(
      'email',
      created.email,
      {
        template: 'client_viewer_invitation',
        linkToken: created.linkToken,
        stationName: created.stationName,
        frequencyLabel: created.frequencyLabel,
        clientName: created.clientName,
      },
      request.requestId,
    );
  }

  private createdOrThrow(row: CreatedRow | undefined): Omit<CreatedClientViewerInvitation, 'email' | 'linkToken'> {
    switch (row?.outcome) {
      case 'CREATED':
        return { stationName: row.station_name ?? '', frequencyLabel: row.station_frequency_label, clientName: row.client_name ?? '' };
      case 'ALREADY_HAS_ACCESS':
        throw new AppError('CLIENT_VIEWER_ALREADY_HAS_ACCESS', { internalDetail: 'the invited email already views this client' });
      case 'STATION_NOT_ACTIVE':
        throw new AppError('STATION_NOT_ACTIVE', { internalDetail: 'only an approved station invites' });
      case 'CLIENT_NOT_FOUND':
        throw new AppError('NOT_FOUND', { internalDetail: 'client not found at this station' });
      default:
        throw new AppError('FORBIDDEN', { internalDetail: `client invitation refused: ${row?.outcome ?? 'no result'}` });
    }
  }
}
