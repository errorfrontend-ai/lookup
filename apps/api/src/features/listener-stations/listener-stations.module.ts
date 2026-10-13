import { Module } from '@nestjs/common';
import { ListenerStationsController } from './listener-stations.controller.js';
import { ListenerStationsService } from './listener-stations.service.js';

/** The listener app's "My station" list (P4 design §5.6). */
@Module({ controllers: [ListenerStationsController], providers: [ListenerStationsService] })
export class ListenerStationsModule {}
