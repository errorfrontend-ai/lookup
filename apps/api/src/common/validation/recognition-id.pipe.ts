import { RecognitionId } from '@lookup/contracts';
import type { PipeTransform } from '@nestjs/common';
import { AppError } from '../errors/app-error.js';

/**
 * For a recognition id in the path (a station choice, a report): a lower-case UUID version 7, as the API made it.
 * Anything else is 400 VALIDATION_FAILED naming `recognition_id` (contract §1.3), never the value sent. A
 * well-formed id that names nothing of this install's is the route's own 404.
 */
export class RecognitionIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (!RecognitionId.safeParse(value).success) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'recognition_id', code: 'invalid_format' }],
        internalDetail: 'the recognition id in the path is not a lower-case UUID version 7',
      });
    }
    return value as string;
  }
}
