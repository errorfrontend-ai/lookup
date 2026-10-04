import { SetMetadata } from '@nestjs/common';
import type { RateLimitRule } from './rate-limit-rule.js';

export const RATE_LIMIT_RULE_METADATA = 'lookup:rate-limit-rule';

/** A stricter limit for one route or controller, on top of the baseline limit per client address. */
export const RateLimit = (rule: RateLimitRule) => SetMetadata(RATE_LIMIT_RULE_METADATA, rule);
