import { ReportRecognitionInput } from '@lookup/contracts';
import { Body, Controller, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { AppError } from '../../common/errors/app-error.js';
import { isAccountRequiredAndMissing } from '../../common/listener-authentication/account-required.js';
import { InstallTokenGuard, LISTENER_INSTALL_HASH, LISTENER_INSTALL_ID } from '../../common/listener-authentication/install-token.guard.js';
import { ListenerFollowUpLimitGuard } from '../../common/rate-limiting/listener-follow-up-limits.js';
import { RecognitionIdPipe } from '../../common/validation/recognition-id.pipe.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { PublicRoute } from '../authentication/public-route.decorator.js';
import { RecognitionReports } from './recognition-reports.js';

/**
 * POST /api/v1/recognitions/{recognition_id}/report (P4 design §5.9, contract §1.6): "Report this", one of four fixed
 * reasons and no free text. One report per recognition: a repeat, even with another reason, answers 204 and changes
 * nothing. It is valid for the same answers a tap is, and never records a choice. The listener is kept only as the
 * keyed hash of the install that the request's log lines carry as `actor`; super admins read reports, stations never.
 *
 * Checks run in the order of the other follow-ups (contract §1.0, Correction 1): request id, the per-address ceiling,
 * the cross-site check and the JSON body parser (middleware); the install token, the update gate and the follow-up
 * allowance (guards); the path's recognition id; the body.
 */
@Controller('recognitions')
@PublicRoute()
@UseGuards(InstallTokenGuard, ListenerFollowUpLimitGuard)
export class RecognitionReportsController {
  private readonly recognitionIdPipe = new RecognitionIdPipe();
  private readonly reportPipe = new ZodValidationPipe(ReportRecognitionInput);

  constructor(
    private readonly reports: RecognitionReports,
    private readonly requestContext: ClsService,
    private readonly logger: PinoLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.logger.setContext('recognition-reports');
  }

  @Post(':recognitionId/report')
  @HttpCode(204)
  async report(@Param('recognitionId') recognitionIdInPath: unknown, @Body() body: unknown): Promise<void> {
    const recognitionId = this.recognitionIdPipe.transform(recognitionIdInPath);
    const report = this.reportPipe.transform(body);
    // An install with no account was shown nothing (ADR-005): answered like an unknown recognition (LA-GATE-08).
    if (isAccountRequiredAndMissing(this.config, this.requestContext)) {
      throw new AppError('NOT_FOUND', { internalDetail: 'a report from an install with no listener account' });
    }
    const requestId = this.requestContext.getId();
    const answer = await this.reports.record({
      recognitionId,
      listenerInstallId: this.requestContext.get<string>(LISTENER_INSTALL_ID),
      listenerInstallHash: this.requestContext.get<string>(LISTENER_INSTALL_HASH),
      stationId: report.station_id,
      reason: report.reason,
      receivedAt: new Date(),
      requestId,
    });
    // One line per report (P4 design §5.13): the outcome only; the reason and the station stay in the database.
    this.logger.info({ requestId, recognitionId, outcome: answer }, `report ${answer}`);
    switch (answer) {
      case 'RECORDED':
      case 'ALREADY_RECORDED':
        return;
      case 'NOT_FOUND':
        throw new AppError('NOT_FOUND', { internalDetail: 'no finished recognition of this install has that id' });
      case 'NOT_A_CANDIDATE':
        throw new AppError('STATION_NOT_A_CANDIDATE', { internalDetail: 'the reported station was not shown for this recognition' });
      case 'ANOTHER_STATION_CHOSEN':
        throw new AppError('STATION_ALREADY_CHOSEN', { internalDetail: 'another station was chosen for this recognition' });
    }
  }
}
