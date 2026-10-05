import { createHmac, hkdfSync } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';

/**
 * Separate keys for separate jobs, all derived (HKDF-SHA-256) from the one AUTHENTICATION_SECRET,
 * so a key used in one place can never be replayed in another.
 */
@Injectable()
export class DerivedKeys {
  readonly accessTokenSigningKey: Uint8Array;
  readonly trustedDeviceKey: Buffer;
  private readonly identifierHashingKey: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const secret = Buffer.from(config.AUTHENTICATION_SECRET, 'base64url');
    const derive = (purpose: string) => Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `lookup ${purpose} v1`, 32));
    this.accessTokenSigningKey = new Uint8Array(derive('access token signing'));
    this.trustedDeviceKey = derive('trusted device cookie');
    this.identifierHashingKey = derive('identifier hashing');
  }

  /**
   * A short, stable stand-in for an identifier (an email, a client address, a user id) in logs and
   * rate-limit keys. Keyed, so it can't be reversed by hashing guesses the way a plain SHA-256 of an
   * email could.
   */
  hashIdentifier(identifier: string): string {
    return createHmac('sha256', this.identifierHashingKey).update(identifier).digest('base64url').slice(0, 22);
  }
}
