import { Module } from '@nestjs/common';
import { ClientViewersModule } from '../client-viewers/client-viewers.module.js';
import { StationsModule } from '../stations/stations.module.js';
import { ClientsController } from './clients.controller.js';
import { ClientsService } from './clients.service.js';

@Module({
  imports: [StationsModule, ClientViewersModule],
  controllers: [ClientsController],
  providers: [ClientsService],
})
export class ClientsModule {}
