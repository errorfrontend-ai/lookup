import { Module } from '@nestjs/common';
import { StationsModule } from '../stations/stations.module.js';
import { ClientsController } from './clients.controller.js';
import { ClientsService } from './clients.service.js';

@Module({
  imports: [StationsModule],
  controllers: [ClientsController],
  providers: [ClientsService],
})
export class ClientsModule {}
