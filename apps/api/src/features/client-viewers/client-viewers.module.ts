import { Module } from '@nestjs/common';
import { StationsModule } from '../stations/stations.module.js';
import { ClientViewerAccess } from './client-viewer-access.js';
import { ClientViewersController } from './client-viewers.controller.js';

/** Who can view a station's clients' adverts (ADR-006; P5C-INVITATIONS, P5C-ONBOARDING). */
@Module({
  imports: [StationsModule],
  controllers: [ClientViewersController],
  providers: [ClientViewerAccess],
  exports: [ClientViewerAccess],
})
export class ClientViewersModule {}
