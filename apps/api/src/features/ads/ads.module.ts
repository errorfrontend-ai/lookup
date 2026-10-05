import { Module } from '@nestjs/common';
import { StationsModule } from '../stations/stations.module.js';
import { AdCampaignsService } from './ad-campaigns.service.js';
import { AdsController } from './ads.controller.js';
import { AdsService } from './ads.service.js';

@Module({
  imports: [StationsModule],
  controllers: [AdsController],
  providers: [AdsService, AdCampaignsService],
  exports: [AdsService],
})
export class AdsModule {}
