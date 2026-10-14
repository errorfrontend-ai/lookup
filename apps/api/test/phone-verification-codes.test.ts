import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/common/errors/app-error.js';
import { DerivedKeys } from '../src/common/security/derived-keys.js';
import type { AppConfig } from '../src/config/app-config.js';
import { newPhoneVerificationCode, PhoneVerificationCodes, ResendTooSoon } from '../src/features/registration/phone-verification-codes.js';

/**
 * The SMS codes of sign-up step 2 (P5A design §3.1; P5A-VERIFICATION-01..05), against the real Valkey with a clock the
 * test moves: six digits, 10 minutes, one per 60 seconds, five wrong tries lock it, kept only as a keyed hash.
 */
describe('phone verification codes', () => {
  let keyValueStore: Redis;
  const clock = { time: Date.parse('2026-10-14T08:00:00.000Z'), now() { return new Date(this.time); } };
  const derivedKeys = new DerivedKeys({ AUTHENTICATION_SECRET: 'test-secret-for-phone-codes-0123456789-abcdefg' } as AppConfig);
  let codes: PhoneVerificationCodes;
  const stationIds: string[] = [];
  const newStation = () => {
    const stationId = randomUUID();
    stationIds.push(stationId);
    return stationId;
  };
  const phone = '+447700900201';

  beforeAll(() => {
    keyValueStore = new Redis(process.env.KEY_VALUE_STORE_URL as string, { maxRetriesPerRequest: 1 });
    codes = new PhoneVerificationCodes(keyValueStore, clock, derivedKeys);
  });
  afterAll(async () => {
    if (stationIds.length > 0) await keyValueStore.del(...stationIds.map((stationId) => `phone-verification-code:${stationId}`));
    await keyValueStore.quit();
  });

  it('P5A-VERIFICATION-02: over 10,000 codes every one is six digits, leading zeros kept, and they spread over the range', () => {
    const codes = Array.from({ length: 10_000 }, () => newPhoneVerificationCode());
    expect(codes.filter((code) => !/^[0-9]{6}$/.test(code))).toEqual([]);
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(9_900);
  });

  it('a code is six digits, lasts 10 minutes, and the store holds only a hash of it with the phone it went to', async () => {
    const stationId = newStation();
    const issued = await codes.issue(stationId, phone);
    expect(issued.code).toMatch(/^[0-9]{6}$/);
    expect(issued.expiresAt.getTime() - issued.sentAt.getTime()).toBe(10 * 60_000);
    expect(issued.resendAvailableAt.getTime() - issued.sentAt.getTime()).toBe(60_000);
    const stored = (await keyValueStore.get(`phone-verification-code:${stationId}`)) as string;
    expect(stored).not.toContain(issued.code);
    expect(stored).not.toContain(phone);
    expect(Object.keys(JSON.parse(stored)).sort()).toEqual(['codeHash', 'expiresAt', 'failedAttempts', 'sentAt']);
    expect(await keyValueStore.pttl(`phone-verification-code:${stationId}`)).toBeGreaterThan(10 * 60_000);
    expect(await codes.describe(stationId)).toEqual({ sentAt: issued.sentAt, resendAvailableAt: issued.resendAvailableAt });
  });

  it('the right code is accepted once; it works only for the phone it was sent to', async () => {
    const stationId = newStation();
    const { code } = await codes.issue(stationId, phone);
    expect(await codes.check(stationId, '+447700900202', code)).toBe('INCORRECT');
    expect(await codes.check(stationId, phone, code)).toBe('CORRECT');
    expect(await codes.check(stationId, phone, code)).toBe('EXPIRED');
    expect(await codes.describe(stationId)).toEqual({ sentAt: null, resendAvailableAt: null });
  });

  it('P5A-VERIFICATION-03: a code is refused once 10 minutes have passed', async () => {
    const stationId = newStation();
    const { code } = await codes.issue(stationId, phone);
    clock.time += 10 * 60_000 - 1;
    expect(await codes.check(stationId, phone, '000000' === code ? '000001' : '000000')).toBe('INCORRECT');
    clock.time += 1;
    expect(await codes.check(stationId, phone, code)).toBe('EXPIRED');
  });

  it('P5A-VERIFICATION-04: five wrong tries lock the code, even the right one after them', async () => {
    const stationId = newStation();
    const { code } = await codes.issue(stationId, phone);
    const wrong = code === '123456' ? '654321' : '123456';
    expect([
      await codes.check(stationId, phone, wrong),
      await codes.check(stationId, phone, wrong),
      await codes.check(stationId, phone, wrong),
      await codes.check(stationId, phone, wrong),
      await codes.check(stationId, phone, wrong),
    ]).toEqual(['INCORRECT', 'INCORRECT', 'INCORRECT', 'INCORRECT', 'LOCKED']);
    expect(await codes.check(stationId, phone, code)).toBe('LOCKED');
  });

  it('P5A-VERIFICATION-05: another code may be sent 60 seconds after the last, and the new one replaces it', async () => {
    const stationId = newStation();
    const first = await codes.issue(stationId, phone);
    clock.time += 59_000;
    const refusal = await codes.issue(stationId, phone).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ResendTooSoon);
    expect(refusal).toMatchObject({ code: 'RESEND_TOO_SOON', httpStatus: 429, retryAfterSeconds: 1 });
    clock.time += 1_000;
    const second = await codes.issue(stationId, phone);
    if (second.code !== first.code) expect(await codes.check(stationId, phone, first.code)).toBe('INCORRECT');
    expect(await codes.check(stationId, phone, second.code)).toBe('CORRECT');
  });

  it('two sends at the same moment send one code', async () => {
    const stationId = newStation();
    const outcomes = await Promise.allSettled([codes.issue(stationId, phone), codes.issue(stationId, phone)]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('an unreachable store refuses with SERVICE_UNAVAILABLE: no code goes out or is accepted unchecked', async () => {
    const brokenStore = new Redis('redis://127.0.0.1:1', { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
    const broken = new PhoneVerificationCodes(brokenStore, clock, derivedKeys);
    for (const attempt of [broken.issue(randomUUID(), phone), broken.check(randomUUID(), phone, '123456'), broken.describe(randomUUID())]) {
      const refusal = await attempt.catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(AppError);
      expect(refusal).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    }
    brokenStore.disconnect();
  });
});
