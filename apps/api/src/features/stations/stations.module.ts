import { Module } from '@nestjs/common';
import { StationAccessGuard } from './station-access.guard.js';
import { StationsController } from './stations.controller.js';

@Module({
  controllers: [StationsController],
  providers: [StationAccessGuard],
  exports: [StationAccessGuard],
})
export class StationsModule {}
