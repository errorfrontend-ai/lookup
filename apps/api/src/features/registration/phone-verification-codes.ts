import { createHmac, randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  PHONE_CODE_ATTEMPT_LIMIT,
  PHONE_CODE_LIFETIME_SECONDS,
  PHONE_CODE_RESEND_COOLDOWN_SECONDS,
} from '@lookup/contracts';
import type { Redis } from 'ioredis';
import { AppError } from '../../common/errors/app-error.js';
import { DerivedKeys } from '../../common/security/derived-keys.js';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import { KEY_VALUE_STORE } from '../../infrastructure/key-value-store/key-value-store.module.js';

/** How long the key outlives the code, only so the store cleans it up. */
const KEY_LIFETIME_MILLISECONDS = (PHONE_CODE_LIFETIME_SECONDS + 60) * 1000;

/**
 * The two Lua scripts below are shared with the listener's email codes (features/listener-accounts), which work the
 * same way: 6 digits, a cooldown, a lifetime and a limit of wrong tries.
 *
 * Stores a new code unless one was sent less than the cooldown ago. Atomic, so two sends at once cannot both pass.
 * KEYS[1] the station's code; ARGV: the code's hash, now, the cooldown, the code's lifetime and the key's, all in ms.
 * Returns {"SENT", sentAt} or {"TOO_SOON", the ms until another may be sent}.
 */
export const ISSUE_CODE_SCRIPT = `local stored = redis.call('GET', KEYS[1])
local now = tonumber(ARGV[2])
if stored then
  local previous = cjson.decode(stored)
  local available = previous.sentAt + tonumber(ARGV[3])
  if now < available then return {'TOO_SOON', available - now} end
end
redis.call('SET', KEYS[1], cjson.encode({codeHash = ARGV[1], sentAt = now, expiresAt = now + tonumber(ARGV[4]), failedAttempts = 0}), 'PX', ARGV[5])
return {'SENT', now}`;

/**
 * Checks a typed code and counts it, atomically (P5A design §3.1). KEYS[1] the station's code; ARGV: the typed code's
 * hash, now, the attempt limit. Expired → EXPIRED; already at the limit → LOCKED; wrong → counted, LOCKED at the limit,
 * INCORRECT before it; right → deleted, CORRECT. No code at all is EXPIRED: the applicant sends a new one either way.
 */
export const CHECK_CODE_SCRIPT = `local stored = redis.call('GET', KEYS[1])
if not stored then return 'EXPIRED' end
local code = cjson.decode(stored)
if tonumber(ARGV[2]) >= code.expiresAt then return 'EXPIRED' end
if code.failedAttempts >= tonumber(ARGV[3]) then return 'LOCKED' end
if code.codeHash == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 'CORRECT'
end
code.failedAttempts = code.failedAttempts + 1
redis.call('SET', KEYS[1], cjson.encode(code), 'KEEPTTL')
if code.failedAttempts >= tonumber(ARGV[3]) then return 'LOCKED' end
return 'INCORRECT'`;

export type PhoneCodeCheck = 'CORRECT' | 'INCORRECT' | 'EXPIRED' | 'LOCKED';

/** Six random digits, leading zeros kept (P5A-VERIFICATION-02). */
export function newPhoneVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export interface IssuedPhoneCode {
  /** The six digits for the SMS; nowhere else. */
  code: string;
  sentAt: Date;
  expiresAt: Date;
  resendAvailableAt: Date;
}

/**
 * The SMS codes of sign-up step 2 (P5A design §3.1, P5A-VERIFICATION-01..05). A code is 6 random digits that last 10
 * minutes, at most one per 60 seconds, and 5 wrong tries lock it. Only an HMAC of the code and the phone it went to is
 * kept, keyed by a key derived from AUTHENTICATION_SECRET, so a copy of the store cannot be searched for codes offline
 * and a code works only for the number it was sent to. Times come from the injected clock, so tests can move them.
 */
@Injectable()
export class PhoneVerificationCodes {
  constructor(
    @Inject(KEY_VALUE_STORE) private readonly keyValueStore: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly derivedKeys: DerivedKeys,
  ) {}

  /** A new code for the station's phone; RESEND_TOO_SOON (with when to try) if one went out under a minute ago. */
  async issue(stationId: string, phoneNumberE164: string): Promise<IssuedPhoneCode> {
    const code = newPhoneVerificationCode();
    const now = this.clock.now().getTime();
    const [outcome, value] = (await this.runScript(ISSUE_CODE_SCRIPT, stationId, [
      this.hashOf(phoneNumberE164, code),
      now,
      PHONE_CODE_RESEND_COOLDOWN_SECONDS * 1000,
      PHONE_CODE_LIFETIME_SECONDS * 1000,
      KEY_LIFETIME_MILLISECONDS,
    ])) as [string, number];
    if (outcome === 'TOO_SOON') {
      throw new ResendTooSoon(Math.max(1, Math.ceil(value / 1000)));
    }
    return {
      code,
      sentAt: new Date(now),
      expiresAt: new Date(now + PHONE_CODE_LIFETIME_SECONDS * 1000),
      resendAvailableAt: new Date(now + PHONE_CODE_RESEND_COOLDOWN_SECONDS * 1000),
    };
  }

  /** Checks a typed code against the one sent to this phone, counting a wrong one. */
  async check(stationId: string, phoneNumberE164: string, typedCode: string): Promise<PhoneCodeCheck> {
    return (await this.runScript(CHECK_CODE_SCRIPT, stationId, [
      this.hashOf(phoneNumberE164, typedCode),
      this.clock.now().getTime(),
      PHONE_CODE_ATTEMPT_LIMIT,
    ])) as PhoneCodeCheck;
  }

  /** Forgets the station's code: its phone number changed, so the next code may go at once, and only to the new number. */
  async forget(stationId: string): Promise<void> {
    try {
      await this.keyValueStore.del(this.keyFor(stationId));
    } catch (problem) {
      throw new AppError('SERVICE_UNAVAILABLE', { internalDetail: 'phone code store unavailable', cause: problem });
    }
  }

  /** When the last code was sent and when another may be, for the application's page; nulls when none is waiting. */
  async describe(stationId: string): Promise<{ sentAt: Date | null; resendAvailableAt: Date | null }> {
    const stored = await this.keyValueStore.get(this.keyFor(stationId)).catch((problem: unknown) => {
      throw new AppError('SERVICE_UNAVAILABLE', { internalDetail: 'phone code store unavailable', cause: problem });
    });
    if (stored === null) return { sentAt: null, resendAvailableAt: null };
    const sentAt = Number((JSON.parse(stored) as { sentAt: unknown }).sentAt);
    return { sentAt: new Date(sentAt), resendAvailableAt: new Date(sentAt + PHONE_CODE_RESEND_COOLDOWN_SECONDS * 1000) };
  }

  private hashOf(phoneNumberE164: string, code: string): string {
    return createHmac('sha256', this.derivedKeys.oneTimeCodeKey).update(`${phoneNumberE164}\n${code}`).digest('base64url');
  }

  private keyFor(stationId: string): string {
    return `phone-verification-code:${stationId}`;
  }

  /** Runs a script; an unreachable store refuses (SERVICE_UNAVAILABLE): a code is never sent or accepted unchecked. */
  private async runScript(script: string, stationId: string, scriptArguments: Array<string | number>): Promise<unknown> {
    try {
      return await this.keyValueStore.eval(script, 1, this.keyFor(stationId), ...scriptArguments);
    } catch (problem) {
      throw new AppError('SERVICE_UNAVAILABLE', { internalDetail: 'phone code store unavailable', cause: problem });
    }
  }
}

/** RESEND_TOO_SOON, with the whole seconds to wait for the Retry-After header. */
export class ResendTooSoon extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super('RESEND_TOO_SOON', { internalDetail: `another code may be sent in ${retryAfterSeconds}s` });
  }
}
