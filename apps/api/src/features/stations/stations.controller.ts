import type { StationProfile, StationRole, StationStatus } from '@lookup/contracts';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AppError } from '../../common/errors/app-error.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { READ_STATION_PROFILE, StationAccess } from './station-access.decorator.js';
import { StationAccessGuard } from './station-access.guard.js';

@Controller('stations/:stationId')
@UseGuards(StationAccessGuard)
export class StationsController {
  constructor(
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly requestContext: ClsService,
  ) {}

  /** The station's profile; available while the station is still under review. */
  @Get()
  @StationAccess(READ_STATION_PROFILE)
  async profile(): Promise<StationProfile> {
    const [station] = (await this.stationScopedTransaction.run((database) =>
      database.query(
        `SELECT id, name, frequency_label, province, city, time_zone, status, is_listed_in_app
           FROM app.stations WHERE id = app.current_station_id()`,
      ),
    )) as Array<{
      id: string;
      name: string;
      frequency_label: string;
      province: string | null;
      city: string | null;
      time_zone: string;
      status: StationStatus;
      is_listed_in_app: boolean;
    }>;
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
