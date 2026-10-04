import type { NextFunction, Request, Response } from 'express';
import type { RateLimitRule } from './rate-limit-rule.js';
import type { RateLimiter } from './rate-limiter.js';

/**
 * Baseline limit per client address on every request, unknown URLs included. Runs as early
 * middleware, so a flood is turned away before any body is parsed or route is matched.
 */
export function limitRequestsPerClientAddress(rateLimiter: RateLimiter, requestsPerMinute: number) {
  const rule: RateLimitRule = { counterName: 'client-address', maximumRequests: requestsPerMinute, windowSeconds: 60 };
  return (request: Request, response: Response, next: NextFunction): void => {
    rateLimiter.countRequest(rule, request.ip ?? 'unknown', response).then(() => next(), next);
  };
}
