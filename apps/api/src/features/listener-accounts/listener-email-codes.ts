import { createHmac, randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  LISTENER_EMAIL_CODE_ATTEMPT_LIMIT,
  LISTENER_EMAIL_CODE_LIFETIME_SECONDS,
  LISTENER_EMAIL_CODE_RESEND_COOLDOWN_SECONDS,
} from '@lookup/contracts';
import type { Redis } from 'ioredis';
import { AppError } from '../../common/errors/app-error.js';
import { DerivedKeys } from '../../common/security/derived-keys.js';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import { KEY_VALUE_STORE } from '../../infrastructure/key-value-store/key-value-store.module.js';
import { CHECK_CODE_SCRIPT, ISSUE_CODE_SCRIPT, ResendTooSoon } from '../registration/phone-verification-codes.js';

/** How long the key outlives the code, only so the store cleans it up. */
const KEY_LIFETIME_MILLISECONDS = (LISTENER_EMAIL_CODE_LIFETIME_SECONDS + 60) * 1000;

export type ListenerEmailCodeCheck = 'CORRECT' | 'INCORRECT' | 'EXPIRED' | 'LOCKED';

export interface IssuedListenerEmailCode {
  /** The six digits for the email; nowhere else. */
  code: string;
  resendAvailableAt: Date;
}

/** Six random digits, leading zeros kept. */
export function newListenerEmailCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * The codes emailed to listeners (ADR-005, LA-ACCOUNT-02): 6 random digits that last 10 minutes, at most one a minute
 * per address, and 5 wrong tries lock the code. Only an HMAC of the code and the address it went to is kept, in the
 * key-value store under a key made from the address's hash, so a copy of the store holds neither addresses nor
 * codes, and a code works only for the address it was sent to. The scripts are the station sign-up's own
 * (`phone-verification-codes.ts`), so both kinds of code behave alike. Times come from the injected clock.
 */
@Injectable()
export class ListenerEmailCodes {
  constructor(
    @Inject(KEY_VALUE_STORE) private readonly keyValueStore: Redis,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly derivedKeys: DerivedKeys,
  ) {}

  /** A new code for the address; RESEND_TOO_SOON (with when to try) if one went out under a minute ago. */
  async issue(email: string, emailHash: Buffer): Promise<IssuedListenerEmailCode> {
    const code = newListenerEmailCode();
    const now = this.clock.now().getTime();
    const [outcome, value] = (await this.runScript(ISSUE_CODE_SCRIPT, emailHash, [
      this.hashOf(email, code),
      now,
      LISTENER_EMAIL_CODE_RESEND_COOLDOWN_SECONDS * 1000,
      LISTENER_EMAIL_CODE_LIFETIME_SECONDS * 1000,
      KEY_LIFETIME_MILLISECONDS,
    ])) as [string, number];
    if (outcome === 'TOO_SOON') throw new ResendTooSoon(Math.max(1, Math.ceil(value / 1000)));
    return { code, resendAvailableAt: new Date(now + LISTENER_EMAIL_CODE_RESEND_COOLDOWN_SECONDS * 1000) };
  }

  /** Checks a typed code against the one sent to this address, counting a wrong one. */
  async check(email: string, emailHash: Buffer, typedCode: string): Promise<ListenerEmailCodeCheck> {
    return (await this.runScript(CHECK_CODE_SCRIPT, emailHash, [
      this.hashOf(email, typedCode),
      this.clock.now().getTime(),
      LISTENER_EMAIL_CODE_ATTEMPT_LIMIT,
    ])) as ListenerEmailCodeCheck;
  }

  private hashOf(email: string, code: string): string {
    return createHmac('sha256', this.derivedKeys.oneTimeCodeKey).update(`listener-email-code\n${email}\n${code}`).digest('base64url');
  }

  /** Runs a script; an unreachable store refuses (SERVICE_UNAVAILABLE): a code is never sent or accepted unchecked. */
  private async runScript(script: string, emailHash: Buffer, scriptArguments: Array<string | number>): Promise<unknown> {
    try {
      return await this.keyValueStore.eval(script, 1, `listener-email-code:${emailHash.toString('base64url')}`, ...scriptArguments);
    } catch (problem) {
      throw new AppError('SERVICE_UNAVAILABLE', { internalDetail: 'listener email code store unavailable', cause: problem });
    }
  }
}
