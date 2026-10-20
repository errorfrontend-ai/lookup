import { type ListenerMix, ListenerMixQuery } from '@lookup/contracts';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { UuidOrNotFoundPipe } from '../../common/validation/uuid-or-not-found.pipe.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { StationAccessGuard } from '../stations/station-access.guard.js';
import { ListenerMixService } from './listener-mix.service.js';

/** Who is listening to the station's ads, by gender and age band. Every member of an active station may read it. */
@Controller('stations/:stationId/listener-mix')
@UseGuards(StationAccessGuard)
export class ListenerMixController {
  constructor(private readonly listenerMixService: ListenerMixService) {}

  @Get()
  read(@Query(new ZodValidationPipe(ListenerMixQuery)) query: ListenerMixQuery): Promise<ListenerMix> {
    return this.listenerMixService.readForStation(query);
  }
}

/** The same for one ad of the station. */
@Controller('stations/:stationId/ads/:adId/listener-mix')
@UseGuards(StationAccessGuard)
export class AdListenerMixController {
  constructor(private readonly listenerMixService: ListenerMixService) {}

  @Get()
  read(@Param('adId', new UuidOrNotFoundPipe()) adId: string, @Query(new ZodValidationPipe(ListenerMixQuery)) query: ListenerMixQuery): Promise<ListenerMix> {
    return this.listenerMixService.readForAd(adId, query);
  }
}
