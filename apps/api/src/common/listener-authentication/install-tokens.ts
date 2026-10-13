import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { INSTALL_TOKEN_LIFETIME_DAYS } from '@lookup/contracts';
import { jwtVerify, SignJWT } from 'jose';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';

const ISSUER = 'lookup-api';
const AUDIENCE = 'lookup-listener-app';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER_INSTALL_TOKEN = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/** The token of an `Authorization: Bearer <token>` header shaped like a JWT; null for anything else. */
export function readBearerInstallToken(authorizationHeader: string | undefined): string | null {
  return BEARER_INSTALL_TOKEN.exec(authorizationHeader ?? '')?.[1] ?? null;
}

/**
 * Listener app installs are anonymous: the app makes its own random id and the server keeps only a
 * keyed hash of it (LISTENER_INSTALL_ID_PEPPER), so the stored value cannot be matched to a phone by
 * hashing guesses. The install token is an HS256 JWT (LISTENER_INSTALL_TOKEN_SECRET, its own key,
 * never the portal's) that names the install's row by its id and nothing else.
 */
@Injectable()
export class InstallTokens {
  private readonly signingKey: Uint8Array;
  private readonly installIdPepper: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.signingKey = new Uint8Array(Buffer.from(config.LISTENER_INSTALL_TOKEN_SECRET, 'base64url'));
    this.installIdPepper = Buffer.from(config.LISTENER_INSTALL_ID_PEPPER, 'base64url');
  }

  hashInstallId(installId: string): Buffer {
    return createHmac('sha256', this.installIdPepper).update(installId.toLowerCase()).digest();
  }

  async issue(listenerInstallId: string, now = new Date()): Promise<{ installToken: string; expiresAt: Date }> {
    const expiresAt = new Date(now.getTime() + INSTALL_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
    const installToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(listenerInstallId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.signingKey);
    return { installToken, expiresAt };
  }

  /** The install's row id from a valid, unexpired token we signed; null for anything else. */
  async verify(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.signingKey, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE, clockTolerance: 10 });
      return typeof payload.sub === 'string' && UUID.test(payload.sub) ? payload.sub : null;
    } catch {
      return null;
    }
  }
}
