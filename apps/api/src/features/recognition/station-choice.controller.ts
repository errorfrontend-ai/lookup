import { RecognitionStationChoiceInput } from '@lookup/contracts';
import { Body, Controller, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { AppError } from '../../common/errors/app-error.js';
import { isAccountRequiredAndMissing } from '../../common/listener-authentication/account-required.js';
import { InstallTokenGuard, LISTENER_INSTALL_ID } from '../../common/listener-authentication/install-token.guard.js';
import { ListenerFollowUpLimitGuard } from '../../common/rate-limiting/listener-follow-up-limits.js';
import { RecognitionIdPipe } from '../../common/validation/recognition-id.pipe.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { PublicRoute } from '../authentication/public-route.decorator.js';
import { RecognitionRecords } from './recognition-records.js';

/**
 * POST /api/v1/recognitions/{recognition_id}/choice (P4 design §5.5, contract §1.3): the station the listener
 * picked in the "Which station?" sheet. Its outbox sends it until it gets an answer, so the same choice sent again
 * answers 204 and changes nothing; the first choice wins. There is no time limit and no cancel request.
 *
 * Checks run in this order, each refusing before the next is done (contract §1.0, Correction 1): request id, the
 * per-address listener ceiling, the cross-site check and the JSON body parser (middleware); the install token and
 * the follow-up allowance (guards, in that order); then the path's recognition id, then the body, here, so the
 * order is the same whatever order Nest would apply parameter pipes in.
 */
@Controller('recognitions')
@PublicRoute()
@UseGuards(InstallTokenGuard, ListenerFollowUpLimitGuard)
export class StationChoiceController {
  private readonly recognitionIdPipe = new RecognitionIdPipe();
  private readonly choicePipe = new ZodValidationPipe(RecognitionStationChoiceInput);

  constructor(
    private readonly records: RecognitionRecords,
    private readonly requestContext: ClsService,
    private readonly logger: PinoLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.logger.setContext('recognition');
  }

  @Post(':recognitionId/choice')
  @HttpCode(204)
  async choose(@Param('recognitionId') recognitionIdInPath: unknown, @Body() body: unknown): Promise<void> {
    const recognitionId = this.recognitionIdPipe.transform(recognitionIdInPath);
    const choice = this.choicePipe.transform(body);
    // An install with no account was shown no stations (ADR-005): the answers below would tell it which stations own
    // the withheld recording, so it is answered like an unknown recognition (LA-GATE-08).
    if (isAccountRequiredAndMissing(this.config, this.requestContext)) {
      throw new AppError('NOT_FOUND', { internalDetail: 'a station choice from an install with no listener account' });
    }
    const answer = await this.records.recordStationChoice(recognitionId, this.requestContext.get<string>(LISTENER_INSTALL_ID), choice.station_id);
    // One line per choice (P4 design §5.13): the outcome, never the install or the station chosen, which with a
    // time is a listening habit.
    this.logger.info({ requestId: this.requestContext.getId(), recognitionId, outcome: answer }, `choice ${answer}`);
    switch (answer) {
      case 'CHOSEN':
      case 'ALREADY_CHOSEN':
        return;
      case 'NOT_FOUND':
        throw new AppError('NOT_FOUND', { internalDetail: 'no chooser of this install has that recognition id' });
      case 'NOT_A_CANDIDATE':
        throw new AppError('STATION_NOT_A_CANDIDATE', { internalDetail: 'the station was not shown in this chooser' });
      case 'ANOTHER_STATION_CHOSEN':
        throw new AppError('STATION_ALREADY_CHOSEN', { internalDetail: 'another station was chosen for this recognition first' });
    }
  }
}
