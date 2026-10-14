import { HUMAN_CHECK_TEST_SECRET_KEYS, type AppConfig } from '../../config/app-config.js';
import { AppError } from '../errors/app-error.js';

/** The action the portal's sign-up widget names; a token solved for anything else is refused. */
export const STATION_SIGN_UP_ACTION = 'station-sign-up';
/** Cloudflare's dummy token, the only one its test secret keys pass. */
export const HUMAN_CHECK_DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const SITE_VERIFY_ADDRESS = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITE_VERIFY_TIMEOUT_MILLISECONDS = 5_000;
/** One attempt and up to two retries, all with one idempotency key, so a retry is never counted as a reuse. */
const SITE_VERIFY_ATTEMPTS = 3;

/** One solved check from the browser, and where it came from. */
export interface HumanCheckRequest {
  token: string;
  clientAddress: string;
  /** Unique to this check; Cloudflare answers a retry with the same key as it answered the first try. */
  idempotencyKey: string;
}

/** What the check found; a refusal says why for the log, in Cloudflare's error codes, never the token. */
export type HumanCheckVerdict =
  | { isPerson: true }
  | { isPerson: false; errorCodes: string[]; isHostnameExpected: boolean; isActionExpected: boolean };

/**
 * Whether the person at step 1 of sign-up is a person (P5A-D8). Throws HUMAN_CHECK_UNAVAILABLE when it cannot find
 * out, so an outage closes sign-up instead of opening it to bots (gap 4).
 */
export interface HumanCheck {
  check(request: HumanCheckRequest): Promise<HumanCheckVerdict>;
}

/** Dependency-injection token for the human check in use. */
export const HUMAN_CHECK = Symbol('HUMAN_CHECK');

type Fetch = (address: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

interface SiteVerifyAnswer {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  'error-codes'?: unknown;
}

/** Cloudflare Turnstile's server-side check: a token passes only when Cloudflare says so for the portal's own host and the sign-up action. */
export class CloudflareTurnstileVerifier implements HumanCheck {
  constructor(
    private readonly secretKey: string,
    private readonly expectedHostname: string,
    private readonly fetchAnswer: Fetch = globalThis.fetch as unknown as Fetch,
  ) {}

  async check(request: HumanCheckRequest): Promise<HumanCheckVerdict> {
    const body = JSON.stringify({
      secret: this.secretKey,
      response: request.token,
      remoteip: request.clientAddress,
      idempotency_key: request.idempotencyKey,
    });
    let lastProblem: unknown;
    for (let attempt = 1; attempt <= SITE_VERIFY_ATTEMPTS; attempt += 1) {
      try {
        const answer = await this.fetchAnswer(SITE_VERIFY_ADDRESS, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(SITE_VERIFY_TIMEOUT_MILLISECONDS),
        });
        if (answer.status >= 500) {
          lastProblem = new Error(`siteverify answered ${answer.status}`);
          continue;
        }
        const verdict = (await answer.json()) as SiteVerifyAnswer;
        const isHostnameExpected = verdict.hostname === this.expectedHostname;
        const isActionExpected = verdict.action === STATION_SIGN_UP_ACTION;
        if (answer.ok && verdict.success === true && isHostnameExpected && isActionExpected) return { isPerson: true };
        const errorCodes = Array.isArray(verdict['error-codes'])
          ? verdict['error-codes'].filter((code): code is string => typeof code === 'string' && /^[a-z-]{1,40}$/.test(code)).slice(0, 5)
          : [];
        return { isPerson: false, errorCodes, isHostnameExpected, isActionExpected };
      } catch (problem) {
        lastProblem = problem;
      }
    }
    throw new AppError('HUMAN_CHECK_UNAVAILABLE', { internalDetail: `siteverify unreachable after ${SITE_VERIFY_ATTEMPTS} attempts`, cause: lastProblem });
  }
}

/**
 * Development and tests only (production refuses the test keys): answers offline exactly as Cloudflare's published
 * test secret keys do. "1x…AA" passes only the dummy token, "2x…AA" always fails, "3x…AA" answers
 * "timeout-or-duplicate" (a refusal).
 */
export class TurnstileTestKeyVerifier implements HumanCheck {
  constructor(private readonly secretKey: (typeof HUMAN_CHECK_TEST_SECRET_KEYS)[number]) {}

  async check(request: HumanCheckRequest): Promise<HumanCheckVerdict> {
    if (this.secretKey === HUMAN_CHECK_TEST_SECRET_KEYS[0] && request.token === HUMAN_CHECK_DUMMY_TOKEN) return { isPerson: true };
    const errorCodes = this.secretKey === HUMAN_CHECK_TEST_SECRET_KEYS[2] ? ['timeout-or-duplicate'] : ['invalid-input-response'];
    return { isPerson: false, errorCodes, isHostnameExpected: true, isActionExpected: true };
  }
}

/** The human check the configuration asks for: Cloudflare for a real key, the offline stand-in for a test key. */
export function humanCheckFor(config: Pick<AppConfig, 'HUMAN_CHECK_SECRET_KEY' | 'PORTAL_PUBLIC_ORIGIN'>, fetchAnswer?: Fetch): HumanCheck {
  const testKey = HUMAN_CHECK_TEST_SECRET_KEYS.find((key) => key === config.HUMAN_CHECK_SECRET_KEY);
  if (testKey) return new TurnstileTestKeyVerifier(testKey);
  return new CloudflareTurnstileVerifier(config.HUMAN_CHECK_SECRET_KEY, new URL(config.PORTAL_PUBLIC_ORIGIN).hostname, fetchAnswer);
}
