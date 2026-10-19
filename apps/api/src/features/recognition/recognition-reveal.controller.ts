import type { RecognizeResponse } from '@lookup/contracts';
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { InstallTokenGuard } from '../../common/listener-authentication/install-token.guard.js';
import { ListenerFollowUpLimitGuard } from '../../common/rate-limiting/listener-follow-up-limits.js';
import { RecognitionIdPipe } from '../../common/validation/recognition-id.pipe.js';
import { PublicRoute } from '../authentication/public-route.decorator.js';
import { RecognitionService } from './recognition.service.js';

/**
 * GET /api/v1/recognitions/{recognition_id} (ADR-005, design LA-D12): the result the server held back with
 * ACCOUNT_REQUIRED, asked for again once the listener has an account. Checks run in the order of the other follow-ups:
 * the install token, the update gate, the shared follow-up allowance, then the path's recognition id. It answers only
 * the install that made the recognition; another install's id and an unknown one are the same 404.
 */
@Controller('recognitions')
@PublicRoute()
@UseGuards(InstallTokenGuard, ListenerFollowUpLimitGuard)
export class RecognitionRevealController {
  private readonly recognitionIdPipe = new RecognitionIdPipe();

  constructor(private readonly recognitionService: RecognitionService) {}

  @Get(':recognitionId')
  reveal(@Param('recognitionId') recognitionIdInPath: unknown): Promise<RecognizeResponse> {
    return this.recognitionService.reveal(this.recognitionIdPipe.transform(recognitionIdInPath));
  }
}
