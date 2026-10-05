import type { PipeTransform } from '@nestjs/common';
import { AppError } from '../errors/app-error.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * For ids in the path: anything that is not a UUID answers 404, exactly like an id that doesn't
 * exist or belongs to another station, so the answer never hints at which ids are real.
 */
export class UuidOrNotFoundPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new AppError('NOT_FOUND', { internalDetail: 'path id is not a UUID' });
    }
    return value.toLowerCase();
  }
}
