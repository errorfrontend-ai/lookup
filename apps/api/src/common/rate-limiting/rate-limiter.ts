import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { KEY_VALUE_STORE } from '../../infrastructure/key-value-store/key-value-store.module.js';
import { AppError } from '../errors/app-error.js';
import type { RateLimitRule } from './rate-limit-rule.js';

// Fixed window, atomic on the server: count the request, and start the window's expiry with the
// first one. Returns the count so far and the milliseconds left in the window.
const COUNT_REQUEST_SCRIPT = `local request_count = redis.call('INCR', KEYS[1])
if request_count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {request_count, redis.call('PTTL', KEYS[1])}`;

/** Counts requests per client in the key-value store, so limits hold across every API instance. */
@Injectable()
export class RateLimiter {
  constructor(
    @Inject(KEY_VALUE_STORE) private readonly keyValueStore: Redis,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('rate-limiting');
  }

  /**
   * Count one request from `client` (a client address today; an install or account id later)
   * and throw RATE_LIMITED with a Retry-After header once the rule's maximum is passed. The
   * client identifier is hashed, so raw addresses never sit in the store.
   */
  async countRequest(rule: RateLimitRule, client: string, response: Response): Promise<void> {
    const clientHash = createHash('sha256').update(client).digest('base64url').slice(0, 22);
    const counterKey = `rate-limit:${rule.counterName}:${clientHash}`;
    let requestCount: number;
    let millisecondsUntilReset: number;
    try {
      [requestCount, millisecondsUntilReset] = (await this.keyValueStore.eval(
        COUNT_REQUEST_SCRIPT,
        1,
        counterKey,
        rule.windowSeconds * 1000,
      )) as [number, number];
    } catch (error) {
      if (rule.refuseWhenStoreUnavailable) {
        throw new AppError('SERVICE_UNAVAILABLE', {
          internalDetail: `rate limit store unavailable; refusing (counter ${rule.counterName})`,
          cause: error,
        });
      }
      this.logger.warn({ err: error, counterName: rule.counterName }, 'rate limit store unavailable; allowing request');
      return;
    }
    if (requestCount > rule.maximumRequests) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil(millisecondsUntilReset / 1000))));
      throw new AppError('RATE_LIMITED', {
        internalDetail: `counter ${rule.counterName}: ${requestCount} requests, maximum ${rule.maximumRequests} per ${rule.windowSeconds}s`,
      });
    }
  }
}
