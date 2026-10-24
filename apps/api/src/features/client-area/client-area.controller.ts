import {
  type ClientAdDetail,
  type ClientAdFigures,
  ClientFiguresQuery,
  type ClientHome,
  type ClientNotificationSettings,
  ClientNotificationSettingsInput,
  ClientSpreadsheetQuery,
  type ListenerMix,
} from '@lookup/contracts';
import { Body, Controller, Get, Inject, Param, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { UuidOrNotFoundPipe } from '../../common/validation/uuid-or-not-found.pipe.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { ClientArea } from './client-area.service.js';
import { ClientViewerGuard } from './client-viewer.guard.js';

/**
 * The client area (ADR-006): what a person who follows a station's client sees, and their own reminder settings. Nothing
 * here changes station data (P5C-ACCESS-02).
 */
@Controller('client')
@UseGuards(ClientViewerGuard)
export class ClientAreaController {
  constructor(
    private readonly clientArea: ClientArea,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('home')
  home(): Promise<ClientHome> {
    return this.clientArea.home();
  }

  @Get('stations/:stationId/ads/:adId')
  adDetail(@Param('stationId', new UuidOrNotFoundPipe()) stationId: string, @Param('adId', new UuidOrNotFoundPipe()) adId: string): Promise<ClientAdDetail> {
    return this.clientArea.adDetail(stationId, adId);
  }

  @Get('stations/:stationId/ads/:adId/figures')
  adFigures(
    @Param('stationId', new UuidOrNotFoundPipe()) stationId: string,
    @Param('adId', new UuidOrNotFoundPipe()) adId: string,
    @Query(new ZodValidationPipe(ClientFiguresQuery)) query: ClientFiguresQuery,
  ): Promise<ClientAdFigures> {
    return this.clientArea.adFigures(stationId, adId, query);
  }

  @Get('stations/:stationId/ads/:adId/listener-mix')
  adListenerMix(
    @Param('stationId', new UuidOrNotFoundPipe()) stationId: string,
    @Param('adId', new UuidOrNotFoundPipe()) adId: string,
    @Query(new ZodValidationPipe(ClientFiguresQuery)) query: ClientFiguresQuery,
  ): Promise<ListenerMix> {
    return this.clientArea.adListenerMix(stationId, adId, query);
  }

  /** The station's figures day by day, as a CSV file (P5C-EXPORT-01): the last 30 days unless another range is asked. */
  @Get('stations/:stationId/export.csv')
  async spreadsheet(
    @Param('stationId', new UuidOrNotFoundPipe()) stationId: string,
    @Query(new ZodValidationPipe(ClientSpreadsheetQuery)) query: ClientSpreadsheetQuery,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const file = await this.clientArea.spreadsheet(stationId, query);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    response.setHeader('Cache-Control', 'no-store');
    return file.content;
  }

  @Get('notification-settings')
  notificationSettings(): Promise<ClientNotificationSettings> {
    return this.clientArea.notificationSettings(this.config.WEB_PUSH_PUBLIC_KEY ?? null);
  }

  @Put('notification-settings')
  saveNotificationSettings(@Body(new ZodValidationPipe(ClientNotificationSettingsInput)) input: ClientNotificationSettingsInput): Promise<ClientNotificationSettings> {
    return this.clientArea.saveNotificationSettings(input, this.config.WEB_PUSH_PUBLIC_KEY ?? null);
  }
}
