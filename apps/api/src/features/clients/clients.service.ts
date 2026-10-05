import type { ClientSummary, CreateClientInput } from '@lookup/contracts';
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

  list(): Promise<ClientSummary[]> {
    return this.stationScopedTransaction.run(
      (database) =>
        database.query(
          `SELECT id, name FROM app.clients WHERE station_id = app.current_station_id() ORDER BY lower(name), id`,
        ) as Promise<ClientSummary[]>,
    );
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
