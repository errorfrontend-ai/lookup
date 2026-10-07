import { Module } from '@nestjs/common';
import { ListenerInstallsController } from './listener-installs.controller.js';
import { ListenerInstallsService } from './listener-installs.service.js';

@Module({ controllers: [ListenerInstallsController], providers: [ListenerInstallsService] })
export class ListenerInstallsModule {}
