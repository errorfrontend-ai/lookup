import { type ListenerFigures, ListenerFiguresQuery } from '@lookup/contracts';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { StationAccessGuard } from '../stations/station-access.guard.js';
import { ListenerFiguresService } from './listener-figures.service.js';

/** How listeners responded to the station's ads. Every member of an active station may read it. */
@Controller('stations/:stationId/listener-figures')
@UseGuards(StationAccessGuard)
export class ListenerFiguresController {
  constructor(private readonly listenerFiguresService: ListenerFiguresService) {}

  @Get()
  read(@Query(new ZodValidationPipe(ListenerFiguresQuery)) query: ListenerFiguresQuery): Promise<ListenerFigures> {
    return this.listenerFiguresService.read(query);
  }
}
