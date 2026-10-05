import {
  type ChangePasswordInput,
  countPasswordCharacters,
  PASSWORD_MAXIMUM_LENGTH,
  type SignedInPortalUser,
  type SignInInput,
  type StationRole,
  type StationStatus,
} from '@lookup/contracts';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import type { DataSource } from 'typeorm';
import { AppError } from '../../common/errors/app-error.js';
import { RateLimiter } from '../../common/rate-limiting/rate-limiter.js';
import type { RateLimitRule } from '../../common/rate-limiting/rate-limit-rule.js';
import { DerivedKeys } from '../../common/security/derived-keys.js';
import { StationScopedTransaction } from '../../infrastructure/database/station-scoped-transaction.js';
import { AccessTokens } from './access-tokens.js';
import {
  PASSWORD_CHANGE_REQUESTS_PER_USER,
  SIGN_IN_FAILURES_PER_ACCOUNT,
  SIGN_IN_FAILURES_PER_ADDRESS,
  SIGN_IN_FAILURES_PER_TRUSTED_DEVICE,
} from './authentication-rate-limits.js';
import { PasswordHasher } from './password-hasher.js';
import { PasswordPolicy } from './password-policy.js';
import {
  clearSessionCookies,
  createRefreshToken,
  hashRefreshToken,
  isRefreshTokenFormat,
  setSessionCookies,
  setTrustedDeviceCookie,
} from './session-cookies.js';
import { TrustedDevices } from './trusted-devices.js';

interface SessionFunctionResult {
  outcome: string;
  portal_user_id: string | null;
  portal_session_id: string | null;
  refresh_token_expires_at: Date | null;
}

export interface RequestFacts {
  requestId: string;
  clientAddress: string;
}

@Injectable()
export class AuthenticationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly stationScopedTransaction: StationScopedTransaction,
    private readonly requestContext: ClsService,
    private readonly passwordHasher: PasswordHasher,
    private readonly passwordPolicy: PasswordPolicy,
    private readonly accessTokens: AccessTokens,
    private readonly trustedDevices: TrustedDevices,
    private readonly rateLimiter: RateLimiter,
    private readonly derivedKeys: DerivedKeys,
  ) {}

  /**
   * Every attempt that passes the limits costs the same: one argon2 computation and two database
   * calls, whether or not the email has an account. The answer for an unknown email, a wrong
   * password and a disabled account is identical.
   */
  async signIn(input: SignInInput, trustedDeviceCookie: unknown, request: RequestFacts, response: Response): Promise<SignedInPortalUser> {
    const normalizedEmail = normalizeEmail(input.email);
    const trustedDeviceId = this.trustedDevices.findTrustedDeviceId(trustedDeviceCookie, normalizedEmail);
    const accountFailureCounter: { rule: RateLimitRule; subject: string } = trustedDeviceId
      ? { rule: SIGN_IN_FAILURES_PER_TRUSTED_DEVICE, subject: `${normalizedEmail} ${trustedDeviceId}` }
      : { rule: SIGN_IN_FAILURES_PER_ACCOUNT, subject: normalizedEmail };
    await this.rateLimiter.throwIfFailureLimitReached(SIGN_IN_FAILURES_PER_ADDRESS, request.clientAddress, response);
    await this.rateLimiter.throwIfFailureLimitReached(accountFailureCounter.rule, accountFailureCounter.subject, response);

    // A password longer than the policy allows can't be right; it still costs one hash, like any other.
    const isWithinLengthLimit = countPasswordCharacters(input.password) <= PASSWORD_MAXIMUM_LENGTH;
    const storedSettings = isWithinLengthLimit ? await this.findPasswordHashSettings(normalizedEmail) : null;
    const computedHash = await this.passwordHasher.computeWithStoredSettings(input.password, storedSettings);
    // Only after the hashing parameters change: upgrade the stored hash once the password is proven.
    const replacementHash =
      storedSettings && this.passwordHasher.needsRehash(storedSettings) ? await this.passwordHasher.hashNewPassword(input.password) : null;

    const refreshToken = createRefreshToken();
    const [result] = (await this.dataSource.query('SELECT * FROM app.sign_in_portal_user($1, $2, $3, $4, $5)', [
      normalizedEmail,
      computedHash,
      hashRefreshToken(refreshToken),
      replacementHash,
      request.requestId,
    ])) as SessionFunctionResult[];

    if (result?.outcome !== 'SIGNED_IN' || !result.portal_user_id || !result.portal_session_id || !result.refresh_token_expires_at) {
      await this.rateLimiter.recordFailure(SIGN_IN_FAILURES_PER_ADDRESS, request.clientAddress);
      await this.rateLimiter.recordFailure(accountFailureCounter.rule, accountFailureCounter.subject);
      clearSessionCookies(response);
      // THROTTLED (the database backstop) is answered like a wrong password, so it never reveals that the account exists.
      throw new AppError('INVALID_CREDENTIALS', {
        internalDetail: `sign-in refused: ${result?.outcome ?? 'no result'} (account ${this.derivedKeys.hashIdentifier(normalizedEmail)})`,
      });
    }

    await this.rateLimiter.clearFailures(SIGN_IN_FAILURES_PER_ACCOUNT, normalizedEmail);
    if (trustedDeviceId) await this.rateLimiter.clearFailures(accountFailureCounter.rule, accountFailureCounter.subject);
    await this.startBrowserSession(response, result.portal_user_id, result.portal_session_id, refreshToken, result.refresh_token_expires_at);
    setTrustedDeviceCookie(response, this.trustedDevices.createCookieValue(normalizedEmail));
    return this.describeSignedInUser(result.portal_user_id);
  }

  /** Rotates the refresh token. A token that was already used ends the whole session (the function decides). */
  async refresh(refreshTokenCookie: unknown, request: RequestFacts, response: Response): Promise<void> {
    if (!isRefreshTokenFormat(refreshTokenCookie)) {
      clearSessionCookies(response);
      throw new AppError('UNAUTHENTICATED', { internalDetail: 'refresh without a well-formed refresh token' });
    }
    const newRefreshToken = createRefreshToken();
    const [result] = (await this.dataSource.query('SELECT * FROM app.rotate_portal_refresh_token($1, $2, $3)', [
      hashRefreshToken(refreshTokenCookie),
      hashRefreshToken(newRefreshToken),
      request.requestId,
    ])) as SessionFunctionResult[];
    if (result?.outcome !== 'ROTATED' || !result.portal_user_id || !result.portal_session_id || !result.refresh_token_expires_at) {
      clearSessionCookies(response);
      throw new AppError('UNAUTHENTICATED', { internalDetail: `refresh refused: ${result?.outcome ?? 'no result'}` });
    }
    await this.startBrowserSession(response, result.portal_user_id, result.portal_session_id, newRefreshToken, result.refresh_token_expires_at);
  }

  /** Ends the session named by a valid access token or by the refresh token, whichever is present. Safe to repeat. */
  async signOut(accessTokenCookie: unknown, refreshTokenCookie: unknown, request: RequestFacts, response: Response): Promise<void> {
    const claims = typeof accessTokenCookie === 'string' ? await this.accessTokens.verify(accessTokenCookie) : null;
    const refreshTokenHash = isRefreshTokenFormat(refreshTokenCookie) ? hashRefreshToken(refreshTokenCookie) : null;
    if (claims || refreshTokenHash) {
      await this.dataSource.query('SELECT app.end_portal_session($1, $2, $3)', [
        claims?.portalSessionId ?? null,
        refreshTokenHash,
        request.requestId,
      ]);
    }
    clearSessionCookies(response);
  }

  async changePassword(input: ChangePasswordInput, request: RequestFacts, response: Response): Promise<void> {
    const portalUserId = this.requestContext.get<string>('userId');
    const portalSessionId = this.requestContext.get<string>('sessionId');
    await this.rateLimiter.countRequest(PASSWORD_CHANGE_REQUESTS_PER_USER, portalUserId, response);

    const signedInUser = await this.describeSignedInUser(portalUserId);
    const refusalReason = this.passwordPolicy.check(input.newPassword, {
      fullName: signedInUser.user.fullName,
      email: signedInUser.user.email,
      stationNames: signedInUser.stations.map((station) => station.name),
    });
    if (refusalReason) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'newPassword', code: refusalReason }],
        internalDetail: `new password refused: ${refusalReason}`,
      });
    }

    const storedSettings = await this.findPasswordHashSettings(normalizeEmail(signedInUser.user.email));
    const computedCurrentHash = await this.passwordHasher.computeWithStoredSettings(input.currentPassword, storedSettings);
    const newPasswordHash = await this.passwordHasher.hashNewPassword(input.newPassword);
    const newRefreshToken = createRefreshToken();
    const [result] = (await this.dataSource.query('SELECT * FROM app.change_portal_user_password($1, $2, $3, $4, $5)', [
      portalSessionId,
      computedCurrentHash,
      newPasswordHash,
      hashRefreshToken(newRefreshToken),
      request.requestId,
    ])) as SessionFunctionResult[];

    switch (result?.outcome) {
      case 'PASSWORD_CHANGED':
        await this.startBrowserSession(
          response,
          result.portal_user_id as string,
          result.portal_session_id as string,
          newRefreshToken,
          result.refresh_token_expires_at as Date,
        );
        return;
      case 'INVALID_CREDENTIALS':
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'currentPassword', code: 'incorrect' }],
          internalDetail: 'password change refused: current password incorrect',
        });
      case 'THROTTLED':
        throw new AppError('RATE_LIMITED', { internalDetail: 'password change refused: failure backstop' });
      default:
        clearSessionCookies(response);
        throw new AppError('UNAUTHENTICATED', { internalDetail: `password change refused: ${result?.outcome ?? 'no result'}` });
    }
  }

  /** The signed-in person and the stations they belong to, read through row-level security as that user. */
  describeSignedInUser(portalUserId: string): Promise<SignedInPortalUser> {
    return this.stationScopedTransaction.run(
      async (database) => {
        const [user] = (await database.query(
          'SELECT id, full_name, email FROM app.portal_users WHERE id = app.current_user_id()',
        )) as Array<{ id: string; full_name: string; email: string }>;
        if (!user) throw new AppError('UNAUTHENTICATED', { internalDetail: 'signed-in user not visible' });
        const stations = (await database.query(
          `SELECT stations.id, stations.name, stations.frequency_label, stations.status, memberships.role
             FROM app.station_memberships AS memberships
             JOIN app.stations AS stations ON stations.id = memberships.station_id
            WHERE memberships.portal_user_id = app.current_user_id()
            ORDER BY stations.name`,
        )) as Array<{ id: string; name: string; frequency_label: string; status: StationStatus; role: StationRole }>;
        return {
          user: { id: user.id, fullName: user.full_name, email: user.email },
          stations: stations.map((station) => ({
            id: station.id,
            name: station.name,
            frequencyLabel: station.frequency_label,
            status: station.status,
            role: station.role,
          })),
        };
      },
      { userId: portalUserId, stationId: '' },
    );
  }

  private async findPasswordHashSettings(normalizedEmail: string): Promise<string | null> {
    const [row] = (await this.dataSource.query('SELECT app.find_password_hash_settings($1) AS settings', [normalizedEmail])) as Array<{
      settings: string | null;
    }>;
    return row?.settings ?? null;
  }

  private async startBrowserSession(
    response: Response,
    portalUserId: string,
    portalSessionId: string,
    refreshToken: string,
    refreshTokenExpiresAt: Date,
  ): Promise<void> {
    const accessToken = await this.accessTokens.issue({ portalUserId, portalSessionId });
    setSessionCookies(response, { accessToken, refreshToken, refreshTokenExpiresAt: new Date(refreshTokenExpiresAt) });
  }
}

/** One spelling per mailbox for counters and lookups: NFC, trimmed, lower case. */
export function normalizeEmail(email: string): string {
  return email.normalize('NFC').trim().toLowerCase();
}
