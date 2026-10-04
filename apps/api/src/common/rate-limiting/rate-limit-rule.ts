/** How many requests one client may make to one counter within a time window. */
export interface RateLimitRule {
  /** Name of the counter, e.g. "sign-in". Each counter is counted separately. */
  counterName: string;
  maximumRequests: number;
  windowSeconds: number;
  /**
   * What to do when the counter store is unreachable: refuse the request (true) or allow it
   * (false, the default). Sign-in, one-time codes and similar routes refuse, because an attacker
   * could otherwise guess without limit during an outage. Everything else stays available.
   */
  refuseWhenStoreUnavailable?: boolean;
}
