import { Module } from '@nestjs/common';
import { StationsModule } from '../stations/stations.module.js';
import { AdsController } from './ads.controller.js';
import { AdsService } from './ads.service.js';
import { IngestSweep } from './ingest-sweep.js';

@Module({
  imports: [StationsModule],
  controllers: [AdsController],
  providers: [AdsService, IngestSweep],
  exports: [AdsService, IngestSweep],
})
export class AdsModule {}
