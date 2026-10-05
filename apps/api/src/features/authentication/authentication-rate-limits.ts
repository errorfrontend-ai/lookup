import type { RateLimitRule } from '../../common/rate-limiting/rate-limit-rule.js';

/**
 * Sign-in limits. All of them refuse when the counter store is down: otherwise an outage would allow
 * unlimited guessing. Address limits are generous because many Zambian mobile users share one carrier
 * address; the per-account limit is what stops guessing, and a trusted browser has its own counter.
 */
export const SIGN_IN_REQUESTS_PER_ADDRESS: RateLimitRule = {
  counterName: 'sign-in-requests-per-address',
  maximumRequests: 20,
  windowSeconds: 60,
  refuseWhenStoreUnavailable: true,
};

export const SIGN_IN_FAILURES_PER_ADDRESS: RateLimitRule = {
  counterName: 'sign-in-failures-per-address',
  maximumRequests: 100,
  windowSeconds: 60 * 60,
  refuseWhenStoreUnavailable: true,
};

export const SIGN_IN_FAILURES_PER_ACCOUNT: RateLimitRule = {
  counterName: 'sign-in-failures-per-account',
  maximumRequests: 10,
  windowSeconds: 15 * 60,
  refuseWhenStoreUnavailable: true,
};

export const SIGN_IN_FAILURES_PER_TRUSTED_DEVICE: RateLimitRule = {
  counterName: 'sign-in-failures-per-trusted-device',
  maximumRequests: 10,
  windowSeconds: 15 * 60,
  refuseWhenStoreUnavailable: true,
};

/**
 * Keeps working when the store is down: a refresh token is 256 random bits, so there is nothing to
 * guess, and refusing would sign every station out within 15 minutes of a store outage.
 */
export const REFRESH_REQUESTS_PER_ADDRESS: RateLimitRule = {
  counterName: 'refresh-requests-per-address',
  maximumRequests: 30,
  windowSeconds: 60,
  refuseWhenStoreUnavailable: false,
};

export const PASSWORD_CHANGE_REQUESTS_PER_USER: RateLimitRule = {
  counterName: 'password-change-requests-per-user',
  maximumRequests: 5,
  windowSeconds: 15 * 60,
  refuseWhenStoreUnavailable: true,
};
