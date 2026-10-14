import { describe, expect, it } from 'vitest';
import {
  computeTwoFactorCode,
  decodeBase32,
  encodeBase32,
  findTwoFactorTimeStep,
  twoFactorEnrolmentAddress,
  twoFactorTimeStepAt,
  TWO_FACTOR_SECRET_BYTES,
} from '../src/index.js';

/** RFC 6238 Appendix B's SHA-1 seed: the ASCII digits "12345678901234567890". */
const RFC_SECRET = new TextEncoder().encode('12345678901234567890');

describe('time-based codes (RFC 6238; P5A design §5.4)', () => {
  // RFC 6238 Appendix B, SHA-1: the 8-digit values' last six digits, which is what 6-digit codes are.
  it.each([
    [59, '287082'],
    [1_111_111_109, '081804'],
    [1_111_111_111, '050471'],
    [1_234_567_890, '005924'],
    [2_000_000_000, '279037'],
    [20_000_000_000, '353130'],
  ])('at %i seconds the code is %s, as RFC 6238 Appendix B gives', async (unixSeconds, code) => {
    expect(await computeTwoFactorCode(RFC_SECRET, twoFactorTimeStepAt(unixSeconds * 1000))).toBe(code);
  });

  it('a step lasts 30 seconds from the Unix epoch', () => {
    expect([twoFactorTimeStepAt(0), twoFactorTimeStepAt(29_999), twoFactorTimeStepAt(30_000), twoFactorTimeStepAt(59_000)]).toEqual([0, 0, 1, 1]);
  });

  it('a code counts for its own step and one either side, and names the step it belongs to', async () => {
    const now = 1_234_567_890_000;
    const step = twoFactorTimeStepAt(now);
    for (const drift of [-1, 0, 1]) {
      const code = await computeTwoFactorCode(RFC_SECRET, step + drift);
      expect(await findTwoFactorTimeStep(RFC_SECRET, code, now), `drift ${drift}`).toBe(step + drift);
    }
    for (const drift of [-2, 2]) {
      const code = await computeTwoFactorCode(RFC_SECRET, step + drift);
      expect(await findTwoFactorTimeStep(RFC_SECRET, code, now), `drift ${drift}`).toBeNull();
    }
  });

  it('anything but six digits is no code at all', async () => {
    for (const typed of ['', '12345', '1234567', '12345a', ' 005924', '00592４']) {
      expect(await findTwoFactorTimeStep(RFC_SECRET, typed, 1_234_567_890_000), JSON.stringify(typed)).toBeNull();
    }
  });

  it('another secret gives other codes', async () => {
    const other = new TextEncoder().encode('09876543210987654321');
    expect(await computeTwoFactorCode(other, twoFactorTimeStepAt(59_000))).not.toBe('287082');
  });

  // RFC 4648 §10's test vectors, without padding.
  it.each([
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('base32 of "%s" is %s, and back', (text, encoded) => {
    const bytes = new TextEncoder().encode(text);
    expect(encodeBase32(bytes)).toBe(encoded);
    expect(decodeBase32(encoded)).toEqual(bytes);
    expect(decodeBase32(`${encoded.toLowerCase()}====`)).toEqual(bytes);
  });

  it('a secret that is not base32 is refused', () => {
    for (const text of ['', 'MZXW1', 'MZ XW 0', '!!!']) expect(decodeBase32(text), text).toBeNull();
  });

  it('the enrolment address names Look Up and the account, and carries the secret an authenticator app reads', () => {
    const secret = new Uint8Array(TWO_FACTOR_SECRET_BYTES).fill(7);
    const address = twoFactorEnrolmentAddress('admin@example.com', secret);
    expect(address).toBe(
      `otpauth://totp/Look%20Up:admin%40example.com?secret=${encodeBase32(secret)}&issuer=Look%20Up&algorithm=SHA1&digits=6&period=30`,
    );
    expect(decodeBase32(new URL(address).searchParams.get('secret') ?? '')).toEqual(secret);
  });
});
