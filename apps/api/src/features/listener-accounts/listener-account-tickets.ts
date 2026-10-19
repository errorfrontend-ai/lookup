import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { LISTENER_ACCOUNT_TICKET_LIFETIME_SECONDS } from '@lookup/contracts';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import { DerivedKeys } from '../../common/security/derived-keys.js';

const EXPIRY_BYTES = 8;
const MAC_BYTES = 32;

/**
 * The ticket a listener gets after a right code for an email with no account yet (ADR-005, LA-D6): proof, for 10
 * minutes, that this install proved this address, so the account can be created without asking for the code again and
 * without a half-made account in between. Nothing is stored: the ticket is the expiry time and an HMAC over the
 * install, the address's hash and that time, under its own derived key. Another install's ticket, another address's,
 * an expired or an altered one all fail the same way.
 */
@Injectable()
export class ListenerAccountTickets {
  constructor(
    private readonly derivedKeys: DerivedKeys,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  issue(listenerInstallId: string, emailHash: Buffer): string {
    const expiresAtSeconds = Math.floor(this.clock.now().getTime() / 1000) + LISTENER_ACCOUNT_TICKET_LIFETIME_SECONDS;
    const expiry = Buffer.alloc(EXPIRY_BYTES);
    expiry.writeBigUInt64BE(BigInt(expiresAtSeconds));
    return Buffer.concat([expiry, this.macOf(listenerInstallId, emailHash, expiry)]).toString('base64url');
  }

  isValid(ticket: string, listenerInstallId: string, emailHash: Buffer): boolean {
    const bytes = Buffer.from(ticket, 'base64url');
    if (bytes.length !== EXPIRY_BYTES + MAC_BYTES) return false;
    const expiry = bytes.subarray(0, EXPIRY_BYTES);
    const expected = this.macOf(listenerInstallId, emailHash, expiry);
    if (!timingSafeEqual(bytes.subarray(EXPIRY_BYTES), expected)) return false;
    return Number(expiry.readBigUInt64BE()) > Math.floor(this.clock.now().getTime() / 1000);
  }

  private macOf(listenerInstallId: string, emailHash: Buffer, expiry: Buffer): Buffer {
    return createHmac('sha256', this.derivedKeys.listenerAccountTicketKey)
      .update('listener-account-ticket\n')
      .update(listenerInstallId)
      .update('\n')
      .update(emailHash)
      .update('\n')
      .update(expiry)
      .digest();
  }
}
