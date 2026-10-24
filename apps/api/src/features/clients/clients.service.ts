import type { ClientDefaultCardReason, ClientListItem, ClientSummary, CreateClientInput, CreatedClient, SetClientDefaultActionCardInput } from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AuditTrail } from '../../common/audit/audit-trail.js';
import { AppError } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/errors/database-errors.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import type { RequestFacts } from '../authentication/authentication.service.js';
import { ClientViewerAccess, type CreatedClientViewerInvitation } from '../client-viewers/client-viewer-access.js';

@Injectable()
export class ClientsService {
  constructor(
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly auditTrail: AuditTrail,
    private readonly clientViewerAccess: ClientViewerAccess,
  ) {}

  /** The station's clients, A to Z, each with how many ads it has (archived ones not counted) and how many are on air now. */
  list(): Promise<ClientListItem[]> {
    return this.stationScopedTransaction.run(async (database) => {
      const rows = (await database.query(
        `SELECT clients.id, clients.name,
                coalesce(min(viewers.viewer_count), 0)::integer AS viewer_count,
                (SELECT count(*)::integer FROM app.invitations AS invitation
                  WHERE invitation.station_id = clients.station_id AND invitation.client_id = clients.id
                    AND invitation.kind = 'CLIENT_VIEWER' AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL) AS pending_invitation_count,
                count(ads.id)::integer AS ad_count,
                count(ads.id) FILTER (
                  WHERE campaign.id IS NOT NULL AND app.campaign_display_status(campaign.id, now()) = 'LIVE_NOW'
                )::integer AS live_now_ad_count
           FROM app.clients
           LEFT JOIN app.count_client_viewers_of_current_station() AS viewers ON viewers.client_id = clients.id
           LEFT JOIN app.ads ON ads.client_id = clients.id AND ads.station_id = clients.station_id AND ads.archived_at IS NULL
           LEFT JOIN LATERAL (
             SELECT latest.id FROM app.campaigns AS latest
              WHERE latest.ad_id = ads.id AND latest.station_id = ads.station_id
              ORDER BY latest.created_at DESC LIMIT 1
           ) AS campaign ON true
          WHERE clients.station_id = app.current_station_id()
          GROUP BY clients.id, clients.name, clients.station_id
          ORDER BY lower(clients.name), clients.id`,
      )) as Array<{ id: string; name: string; ad_count: number; live_now_ad_count: number; viewer_count: number; pending_invitation_count: number }>;
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        adCount: row.ad_count,
        liveNowAdCount: row.live_now_ad_count,
        viewerCount: row.viewer_count,
        pendingInvitationCount: row.pending_invitation_count,
      }));
    });
  }

  /**
   * Adds a client; with an email, also invites that email to view the client's adverts (ADR-006, P5C-ONBOARDING-01), in
   * the same transaction, so a refused invitation adds no client. The email is queued once it has all committed.
   */
  async create(input: CreateClientInput, request: RequestFacts, response: Response): Promise<CreatedClient> {
    if (input.email) await this.clientViewerAccess.countInvitation(response);
    const made: { invitation: CreatedClientViewerInvitation | null } = { invitation: null };
    let created: ClientSummary;
    try {
      created = await this.stationScopedTransaction.run(async (database) => {
        const [client] = (await database.query(
          `INSERT INTO app.clients (station_id, name) VALUES (app.current_station_id(), $1) RETURNING id, name`,
          [input.name],
        )) as ClientSummary[];
        const createdClient = client as ClientSummary;
        await this.auditTrail.record(database, {
          action: 'client_created',
          entityType: 'client',
          entityId: createdClient.id,
          changes: { name: createdClient.name },
        });
        if (input.email) made.invitation = await this.clientViewerAccess.inviteInTransaction(database, createdClient.id, input.email, request);
        return createdClient;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'clients_station_name_unique')) {
        throw new AppError('CONFLICT', {
          publicMessage: 'This station already has a client with that name.',
          internalDetail: 'duplicate client name',
          cause: error,
        });
      }
      throw error;
    }
    if (made.invitation) await this.clientViewerAccess.queueInvitationEmail(made.invitation, request);
    return { id: created.id, name: created.name, invitedEmail: made.invitation?.email ?? null };
  }

  /**
   * The client's usual card: one of its own saved card versions, or none. Row-level security keeps it to this
   * station, so another station's client is not found (404) and another station's card is never this client's.
   * The audit trail records the previous and the new card ids, never a card's content. Saving what is already set
   * changes and records nothing.
   */
  setDefaultActionCard(clientId: string, input: SetClientDefaultActionCardInput): Promise<void> {
    const actionCardId = input.actionCardId?.toLowerCase() ?? null;
    return this.stationScopedTransaction.run(async (database) => {
      const [client] = (await database.query(`SELECT id, default_action_card_id FROM app.clients WHERE id = $1 FOR UPDATE`, [clientId])) as Array<{
        id: string;
        default_action_card_id: string | null;
      }>;
      if (!client) throw new AppError('NOT_FOUND', { internalDetail: 'client not found at this station' });
      if (actionCardId !== null) {
        const ownCards = (await database.query(`SELECT 1 FROM app.action_cards WHERE id = $1 AND client_id = $2`, [actionCardId, clientId])) as unknown[];
        if (ownCards.length === 0) {
          const reason: ClientDefaultCardReason = 'card_not_of_this_client';
          throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'actionCardId', code: reason }], internalDetail: 'the card is not one of this client’s card versions' });
        }
      }
      if (client.default_action_card_id === actionCardId) return;
      await database.query(`UPDATE app.clients SET default_action_card_id = $2 WHERE id = $1`, [clientId, actionCardId]);
      await this.auditTrail.record(database, {
        action: 'client_default_card_changed',
        entityType: 'client',
        entityId: clientId,
        changes: { previousActionCardId: client.default_action_card_id, actionCardId },
      });
    });
  }
}
