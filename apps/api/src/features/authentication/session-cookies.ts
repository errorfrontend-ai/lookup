import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Response } from 'express';
import { ACCESS_TOKEN_LIFETIME_SECONDS } from './access-tokens.js';

/**
 * Session cookies. The __Host- prefix makes browsers insist on Secure, Path=/ and no Domain, so the
 * cookies can only ever go back to this exact host. HttpOnly keeps them away from scripts and
 * SameSite=Strict keeps other sites from sending them. Browsers accept Secure cookies on localhost,
 * so these settings are the same in development and production.
 */
export const ACCESS_TOKEN_COOKIE = '__Host-lookup-access-token';
export const REFRESH_TOKEN_COOKIE = '__Host-lookup-refresh-token';
export const TRUSTED_DEVICE_COOKIE = '__Host-lookup-trusted-device';

const TRUSTED_DEVICE_COOKIE_LIFETIME_MILLISECONDS = 365 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const SESSION_COOKIE_ATTRIBUTES: CookieOptions = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };

export function setSessionCookies(
  response: Response,
  session: { accessToken: string; refreshToken: string; refreshTokenExpiresAt: Date },
): void {
  response.cookie(ACCESS_TOKEN_COOKIE, session.accessToken, {
    ...SESSION_COOKIE_ATTRIBUTES,
    maxAge: ACCESS_TOKEN_LIFETIME_SECONDS * 1000,
  });
  response.cookie(REFRESH_TOKEN_COOKIE, session.refreshToken, {
    ...SESSION_COOKIE_ATTRIBUTES,
    maxAge: Math.max(0, session.refreshTokenExpiresAt.getTime() - Date.now()),
  });
}

export function clearSessionCookies(response: Response): void {
  response.clearCookie(ACCESS_TOKEN_COOKIE, SESSION_COOKIE_ATTRIBUTES);
  response.clearCookie(REFRESH_TOKEN_COOKIE, SESSION_COOKIE_ATTRIBUTES);
}

export function setTrustedDeviceCookie(response: Response, cookieValue: string): void {
  response.cookie(TRUSTED_DEVICE_COOKIE, cookieValue, {
    ...SESSION_COOKIE_ATTRIBUTES,
    maxAge: TRUSTED_DEVICE_COOKIE_LIFETIME_MILLISECONDS,
  });
}

/** A new refresh token: 256 random bits, sent to the browser as base64url. */
export function createRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The database keeps only the SHA-256 of a refresh token. */
export function hashRefreshToken(refreshToken: string): Buffer {
  return createHash('sha256').update(Buffer.from(refreshToken, 'base64url')).digest();
}

export function isRefreshTokenFormat(value: unknown): value is string {
  return typeof value === 'string' && REFRESH_TOKEN_PATTERN.test(value);
}
