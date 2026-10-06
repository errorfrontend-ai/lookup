import type { AdHistoryPage } from '@lookup/contracts';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { UuidOrNotFoundPipe } from '../../common/validation/uuid-or-not-found.pipe.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { StationAccessGuard } from '../stations/station-access.guard.js';
import { AdHistoryService } from './ad-history.service.js';

const AdHistoryQuery = z.strictObject({ cursor: z.string().min(1).max(30).optional() });

/** What happened to an ad. Every member of an active station may read it. */
@Controller('stations/:stationId/ads/:adId/history')
@UseGuards(StationAccessGuard)
export class AdHistoryController {
  constructor(private readonly adHistoryService: AdHistoryService) {}

  @Get()
  list(
    @Param('adId', new UuidOrNotFoundPipe()) adId: string,
    @Query(new ZodValidationPipe(AdHistoryQuery)) query: z.infer<typeof AdHistoryQuery>,
  ): Promise<AdHistoryPage> {
    return this.adHistoryService.list(adId, query.cursor);
  }
}
