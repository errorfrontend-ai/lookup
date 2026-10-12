import { type ClientListItem, type ClientSummary, CreateClientInput, SetClientDefaultActionCardInput } from '@lookup/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { UuidOrNotFoundPipe } from '../../common/validation/uuid-or-not-found.pipe.js';
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

  /**
   * Sets or clears the client's usual card (P4-FALLBACK-04, -05; P4 design §5.10): owners and managers only, to one
   * of this client's saved card versions. 204 with no body. The portal control comes with P5B; until then the
   * development seed sets usual cards.
   */
  @Put(':clientId/default-action-card')
  @StationAccess(CHANGE_STATION_CONTENT)
  @HttpCode(204)
  async setDefaultActionCard(
    @Param('clientId', new UuidOrNotFoundPipe()) clientId: string,
    @Body(new ZodValidationPipe(SetClientDefaultActionCardInput)) input: SetClientDefaultActionCardInput,
  ): Promise<void> {
    await this.clientsService.setDefaultActionCard(clientId, input);
  }
}
