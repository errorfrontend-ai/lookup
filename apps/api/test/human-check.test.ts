import { describe, expect, it } from 'vitest';
import { AppError } from '../src/common/errors/app-error.js';
import {
  CloudflareTurnstileVerifier,
  HUMAN_CHECK_DUMMY_TOKEN,
  humanCheckFor,
  STATION_SIGN_UP_ACTION,
  TurnstileTestKeyVerifier,
} from '../src/common/security/human-check.js';

/**
 * The human check at sign-up step 1 (P5A design §3.1, P5A-D8, P5A-SIGNUP-08, gap 4), with a fake network in place of
 * Cloudflare: a pass needs Cloudflare's yes for the portal's own host and the sign-up action; an unreachable Cloudflare
 * is tried three times with one idempotency key, then refuses (fail closed).
 */
type Sent = { address: string; body: Record<string, unknown>; timeoutSignal: AbortSignal };

function fakeNetwork(answers: Array<{ status: number; json?: unknown } | Error>) {
  const sent: Sent[] = [];
  const fetchAnswer = async (address: string, init: { body: string; signal: AbortSignal }) => {
    sent.push({ address, body: JSON.parse(init.body) as Record<string, unknown>, timeoutSignal: init.signal });
    const next = answers.shift();
    if (next === undefined) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.json };
  };
  return { sent, fetchAnswer };
}

const request = { token: 'a-solved-token', clientAddress: '203.0.113.7', idempotencyKey: '0192a6c4-2222-4000-8000-000000000001' };
const passed = { success: true, hostname: 'portal.example.com', action: STATION_SIGN_UP_ACTION };

describe('the Cloudflare Turnstile check', () => {
  it('passes a token Cloudflare accepts for the portal\'s host and the sign-up action, sending the secret, the token, the address and the key', async () => {
    const network = fakeNetwork([{ status: 200, json: passed }]);
    const verifier = new CloudflareTurnstileVerifier('0x4AAAAAAAsecret', 'portal.example.com', network.fetchAnswer as never);
    expect(await verifier.check(request)).toEqual({ isPerson: true });
    expect(network.sent).toHaveLength(1);
    expect(network.sent[0]).toMatchObject({
      address: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      body: { secret: '0x4AAAAAAAsecret', response: 'a-solved-token', remoteip: '203.0.113.7', idempotency_key: request.idempotencyKey },
    });
    expect(network.sent[0]?.timeoutSignal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['Cloudflare says no', { success: false, 'error-codes': ['invalid-input-response'] }, ['invalid-input-response'], false, false],
    ['another host', { ...passed, hostname: 'elsewhere.example.com' }, [], false, true],
    ['another action', { ...passed, action: 'sign-in' }, [], true, false],
    ['no action at all', { success: true, hostname: 'portal.example.com' }, [], true, false],
  ] as const)('refuses a token when %s, saying why in error codes only', async (_case, answer, errorCodes, isHostnameExpected, isActionExpected) => {
    const network = fakeNetwork([{ status: 200, json: answer }]);
    const verifier = new CloudflareTurnstileVerifier('0x4AAAAAAAsecret', 'portal.example.com', network.fetchAnswer as never);
    expect(await verifier.check(request)).toEqual({ isPerson: false, errorCodes, isHostnameExpected, isActionExpected });
  });

  it('keeps only short error codes from Cloudflare\'s answer', async () => {
    const network = fakeNetwork([{ status: 200, json: { success: false, 'error-codes': ['timeout-or-duplicate', 42, 'x'.repeat(80), 'a', 'b', 'c', 'd', 'e'] } }]);
    const verifier = new CloudflareTurnstileVerifier('0x4AAAAAAAsecret', 'portal.example.com', network.fetchAnswer as never);
    expect(await verifier.check(request)).toMatchObject({ isPerson: false, errorCodes: ['timeout-or-duplicate', 'a', 'b', 'c', 'd'] });
  });

  it('tries again after a network failure or a 5xx, with the same idempotency key, then answers', async () => {
    const network = fakeNetwork([new Error('connection reset'), { status: 502 }, { status: 200, json: passed }]);
    const verifier = new CloudflareTurnstileVerifier('0x4AAAAAAAsecret', 'portal.example.com', network.fetchAnswer as never);
    expect(await verifier.check(request)).toEqual({ isPerson: true });
    expect(network.sent.map((sent) => sent.body.idempotency_key)).toEqual([request.idempotencyKey, request.idempotencyKey, request.idempotencyKey]);
  });

  it('gap 4: a Cloudflare it cannot reach after three tries refuses with HUMAN_CHECK_UNAVAILABLE, never a pass', async () => {
    const network = fakeNetwork([new Error('timeout'), new Error('timeout'), { status: 503 }]);
    const verifier = new CloudflareTurnstileVerifier('0x4AAAAAAAsecret', 'portal.example.com', network.fetchAnswer as never);
    const refusal = await verifier.check(request).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal).toMatchObject({ code: 'HUMAN_CHECK_UNAVAILABLE', httpStatus: 503 });
    expect(network.sent).toHaveLength(3);
  });
});

describe('the offline stand-in for Cloudflare\'s test keys (development and tests only)', () => {
  it('"1x…AA" passes only the dummy token; "2x…AA" always fails; "3x…AA" answers timeout-or-duplicate', async () => {
    const pass = new TurnstileTestKeyVerifier('1x0000000000000000000000000000000AA');
    expect(await pass.check({ ...request, token: HUMAN_CHECK_DUMMY_TOKEN })).toEqual({ isPerson: true });
    expect(await pass.check(request)).toMatchObject({ isPerson: false, errorCodes: ['invalid-input-response'] });
    const fail = new TurnstileTestKeyVerifier('2x0000000000000000000000000000000AA');
    expect(await fail.check({ ...request, token: HUMAN_CHECK_DUMMY_TOKEN })).toMatchObject({ isPerson: false });
    const used = new TurnstileTestKeyVerifier('3x0000000000000000000000000000000AA');
    expect(await used.check({ ...request, token: HUMAN_CHECK_DUMMY_TOKEN })).toMatchObject({ isPerson: false, errorCodes: ['timeout-or-duplicate'] });
  });

  it('the configuration picks the stand-in for a test key and Cloudflare for any other key, checking the portal\'s host', async () => {
    expect(humanCheckFor({ HUMAN_CHECK_SECRET_KEY: '1x0000000000000000000000000000000AA', PORTAL_PUBLIC_ORIGIN: 'http://localhost:5180' })).toBeInstanceOf(
      TurnstileTestKeyVerifier,
    );
    const network = fakeNetwork([{ status: 200, json: { ...passed, hostname: 'portal.example.com' } }]);
    const real = humanCheckFor({ HUMAN_CHECK_SECRET_KEY: '0x4AAAAAAAsecret', PORTAL_PUBLIC_ORIGIN: 'https://portal.example.com' }, network.fetchAnswer as never);
    expect(real).toBeInstanceOf(CloudflareTurnstileVerifier);
    expect(await real.check(request)).toEqual({ isPerson: true });
  });
});
