import { type AdDetail, ScheduleInput } from '@lookup/contracts';
import { Body, Controller, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { UuidOrNotFoundPipe } from '../../common/validation/uuid-or-not-found.pipe.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { CHANGE_STATION_CONTENT, StationAccess } from '../stations/station-access.decorator.js';
import { StationAccessGuard } from '../stations/station-access.guard.js';
import { CampaignsService } from './campaigns.service.js';

/** When an ad airs, and making it live. Addressed through the ad, which has one campaign in Step 2. */
@Controller('stations/:stationId/ads/:adId')
@UseGuards(StationAccessGuard)
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Put('schedule')
  @StationAccess(CHANGE_STATION_CONTENT)
  putSchedule(
    @Param('adId', new UuidOrNotFoundPipe()) adId: string,
    @Body(new ZodValidationPipe(ScheduleInput)) schedule: ScheduleInput,
  ): Promise<AdDetail> {
    return this.campaignsService.putSchedule(adId, schedule);
  }

  @Post('publish')
  @StationAccess(CHANGE_STATION_CONTENT)
  @HttpCode(200)
  publish(@Param('adId', new UuidOrNotFoundPipe()) adId: string): Promise<AdDetail> {
    return this.campaignsService.publish(adId);
  }
}
