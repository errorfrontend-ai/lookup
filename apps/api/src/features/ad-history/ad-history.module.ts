import { Module } from '@nestjs/common';
import { StationsModule } from '../stations/stations.module.js';
import { AdHistoryController } from './ad-history.controller.js';
import { AdHistoryService } from './ad-history.service.js';

@Module({
  imports: [StationsModule],
  controllers: [AdHistoryController],
  providers: [AdHistoryService],
})
export class AdHistoryModule {}
