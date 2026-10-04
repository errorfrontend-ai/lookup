import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/app-error.js';

const METHODS_WITHOUT_SIDE_EFFECTS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cross-site request forgery guard for cookie sessions. Browsers attach our cookies to requests
 * that other sites trigger, so a state-changing request that carries cookies must come from one
 * of our own origins. Requests without cookies (the mobile app, which sends a bearer token) are
 * unaffected. This works alongside SameSite cookies (step 2), not instead of them.
 */
export function rejectCrossSiteCookieRequests(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (METHODS_WITHOUT_SIDE_EFFECTS.has(request.method) || !request.headers.cookie) return next();
    const origin = request.headers.origin ?? originOfReferrer(request.headers.referer);
    if (origin && allowed.has(origin)) return next();
    next(
      new AppError('FORBIDDEN', {
        internalDetail: `cross-site check: ${origin ? 'origin not allowed' : 'no origin or referer'} on a cookie request`,
      }),
    );
  };
}

function originOfReferrer(referrer: string | undefined): string | undefined {
  return referrer && URL.canParse(referrer) ? new URL(referrer).origin : undefined;
}
