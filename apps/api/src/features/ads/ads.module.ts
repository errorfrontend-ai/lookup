import { Module } from '@nestjs/common';
import { StationsModule } from '../stations/stations.module.js';
import { AdsController } from './ads.controller.js';
import { AdsService } from './ads.service.js';

@Module({
  imports: [StationsModule],
  controllers: [AdsController],
  providers: [AdsService],
  exports: [AdsService],
})
export class AdsModule {}
