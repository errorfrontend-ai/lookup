import { type ClientListItem, type ClientSummary, CreateClientInput } from '@lookup/contracts';
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { CHANGE_STATION_CONTENT, StationAccess } from '../stations/station-access.decorator.js';
import { StationAccessGuard } from '../stations/station-access.guard.js';
import { ClientsService } from './clients.service.js';

/** A station's clients: the advertisers it uploads ads for. */
@Controller('stations/:stationId/clients')
@UseGuards(StationAccessGuard)
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Get()
  list(): Promise<ClientListItem[]> {
    return this.clientsService.list();
  }

  @Post()
  @StationAccess(CHANGE_STATION_CONTENT)
  create(@Body(new ZodValidationPipe(CreateClientInput)) input: CreateClientInput): Promise<ClientSummary> {
    return this.clientsService.create(input);
  }
}
