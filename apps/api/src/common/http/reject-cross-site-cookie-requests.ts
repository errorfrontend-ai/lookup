import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/app-error.js';

const METHODS_WITHOUT_SIDE_EFFECTS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Routes that set session cookies: sign-in, sign-up step 1 and accepting an invitation (P5A design §3.3). */
const SESSION_STARTING_ROUTE_PREFIXES = ['/api/v1/auth/', '/api/v1/registration/', '/api/v1/invitations/'];

/**
 * Cross-site request forgery guard. Browsers attach our cookies to requests that other sites trigger,
 * so a state-changing request must come from one of our own origins when:
 *  - it carries cookies, or
 *  - it goes to a route that starts a session (sign-in, sign-up, accepting an invitation), even without
 *    cookies, because another site could otherwise sign a visitor's browser in to an attacker's account
 *    (login CSRF).
 * Other requests without cookies (the mobile app, which sends a bearer token) are unaffected. This
 * works alongside SameSite=Strict cookies, not instead of them.
 */
export function rejectCrossSiteCookieRequests(allowedOrigins: readonly string[]) {
  const allowed = new Set(allowedOrigins);
  return (request: Request, _response: Response, next: NextFunction): void => {
    if (METHODS_WITHOUT_SIDE_EFFECTS.has(request.method)) return next();
    const isAuthenticationRoute = SESSION_STARTING_ROUTE_PREFIXES.some((prefix) => request.path.startsWith(prefix));
    if (!request.headers.cookie && !isAuthenticationRoute) return next();
    const origin = request.headers.origin ?? originOfReferrer(request.headers.referer);
    if (origin && allowed.has(origin)) return next();
    next(
      new AppError('FORBIDDEN', {
        internalDetail: `cross-site check: ${origin ? 'origin not allowed' : 'no origin or referer'} on ${
          isAuthenticationRoute ? 'a sign-in route' : 'a cookie request'
        }`,
      }),
    );
  };
}

function originOfReferrer(referrer: string | undefined): string | undefined {
  return referrer && URL.canParse(referrer) ? new URL(referrer).origin : undefined;
}
