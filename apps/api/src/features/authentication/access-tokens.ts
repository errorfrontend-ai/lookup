import { Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { DerivedKeys } from '../../common/security/derived-keys.js';

export const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
const ISSUER = 'lookup-api';
const AUDIENCE = 'lookup-portal';

export interface AccessTokenClaims {
  portalUserId: string;
  portalSessionId: string;
}

/**
 * The 15-minute access token: an HS256 JWT that only POINTS to a session row (subject = user id,
 * `sid` = session id). It carries no email, role or station. Every request still checks the session
 * row, so signing out, changing the password or disabling a user takes effect at once.
 */
@Injectable()
export class AccessTokens {
  constructor(private readonly derivedKeys: DerivedKeys) {}

  issue(claims: AccessTokenClaims): Promise<string> {
    return new SignJWT({ sid: claims.portalSessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.portalUserId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_LIFETIME_SECONDS}s`)
      .sign(this.derivedKeys.accessTokenSigningKey);
  }

  /** The claims of a valid, unexpired token signed by us; null for anything else. */
  async verify(token: string): Promise<AccessTokenClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.derivedKeys.accessTokenSigningKey, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
        clockTolerance: 10,
      });
      const isUuid = (value: unknown): value is string =>
        typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
      return isUuid(payload.sub) && isUuid(payload.sid) ? { portalUserId: payload.sub, portalSessionId: payload.sid } : null;
    } catch {
      return null;
    }
  }
}
