import type { ClientListItem, ClientSummary, CreateClientInput } from '@lookup/contracts';
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
}
