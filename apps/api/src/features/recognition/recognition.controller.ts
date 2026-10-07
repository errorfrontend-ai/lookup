import { RecognizeRequestFields, type RecognizeResponse } from '@lookup/contracts';
import { Controller, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { InstallTokenGuard } from '../../common/listener-authentication/install-token.guard.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { PublicRoute } from '../authentication/public-route.decorator.js';
import { readRecognizeRequest } from './read-recognize-request.js';
import { RecognitionService } from './recognition.service.js';

/**
 * POST /api/v1/recognize: a listener's clip in, the station's buttons out. Checks run in this order,
 * each refusing before the next is done (S3-REQUEST-13): request id (middleware), install token
 * (guard), per-install limits, the body (multipart, 256 KiB), the fields, then the clip itself.
 */
@Controller('recognize')
@PublicRoute()
@UseGuards(InstallTokenGuard)
export class RecognitionController {
  private readonly fieldsPipe = new ZodValidationPipe(RecognizeRequestFields);

  constructor(
    private readonly recognitionService: RecognitionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post()
  @HttpCode(200)
  async recognize(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<RecognizeResponse> {
    const receivedAt = new Date();
    await this.recognitionService.countAgainstLimits(request.ip ?? 'unknown', response);
    const release = this.recognitionService.startRecognition(response);
    try {
      // A refused body is never kept: what is still arriving is read and dropped, never held in memory,
      // so the phone receives the answer. A clip that is too slow to arrive is refused.
      const upload = await readRecognizeRequest(request, this.config.RECOGNIZE_BODY_READ_MILLISECONDS);
      const fields = this.fieldsPipe.transform(upload.fields);
      return await this.recognitionService.recognize(fields, upload.audio, receivedAt, response);
    } finally {
      release();
    }
  }
}
