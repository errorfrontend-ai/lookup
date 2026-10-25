import {
  type ClientAdDetail,
  type ClientAdFigures,
  ClientFiguresQuery,
  type ClientHome,
  type ClientNotificationSettings,
  ClientNotificationSettingsInput,
  ClientSpreadsheetQuery,
  type ListenerMix,
  PushSubscriptionInput,
  PushSubscriptionRemovalInput,
  type TestNotificationResult,
} from '@lookup/contracts';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';
import type { RateLimitRule } from '../../common/rate-limiting/rate-limit-rule.js';
import { RateLimit } from '../../common/rate-limiting/rate-limit.decorator.js';
import { UuidOrNotFoundPipe } from '../../common/validation/uuid-or-not-found.pipe.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { PUSH_SENDER, type PushSender } from '../notifications/web-push.js';
import { ClientArea } from './client-area.service.js';
import { ClientDevices } from './client-devices.js';
import { ClientViewerGuard } from './client-viewer.guard.js';

/**
 * The client area (ADR-006): what a person who follows a station's client sees, and their own reminder settings. Nothing
 * here changes station data (P5C-ACCESS-02).
 */
/** A test notification is for checking a device, not for sending many: a few per person's address every 10 minutes. */
const TEST_NOTIFICATIONS_PER_ADDRESS: RateLimitRule = { counterName: 'client-test-notifications-per-address', maximumRequests: 6, windowSeconds: 10 * 60 };

@Controller('client')
@UseGuards(ClientViewerGuard)
export class ClientAreaController {
  constructor(
    private readonly clientArea: ClientArea,
    private readonly clientDevices: ClientDevices,
    @Inject(PUSH_SENDER) private readonly pushSender: PushSender,
    private readonly requestContext: ClsService,
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
    return this.clientArea.notificationSettings(this.pushSender.publicKey);
  }

  @Put('notification-settings')
  saveNotificationSettings(@Body(new ZodValidationPipe(ClientNotificationSettingsInput)) input: ClientNotificationSettingsInput): Promise<ClientNotificationSettings> {
    return this.clientArea.saveNotificationSettings(input, this.pushSender.publicKey);
  }

  /** Notifications on this device: the browser's push subscription (PUSH_NOT_AVAILABLE without the server's keys). */
  @Post('push-subscriptions')
  @HttpCode(204)
  async turnOnDevice(@Body(new ZodValidationPipe(PushSubscriptionInput)) input: PushSubscriptionInput): Promise<void> {
    await this.clientDevices.turnOn(input);
  }

  /** Notifications off on this device. */
  @Post('push-subscriptions/removal')
  @HttpCode(204)
  async turnOffDevice(@Body(new ZodValidationPipe(PushSubscriptionRemovalInput)) input: PushSubscriptionRemovalInput): Promise<void> {
    await this.clientDevices.turnOff(input);
  }

  @Post('test-notification')
  @HttpCode(200)
  @RateLimit(TEST_NOTIFICATIONS_PER_ADDRESS)
  sendTestNotification(@Req() request: Request): Promise<TestNotificationResult> {
    return this.clientDevices.sendTest((request as Request & { id?: string }).id ?? 'unknown', this.requestContext.get<string>('userId'));
  }
}
