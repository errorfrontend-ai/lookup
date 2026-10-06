import type { StationProfile, StationRole, StationStatus, UpdateStationProfileInput } from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { EntityManager } from 'typeorm';
import { AuditTrail } from '../../common/audit/audit-trail.js';
import { AppError } from '../../common/errors/app-error.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';

interface StationRow {
  id: string;
  name: string;
  frequency_label: string;
  province: string | null;
  city: string | null;
  time_zone: string;
  status: StationStatus;
  is_listed_in_app: boolean;
}

@Injectable()
export class StationsService {
  constructor(
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly requestContext: ClsService,
    private readonly auditTrail: AuditTrail,
  ) {}

  /** The station's profile; available while the station is still under review. */
  readProfile(): Promise<StationProfile> {
    return this.stationScopedTransaction.run((database) => this.readProfileWithin(database));
  }

  /**
   * Changes where the station is. Only province and city: the name, frequency and licence are checked
   * by Look Up before they change, and the time zone stays put because every campaign's start and end
   * are fixed instants worked out from it. Saving what is already there records nothing.
   */
  updateProfile(input: UpdateStationProfileInput): Promise<StationProfile> {
    return this.stationScopedTransaction.run(async (database) => {
      const [before] = (await database.query(`SELECT province, city FROM app.stations WHERE id = app.current_station_id() FOR UPDATE`)) as Array<{
        province: string | null;
        city: string | null;
      }>;
      if (!before) throw new AppError('NOT_FOUND', { internalDetail: 'station row not visible after the access check' });
      if (before.province !== input.province || before.city !== input.city) {
        await database.query(`UPDATE app.stations SET province = $1, city = $2 WHERE id = app.current_station_id()`, [input.province, input.city]);
        await this.auditTrail.record(database, {
          action: 'station_profile_changed',
          entityType: 'station',
          entityId: this.requestContext.get<string>('stationId'),
          changes: { previous: { province: before.province, city: before.city }, next: { province: input.province, city: input.city } },
        });
      }
      return this.readProfileWithin(database);
    });
  }

  private async readProfileWithin(database: EntityManager): Promise<StationProfile> {
    const [station] = (await database.query(
      `SELECT id, name, frequency_label, province, city, time_zone, status, is_listed_in_app
         FROM app.stations WHERE id = app.current_station_id()`,
    )) as StationRow[];
    if (!station) throw new AppError('NOT_FOUND', { internalDetail: 'station row not visible after the access check' });
    return {
      id: station.id,
      name: station.name,
      frequencyLabel: station.frequency_label,
      province: station.province,
      city: station.city,
      timeZone: station.time_zone,
      status: station.status,
      isListedInApp: station.is_listed_in_app,
      yourRole: this.requestContext.get<StationRole>('stationRole'),
    };
  }
}
