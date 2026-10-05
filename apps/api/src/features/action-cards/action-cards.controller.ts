import { ActionCard, type AdDetail } from '@lookup/contracts';
import { Body, Controller, Param, Put, UseGuards } from '@nestjs/common';
import { UuidOrNotFoundPipe } from '../../common/validation/uuid-or-not-found.pipe.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { CHANGE_STATION_CONTENT, StationAccess } from '../stations/station-access.decorator.js';
import { StationAccessGuard } from '../stations/station-access.guard.js';
import { ActionCardsService } from './action-cards.service.js';

/** The buttons listeners see for an ad. */
@Controller('stations/:stationId/ads/:adId/card')
@UseGuards(StationAccessGuard)
export class ActionCardsController {
  constructor(private readonly actionCardsService: ActionCardsService) {}

  @Put()
  @StationAccess(CHANGE_STATION_CONTENT)
  putActionCard(
    @Param('adId', new UuidOrNotFoundPipe()) adId: string,
    @Body(new ZodValidationPipe(ActionCard)) actionCard: ActionCard,
  ): Promise<AdDetail> {
    return this.actionCardsService.putActionCard(adId, actionCard);
  }
}
