import { RecordEngagementInput } from '@lookup/contracts';
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { AppError } from '../../common/errors/app-error.js';
import { InstallTokenGuard, LISTENER_INSTALL_ID } from '../../common/listener-authentication/install-token.guard.js';
import { ListenerFollowUpLimitGuard } from '../../common/rate-limiting/listener-follow-up-limits.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { PublicRoute } from '../authentication/public-route.decorator.js';
import { Engagements } from './engagements.js';

/**
 * POST /api/v1/engagements (P4 design §5.8, contract §1.5): one tap of a button on a card a recognition showed, sent
 * by the phone's outbox, perhaps much later and perhaps more than once. Only ids travel, never the button's type,
 * label, number or link; the server takes the type from the card it showed. Answered 204 whether the tap was stored,
 * was already stored, or did not count toward a limit (gap 31): the phone never learns how a campaign is doing.
 *
 * Checks run in the follow-ups' order (contract §1.0, Correction 1): request id, the per-address ceiling, the
 * cross-site check and the JSON body parser (middleware); the install token, the update gate and the follow-up
 * allowance shared with choices and reports (guards); then the body.
 */
@Controller('engagements')
@PublicRoute()
@UseGuards(InstallTokenGuard, ListenerFollowUpLimitGuard)
export class EngagementsController {
  private readonly tapPipe = new ZodValidationPipe(RecordEngagementInput);

  constructor(
    private readonly engagements: Engagements,
    private readonly requestContext: ClsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('engagements');
  }

  @Post()
  @HttpCode(204)
  async record(@Body() body: unknown): Promise<void> {
    const tap = this.tapPipe.transform(body);
    const requestId = this.requestContext.getId();
    const answer = await this.engagements.record({
      recognitionId: tap.recognition_id,
      listenerInstallId: this.requestContext.get<string>(LISTENER_INSTALL_ID),
      stationId: tap.station_id,
      actionId: tap.action_id,
      occurredAt: new Date(tap.occurred_at),
      sentAt: new Date(tap.sent_at),
      receivedAt: new Date(),
      requestId,
    });
    // One line per tap (P4 design §5.13): the outcome only, never the install, the station or the button, which with
    // a time is a listening habit.
    this.logger.info({ requestId, recognitionId: tap.recognition_id, outcome: answer }, `tap ${answer}`);
    switch (answer) {
      case 'RECORDED':
      case 'ALREADY_RECORDED':
        return;
      case 'NOT_FOUND':
        throw new AppError('NOT_FOUND', { internalDetail: 'no finished recognition of this install has that id' });
      case 'NOT_A_CANDIDATE':
        throw new AppError('STATION_NOT_A_CANDIDATE', { internalDetail: 'the tapped station was not shown for this recognition' });
      case 'ANOTHER_STATION_CHOSEN':
        throw new AppError('STATION_ALREADY_CHOSEN', { internalDetail: 'another station was chosen for this recognition' });
      case 'ACTION_NOT_ON_CARD':
        throw new AppError('ACTION_NOT_ON_CARD', { internalDetail: 'the tapped button is not on the card shown' });
    }
  }
}
