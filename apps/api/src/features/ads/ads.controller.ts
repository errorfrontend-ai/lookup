import {
  type AdListPage,
  type AdPlaybackUrl,
  type AdSummary,
  CreateAdInput,
  type CreatedAd,
  RequestUploadUrlInput,
  type UploadInstructions,
} from '@lookup/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { RateLimit } from '../../common/rate-limiting/rate-limit.decorator.js';
import type { RateLimitRule } from '../../common/rate-limiting/rate-limit-rule.js';
import { UuidOrNotFoundPipe } from '../../common/validation/uuid-or-not-found.pipe.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { CHANGE_STATION_CONTENT, StationAccess } from '../stations/station-access.decorator.js';
import { StationAccessGuard } from '../stations/station-access.guard.js';
import { AdsService } from './ads.service.js';

/** Every upload URL is a credential for writing to storage; hand them out at a steady rate only. */
const UPLOAD_URLS_PER_ADDRESS: RateLimitRule = { counterName: 'ad-upload-urls-per-address', maximumRequests: 120, windowSeconds: 3600 };

const AdListQuery = z.strictObject({ cursor: z.string().min(1).max(200).optional() });

@Controller('stations/:stationId/ads')
@UseGuards(StationAccessGuard)
export class AdsController {
  constructor(private readonly adsService: AdsService) {}

  @Get()
  list(@Query(new ZodValidationPipe(AdListQuery)) query: z.infer<typeof AdListQuery>): Promise<AdListPage> {
    return this.adsService.list(query.cursor);
  }

  @Post()
  @StationAccess(CHANGE_STATION_CONTENT)
  @RateLimit(UPLOAD_URLS_PER_ADDRESS)
  create(@Body(new ZodValidationPipe(CreateAdInput)) input: CreateAdInput): Promise<CreatedAd> {
    return this.adsService.create(input);
  }

  @Get(':adId')
  get(@Param('adId', new UuidOrNotFoundPipe()) adId: string): Promise<AdSummary> {
    return this.adsService.get(adId);
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
  completeUpload(@Param('adId', new UuidOrNotFoundPipe()) adId: string): Promise<AdSummary> {
    return this.adsService.completeUpload(adId);
  }

  @Get(':adId/playback-url')
  playbackUrl(@Param('adId', new UuidOrNotFoundPipe()) adId: string): Promise<AdPlaybackUrl> {
    return this.adsService.playbackUrl(adId);
  }
}
