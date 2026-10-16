import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/app-error.js';

/**
 * Every route lives under /api/v1. Anything else that the portal (when served here) did not answer is refused
 * through the central exception filter, so it gets the error envelope with its request id like every other refusal,
 * never Express's own "Cannot GET /…" page, which names the method and the path in technical words.
 */
export function refusePathsOutsideTheApi(request: Request, _response: Response, next: NextFunction): void {
  if (request.path === '/api' || request.path.startsWith('/api/')) {
    next();
    return;
  }
  next(new AppError('NOT_FOUND', { internalDetail: 'a path outside the API' }));
}
