import { Module } from '@nestjs/common';
import { StationsModule } from '../stations/stations.module.js';
import { ActionCardsController } from './action-cards.controller.js';
import { ActionCardsService } from './action-cards.service.js';

@Module({
  imports: [StationsModule],
  controllers: [ActionCardsController],
  providers: [ActionCardsService],
})
export class ActionCardsModule {}
