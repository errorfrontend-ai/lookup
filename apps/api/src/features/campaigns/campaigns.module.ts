import { Module } from '@nestjs/common';
import { StationsModule } from '../stations/stations.module.js';
import { CampaignsController } from './campaigns.controller.js';
import { CampaignsService } from './campaigns.service.js';

@Module({
  imports: [StationsModule],
  controllers: [CampaignsController],
  providers: [CampaignsService],
})
export class CampaignsModule {}
