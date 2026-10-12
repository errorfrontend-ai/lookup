import type { ClientDefaultCardReason, ClientListItem, ClientSummary, CreateClientInput, SetClientDefaultActionCardInput } from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import { AuditTrail } from '../../common/audit/audit-trail.js';
import { AppError } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/errors/database-errors.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';

@Injectable()
export class ClientsService {
  constructor(
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly auditTrail: AuditTrail,
  ) {}

  /** The station's clients, A to Z, each with how many ads it has (archived ones not counted) and how many are on air now. */
  list(): Promise<ClientListItem[]> {
    return this.stationScopedTransaction.run(async (database) => {
      const rows = (await database.query(
        `SELECT clients.id, clients.name,
                count(ads.id)::integer AS ad_count,
                count(ads.id) FILTER (
                  WHERE campaign.id IS NOT NULL AND app.campaign_display_status(campaign.id, now()) = 'LIVE_NOW'
                )::integer AS live_now_ad_count
           FROM app.clients
           LEFT JOIN app.ads ON ads.client_id = clients.id AND ads.station_id = clients.station_id AND ads.archived_at IS NULL
           LEFT JOIN LATERAL (
             SELECT latest.id FROM app.campaigns AS latest
              WHERE latest.ad_id = ads.id AND latest.station_id = ads.station_id
              ORDER BY latest.created_at DESC LIMIT 1
           ) AS campaign ON true
          WHERE clients.station_id = app.current_station_id()
          GROUP BY clients.id, clients.name
          ORDER BY lower(clients.name), clients.id`,
      )) as Array<{ id: string; name: string; ad_count: number; live_now_ad_count: number }>;
      return rows.map((row) => ({ id: row.id, name: row.name, adCount: row.ad_count, liveNowAdCount: row.live_now_ad_count }));
    });
  }

  async create(input: CreateClientInput): Promise<ClientSummary> {
    try {
      return await this.stationScopedTransaction.run(async (database) => {
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
