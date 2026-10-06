import { Module } from '@nestjs/common';
import { StationAccessGuard } from './station-access.guard.js';
import { StationsController } from './stations.controller.js';
import { StationsService } from './stations.service.js';

@Module({
  controllers: [StationsController],
  providers: [StationAccessGuard, StationsService],
  exports: [StationAccessGuard],
})
export class StationsModule {}
