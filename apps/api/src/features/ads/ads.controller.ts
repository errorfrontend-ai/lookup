import {
  AdListQuery,
  type AdDetail,
  type AdListPage,
  type AdPlaybackUrl,
  CreateAdInput,
  RenameAdInput,
  type CreatedAd,
  RequestUploadUrlInput,
  type UploadInstructions,
} from '@lookup/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { RateLimit } from '../../common/rate-limiting/rate-limit.decorator.js';
import type { RateLimitRule } from '../../common/rate-limiting/rate-limit-rule.js';
import { UuidOrNotFoundPipe } from '../../common/validation/uuid-or-not-found.pipe.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { CHANGE_STATION_CONTENT, StationAccess } from '../stations/station-access.decorator.js';
import { StationAccessGuard } from '../stations/station-access.guard.js';
import { AdsService } from './ads.service.js';

/** Every upload URL is a credential for writing to storage; hand them out at a steady rate only. */
const UPLOAD_URLS_PER_ADDRESS: RateLimitRule = { counterName: 'ad-upload-urls-per-address', maximumRequests: 120, windowSeconds: 3600 };

@Controller('stations/:stationId/ads')
@UseGuards(StationAccessGuard)
export class AdsController {
  constructor(private readonly adsService: AdsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(AdListQuery)) query: AdListQuery): Promise<AdListPage> {
    return this.adsService.list(query);
  }

  @Post()
  @StationAccess(CHANGE_STATION_CONTENT)
  @RateLimit(UPLOAD_URLS_PER_ADDRESS)
  create(@Body(new ZodValidationPipe(CreateAdInput)) input: CreateAdInput): Promise<CreatedAd> {
    return this.adsService.create(input);
  }

  @Get(':adId')
  get(@Param('adId', new UuidOrNotFoundPipe()) adId: string): Promise<AdDetail> {
    return this.adsService.get(adId);
  }

  @Put(':adId/title')
  @StationAccess(CHANGE_STATION_CONTENT)
  rename(
    @Param('adId', new UuidOrNotFoundPipe()) adId: string,
    @Body(new ZodValidationPipe(RenameAdInput)) input: RenameAdInput,
  ): Promise<AdDetail> {
    return this.adsService.rename(adId, input);
  }

  @Post(':adId/archive')
  @StationAccess(CHANGE_STATION_CONTENT)
  @HttpCode(204)
  archive(@Param('adId', new UuidOrNotFoundPipe()) adId: string): Promise<void> {
    return this.adsService.archive(adId);
  }

  @Post(':adId/upload-url')
  @StationAccess(CHANGE_STATION_CONTENT)
  @RateLimit(UPLOAD_URLS_PER_ADDRESS)
  @HttpCode(200)
  requestUploadUrl(
    @Param('adId', new UuidOrNotFoundPipe()) adId: string,
    @Body(new ZodValidationPipe(RequestUploadUrlInput)) input: RequestUploadUrlInput,
  ): Promise<UploadInstructions> {
    return this.adsService.requestUploadUrl(adId, input);
  }

  @Post(':adId/complete')
  @StationAccess(CHANGE_STATION_CONTENT)
  @HttpCode(200)
  completeUpload(@Param('adId', new UuidOrNotFoundPipe()) adId: string): Promise<AdDetail> {
    return this.adsService.completeUpload(adId);
  }

  @Get(':adId/playback-url')
  playbackUrl(@Param('adId', new UuidOrNotFoundPipe()) adId: string): Promise<AdPlaybackUrl> {
    return this.adsService.playbackUrl(adId);
  }
}
