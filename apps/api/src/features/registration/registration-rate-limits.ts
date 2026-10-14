import type { RateLimitRule } from '../../common/rate-limiting/rate-limit-rule.js';

/**
 * Sign-up's limits (P5A design §3.4; P5A-VERIFICATION-07, -08). Each refuses while its counter store is down, so an
 * outage never allows unlimited sign-ups, codes or guesses. Where a limit is per account, station or phone, the
 * per-address limit applies as well.
 */
const HOUR = 60 * 60;
const DAY = 24 * HOUR;

export const APPLICANTS_PER_ADDRESS: RateLimitRule = { counterName: 'sign-up-applicants-per-address', maximumRequests: 5, windowSeconds: HOUR, refuseWhenStoreUnavailable: true };
/** Gap 5: one phone number starts at most three applications a day. */
export const APPLICANTS_PER_PHONE: RateLimitRule = { counterName: 'sign-up-applicants-per-phone', maximumRequests: 3, windowSeconds: DAY, refuseWhenStoreUnavailable: true };

export const PHONE_CODES_SENT_PER_ADDRESS: RateLimitRule = { counterName: 'sign-up-phone-codes-per-address', maximumRequests: 10, windowSeconds: HOUR, refuseWhenStoreUnavailable: true };
export const PHONE_CODES_SENT_PER_STATION: RateLimitRule = { counterName: 'sign-up-phone-codes-per-station', maximumRequests: 5, windowSeconds: HOUR, refuseWhenStoreUnavailable: true };

export const PHONE_CODE_CHECKS_PER_ADDRESS: RateLimitRule = { counterName: 'sign-up-phone-code-checks-per-address', maximumRequests: 30, windowSeconds: 15 * 60, refuseWhenStoreUnavailable: true };
export const PHONE_CODE_CHECKS_PER_STATION: RateLimitRule = { counterName: 'sign-up-phone-code-checks-per-station', maximumRequests: 10, windowSeconds: 15 * 60, refuseWhenStoreUnavailable: true };

export const EMAIL_LINKS_SENT_PER_ADDRESS: RateLimitRule = { counterName: 'sign-up-email-links-per-address', maximumRequests: 10, windowSeconds: HOUR, refuseWhenStoreUnavailable: true };
export const EMAIL_LINKS_SENT_PER_STATION: RateLimitRule = { counterName: 'sign-up-email-links-per-station', maximumRequests: 5, windowSeconds: HOUR, refuseWhenStoreUnavailable: true };
/** An email link's 60-second cooldown, counted like the phone code's. */
export const EMAIL_LINK_COOLDOWN_PER_STATION: RateLimitRule = { counterName: 'sign-up-email-link-cooldown-per-station', maximumRequests: 1, windowSeconds: 60, refuseWhenStoreUnavailable: true };

export const EMAIL_CONFIRMATIONS_PER_ADDRESS: RateLimitRule = { counterName: 'sign-up-email-confirmations-per-address', maximumRequests: 20, windowSeconds: 10 * 60, refuseWhenStoreUnavailable: true };

export const STATION_UPLOAD_ADDRESSES_PER_STATION: RateLimitRule = { counterName: 'station-upload-addresses-per-station', maximumRequests: 20, windowSeconds: HOUR, refuseWhenStoreUnavailable: true };
