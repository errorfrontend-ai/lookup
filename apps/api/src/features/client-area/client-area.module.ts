import { Module } from '@nestjs/common';
import { ClientAreaController } from './client-area.controller.js';
import { ClientArea } from './client-area.service.js';
import { ClientViewerGuard } from './client-viewer.guard.js';

/** The client area (ADR-006; P5C-DASHBOARD, P5C-ADVERT, P5C-NOTIFY). */
@Module({
  controllers: [ClientAreaController],
  providers: [ClientArea, ClientViewerGuard],
  exports: [ClientArea],
})
export class ClientAreaModule {}
