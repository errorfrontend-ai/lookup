import type { StationOverview } from '@lookup/contracts';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { StationAccessGuard } from '../stations/station-access.guard.js';
import { StationOverviewService } from './station-overview.service.js';

/** The station's front page. Every member of an active station may read it. */
@Controller('stations/:stationId/overview')
@UseGuards(StationAccessGuard)
export class StationOverviewController {
  constructor(private readonly stationOverviewService: StationOverviewService) {}

  @Get()
  read(): Promise<StationOverview> {
    return this.stationOverviewService.read();
  }
}
