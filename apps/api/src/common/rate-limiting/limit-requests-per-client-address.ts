import type { NextFunction, Request, Response } from 'express';
import type { RateLimitRule } from './rate-limit-rule.js';
import type { RateLimiter } from './rate-limiter.js';

/** The listener app's routes: many listeners share one mobile-network address, so these get a high ceiling instead. */
const LISTENER_ROUTES = new Set(['/api/v1/recognize', '/api/v1/installs']);

export function isListenerRoute(path: string): boolean {
  return LISTENER_ROUTES.has(path.replace(/\/+$/, ''));
}

/**
 * Baseline limit per client address on every request, unknown URLs included. Runs as early
 * middleware, so a flood is turned away before any body is parsed or route is matched. The listener
 * routes count against their own, much higher ceiling, because Zambian mobile networks put many
 * listeners behind one address; their real limit is per install (S3-RATELIMIT-01, -07).
 */
export function limitRequestsPerClientAddress(rateLimiter: RateLimiter, requestsPerMinute: number, listenerRequestsPerMinute: number) {
  const portalRule: RateLimitRule = { counterName: 'client-address', maximumRequests: requestsPerMinute, windowSeconds: 60 };
  const listenerRule: RateLimitRule = { counterName: 'listener-client-address', maximumRequests: listenerRequestsPerMinute, windowSeconds: 60 };
  return (request: Request, response: Response, next: NextFunction): void => {
    const rule = isListenerRoute(request.path) ? listenerRule : portalRule;
    rateLimiter.countRequest(rule, request.ip ?? 'unknown', response).then(() => next(), next);
  };
}
