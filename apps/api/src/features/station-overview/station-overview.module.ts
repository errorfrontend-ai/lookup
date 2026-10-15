import { Module } from '@nestjs/common';
import { StationsModule } from '../stations/stations.module.js';
import { ListenerFiguresController } from './listener-figures.controller.js';
import { ListenerFiguresService } from './listener-figures.service.js';
import { StationOverviewController } from './station-overview.controller.js';
import { StationOverviewService } from './station-overview.service.js';

@Module({
  imports: [StationsModule],
  controllers: [StationOverviewController, ListenerFiguresController],
  providers: [StationOverviewService, ListenerFiguresService],
})
export class StationOverviewModule {}
