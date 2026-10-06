import { type StationProfile, UpdateStationProfileInput } from '@lookup/contracts';
import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { CHANGE_STATION_PROFILE, READ_STATION_PROFILE, StationAccess } from './station-access.decorator.js';
import { StationAccessGuard } from './station-access.guard.js';
import { StationsService } from './stations.service.js';

@Controller('stations/:stationId')
@UseGuards(StationAccessGuard)
export class StationsController {
  constructor(private readonly stationsService: StationsService) {}

  /** The station's profile; available while the station is still under review. */
  @Get()
  @StationAccess(READ_STATION_PROFILE)
  profile(): Promise<StationProfile> {
    return this.stationsService.readProfile();
  }

  /** Where the station is. Owners and managers only, and allowed while the station is still under review. */
  @Put('profile')
  @StationAccess(CHANGE_STATION_PROFILE)
  updateProfile(@Body(new ZodValidationPipe(UpdateStationProfileInput)) input: UpdateStationProfileInput): Promise<StationProfile> {
    return this.stationsService.updateProfile(input);
  }
}
