import { RecognizeRequestFields, type RecognizeResponse } from '@lookup/contracts';
import { Controller, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/app-error.js';
import { InstallTokenGuard } from '../../common/listener-authentication/install-token.guard.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { PublicRoute } from '../authentication/public-route.decorator.js';
import { readRecognizeRequest } from './read-recognize-request.js';
import { RecognitionService } from './recognition.service.js';

/**
 * POST /api/v1/recognize: a listener's clip in, the station's buttons out. Checks run in this order, each refusing
 * before the next is done (P4 design §5.2, contract Correction 1): request id, the listener per-address ceiling and
 * the cross-site check (middleware); the install token and the update gate (guard); the recognize per-address
 * limit; the body's type and declared length; then, when the text fields have arrived and before any audio is
 * read, a place in flight and the per-install allowance; invalid fields; the audio part, its first bytes, the
 * capture time, the claim, admission, the job and the answer.
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
    await this.recognitionService.countAgainstAddressLimit(request.ip ?? 'unknown', response);
    const places = this.recognitionService.newPlacesInFlight();
    try {
      // A refused body is never kept: what is still arriving is read and dropped, never held in memory,
      // so the phone receives the answer. A clip that is too slow to arrive is refused.
      const upload = await readRecognizeRequest(request, this.config.RECOGNIZE_BODY_READ_MILLISECONDS, (fieldsBeforeAudio) =>
        this.recognitionService.admitBeforeAudio(fieldsBeforeAudio, places, response),
      );
      if (upload.audio === null) {
        // No audio part at all: one live request, then the same answer as before (P4 design §5.2).
        await this.recognitionService.countAgainstLiveAllowance(response);
        throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'audio', code: 'invalid_type' }], internalDetail: 'no audio part' });
      }
      if (upload.hasPartAfterAudio) {
        throw new AppError('VALIDATION_FAILED', { fields: [{ path: 'audio', code: 'audio_part_before_fields' }], internalDetail: 'a part came after the audio part' });
      }
      const fields = this.fieldsPipe.transform(upload.fields);
      return await this.recognitionService.recognize(fields, upload.audio, receivedAt, response);
    } finally {
      places.release();
    }
  }
}
