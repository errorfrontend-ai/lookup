import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { KEY_VALUE_STORE } from '../../infrastructure/key-value-store/key-value-store.module.js';
import { AppError } from '../errors/app-error.js';
import { DerivedKeys } from '../security/derived-keys.js';
import type { RateLimitRule } from './rate-limit-rule.js';

// Fixed window, atomic on the server: count, and start the window's expiry with the first count.
// Returns the count so far and the milliseconds left in the window.
const INCREMENT_COUNTER_SCRIPT = `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}`;
const READ_COUNTER_SCRIPT = `local count = tonumber(redis.call('GET', KEYS[1]) or '0')
return {count, redis.call('PTTL', KEYS[1])}`;

/**
 * Counts per client in the key-value store, so limits hold across every API instance. Two kinds:
 * - request counters (countRequest): every request counts, and the one past the maximum is refused;
 * - failure counters (throwIfFailureLimitReached / recordFailure / clearFailures): only failures
 *   count, e.g. wrong passwords, and a success clears them.
 * Identifiers are hashed with a derived key, so raw addresses and emails never sit in the store.
 */
@Injectable()
export class RateLimiter {
  constructor(
    @Inject(KEY_VALUE_STORE) private readonly keyValueStore: Redis,
    private readonly logger: PinoLogger,
    private readonly derivedKeys: DerivedKeys,
  ) {
    this.logger.setContext('rate-limiting');
  }

  /** Count one request from `client` and refuse it (RATE_LIMITED with Retry-After) once past the maximum. */
  async countRequest(rule: RateLimitRule, client: string, response: Response): Promise<void> {
    const counter = await this.runCounterScript(INCREMENT_COUNTER_SCRIPT, rule, client, [rule.windowSeconds * 1000]);
    if (counter && counter.count > rule.maximumRequests) this.refuse(rule, counter, response);
  }

  /** Refuse the request if `subject` has already used up its failures in the current window. */
  async throwIfFailureLimitReached(rule: RateLimitRule, subject: string, response: Response): Promise<void> {
    const counter = await this.runCounterScript(READ_COUNTER_SCRIPT, rule, subject, []);
    if (counter && counter.count >= rule.maximumRequests) this.refuse(rule, counter, response);
  }

  async recordFailure(rule: RateLimitRule, subject: string): Promise<void> {
    await this.runCounterScript(INCREMENT_COUNTER_SCRIPT, rule, subject, [rule.windowSeconds * 1000], { quietly: true });
  }

  async clearFailures(rule: RateLimitRule, subject: string): Promise<void> {
    try {
      await this.keyValueStore.del(this.counterKey(rule, subject));
    } catch (error) {
      this.logger.warn({ err: error, counterName: rule.counterName }, 'could not clear a failure counter');
    }
  }

  private counterKey(rule: RateLimitRule, subject: string): string {
    return `rate-limit:${rule.counterName}:${this.derivedKeys.hashIdentifier(subject)}`;
  }

  /**
   * Runs a counter script. When the store can't be reached: refuse (SERVICE_UNAVAILABLE) if the rule
   * says so, otherwise log and carry on without a count. Recording a failure never refuses: the
   * check that runs before it already decided whether to refuse.
   */
  private async runCounterScript(
    script: string,
    rule: RateLimitRule,
    subject: string,
    scriptArguments: Array<string | number>,
    options: { quietly?: boolean } = {},
  ): Promise<{ count: number; millisecondsUntilReset: number } | null> {
    try {
      const [count, millisecondsUntilReset] = (await this.keyValueStore.eval(
        script,
        1,
        this.counterKey(rule, subject),
        ...scriptArguments,
      )) as [number, number];
      return { count, millisecondsUntilReset };
    } catch (error) {
      if (rule.refuseWhenStoreUnavailable && !options.quietly) {
        throw new AppError('SERVICE_UNAVAILABLE', {
          internalDetail: `rate limit store unavailable; refusing (counter ${rule.counterName})`,
          cause: error,
        });
      }
      this.logger.warn({ err: error, counterName: rule.counterName }, 'rate limit store unavailable; continuing without a count');
      return null;
    }
  }

  private refuse(rule: RateLimitRule, counter: { count: number; millisecondsUntilReset: number }, response: Response): never {
    const secondsUntilReset = counter.millisecondsUntilReset > 0 ? Math.ceil(counter.millisecondsUntilReset / 1000) : rule.windowSeconds;
    response.setHeader('Retry-After', String(Math.max(1, secondsUntilReset)));
    throw new AppError('RATE_LIMITED', {
      internalDetail: `counter ${rule.counterName}: ${counter.count}, maximum ${rule.maximumRequests} per ${rule.windowSeconds}s`,
    });
  }
}
