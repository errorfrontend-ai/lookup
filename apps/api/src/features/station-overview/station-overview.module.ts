import { Module } from '@nestjs/common';
import { StationsModule } from '../stations/stations.module.js';
import { StationOverviewController } from './station-overview.controller.js';
import { StationOverviewService } from './station-overview.service.js';

@Module({
  imports: [StationsModule],
  controllers: [StationOverviewController],
  providers: [StationOverviewService],
})
export class StationOverviewModule {}
