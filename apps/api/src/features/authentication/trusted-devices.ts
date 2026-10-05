import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DerivedKeys } from '../../common/security/derived-keys.js';

/**
 * OWASP's device-cookie pattern. After a successful sign-in the browser gets a signed cookie naming the
 * account. Wrong passwords from that browser count against that browser only, so someone hammering an
 * account from elsewhere can't lock its owner out of a browser they already use.
 */
@Injectable()
export class TrustedDevices {
  constructor(private readonly derivedKeys: DerivedKeys) {}

  createCookieValue(normalizedEmail: string): string {
    const deviceId = randomBytes(16).toString('base64url');
    return `${deviceId}.${this.sign(normalizedEmail, deviceId)}`;
  }

  /** The device id when the cookie was issued to a browser that signed in to this account; otherwise null. */
  findTrustedDeviceId(cookieValue: unknown, normalizedEmail: string): string | null {
    if (typeof cookieValue !== 'string') return null;
    const match = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(cookieValue);
    if (!match) return null;
    const [, deviceId, presentedSignature] = match as unknown as [string, string, string];
    const expectedSignature = Buffer.from(this.sign(normalizedEmail, deviceId), 'base64url');
    const presented = Buffer.from(presentedSignature, 'base64url');
    return presented.length === expectedSignature.length && timingSafeEqual(presented, expectedSignature) ? deviceId : null;
  }

  private sign(normalizedEmail: string, deviceId: string): string {
    return createHmac('sha256', this.derivedKeys.trustedDeviceKey).update(`${normalizedEmail}.${deviceId}`).digest('base64url');
  }
}
