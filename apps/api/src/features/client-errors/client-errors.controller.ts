import { ClientErrorReport } from '@lookup/contracts';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { RateLimit } from '../../common/rate-limiting/rate-limit.decorator.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { PublicRoute } from '../authentication/public-route.decorator.js';
import { pathOnly, scrubPersonalData } from './scrub-personal-data.js';

/**
 * Where the portal and the listener app report their own crashes, so client errors reach the
 * developers. Public, because a crash can happen before sign-in; rate-limited per address; every
 * text field is scrubbed before it is logged, and logs are JSON, so a report can't forge log lines.
 */
@Controller('client-errors')
@PublicRoute()
export class ClientErrorsController {
  constructor(
    private readonly logger: PinoLogger,
    private readonly requestContext: ClsService,
  ) {
    this.logger.setContext('client-errors');
  }

  @Post()
  @HttpCode(202)
  @RateLimit({ counterName: 'client-error-reports-per-address', maximumRequests: 30, windowSeconds: 60 })
  report(@Body(new ZodValidationPipe(ClientErrorReport)) report: ClientErrorReport): void {
    this.logger.error(
      {
        requestId: this.requestContext.getId(),
        clientError: {
          source: report.source,
          kind: report.kind,
          message: scrubPersonalData(report.message),
          stack: report.stack ? scrubPersonalData(report.stack) : undefined,
          location: report.location ? scrubPersonalData(pathOnly(report.location)) : undefined,
          relatedRequestId: report.relatedRequestId,
          appVersion: report.appVersion,
        },
      },
      'client error reported',
    );
  }
}
