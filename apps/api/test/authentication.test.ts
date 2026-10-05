import { randomInt, randomUUID } from 'node:crypto';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { PasswordPolicy } from '../src/features/authentication/password-policy.js';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  TRUSTED_DEVICE_COOKIE,
} from '../src/features/authentication/session-cookies.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertNoInternalDetails } from './support/internal-detail-patterns.js';
import { waitForLogWrites } from './support/log-capture.js';
import {
  cookieHeader,
  cookiesSetBy,
  PORTAL_ORIGIN,
  type PortalTestUser,
  PortalTestUsers,
  setCookieLine,
} from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/** A fresh client address per test, so each test has its own per-address counters. */
const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

describe('portal sign-in and sessions', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  const client = () => supertest(testApplication.application.getHttpServer());

  beforeAll(async () => {
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
  });
  afterAll(async () => {
    await testUsers.cleanUp();
    await setupClient.end();
    await testApplication.close();
  });

  const signIn = (email: string, password: string, options: { clientAddress?: string; cookies?: Record<string, string> } = {}) =>
    client()
      .post('/api/v1/auth/sign-in')
      .set('Origin', PORTAL_ORIGIN)
      .set('X-Forwarded-For', options.clientAddress ?? newClientAddress())
      .set('Cookie', cookieHeader(options.cookies ?? {}))
      .send({ email, password });

  const refresh = (cookies: Record<string, string>) =>
    client().post('/api/v1/auth/refresh').set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookieHeader(cookies));

  const me = (cookies: Record<string, string>) =>
    client().get('/api/v1/auth/me').set('X-Forwarded-For', newClientAddress()).set('Cookie', cookieHeader(cookies));

  async function signedInCookies(user: PortalTestUser): Promise<Record<string, string>> {
    const response = await signIn(user.email, user.password).expect(200);
    return cookiesSetBy(response);
  }

  describe('signing in', () => {
    it('sets session cookies with exactly the safe attributes and returns the user and stations, never a token', async () => {
      const user = await testUsers.create();
      const response = await signIn(user.email.toUpperCase(), user.password).expect(200);

      for (const cookieName of [ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, TRUSTED_DEVICE_COOKIE]) {
        const line = setCookieLine(response, cookieName) as string;
        expect(line, cookieName).toBeDefined();
        expect(line).toMatch(/; Path=\/(;|$)/);
        expect(line).toMatch(/; HttpOnly(;|$)/);
        expect(line).toMatch(/; Secure(;|$)/);
        expect(line).toMatch(/; SameSite=Strict(;|$)/);
        expect(line).not.toMatch(/Domain=/i);
      }
      expect(setCookieLine(response, ACCESS_TOKEN_COOKIE)).toMatch(/; Max-Age=900;/);
      const refreshMaximumAge = Number(/Max-Age=(\d+)/.exec(setCookieLine(response, REFRESH_TOKEN_COOKIE) as string)?.[1]);
      expect(refreshMaximumAge).toBeGreaterThan(604_700);
      expect(refreshMaximumAge).toBeLessThanOrEqual(604_800);

      expect(response.body).toEqual({
        user: { id: user.userId, fullName: 'Pat Tester', email: user.email },
        stations: [{ id: user.stationId, name: expect.any(String), frequencyLabel: '98.1 FM', status: 'ACTIVE', role: 'OWNER' }],
      });
      const cookies = cookiesSetBy(response);
      const bodyText = JSON.stringify(response.body);
      for (const cookieValue of Object.values(cookies)) expect(bodyText).not.toContain(cookieValue);
    });

    it('stores passwords as argon2id with 19 MiB, 2 passes and 1 lane', async () => {
      const user = await testUsers.create();
      const stored = (await setupClient.query('SELECT password_hash FROM app.portal_users WHERE id = $1', [user.userId])).rows[0];
      expect(stored.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    });

    it('answers an unknown email, a wrong password and a disabled account identically, each for exactly one password hash', async () => {
      const passwordHasher = testApplication.application.get(PasswordHasher);
      const computeSpy = vi.spyOn(passwordHasher, 'computeWithStoredSettings');
      const newHashSpy = vi.spyOn(passwordHasher, 'hashNewPassword');
      const realUser = await testUsers.create();
      const disabledUser = await testUsers.create();
      await setupClient.query(`UPDATE app.portal_users SET status = 'DISABLED' WHERE id = $1`, [disabledUser.userId]);
      computeSpy.mockClear();
      newHashSpy.mockClear();

      const attempts = [
        await signIn(`nobody-${randomUUID()}@example.test`, 'some password that is long enough'),
        await signIn(realUser.email, 'not the right password at all'),
        await signIn(disabledUser.email, disabledUser.password),
      ];
      expect(computeSpy).toHaveBeenCalledTimes(3);
      expect(newHashSpy).not.toHaveBeenCalled();
      for (const attempt of attempts) {
        expect(attempt.status).toBe(401);
        expect({ ...attempt.body.error, request_id: undefined }).toEqual({
          code: 'INVALID_CREDENTIALS',
          message: 'The email or password is not correct.',
          request_id: undefined,
        });
        expect(cookiesSetBy(attempt)).toEqual({ [ACCESS_TOKEN_COOKIE]: '', [REFRESH_TOKEN_COOKIE]: '' });
        assertNoInternalDetails(attempt.body);
      }
      computeSpy.mockRestore();
      newHashSpy.mockRestore();
    });

    it('refuses a password longer than 128 characters like any wrong password', async () => {
      const user = await testUsers.create();
      const response = await signIn(user.email, 'x'.repeat(129));
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('never puts the password or the email in a response or in the logs', async () => {
      const user = await testUsers.create();
      const wrongPassword = `wrong password ${randomUUID()}`;
      const response = await signIn(user.email, wrongPassword);
      await waitForLogWrites();
      const everything = JSON.stringify(testApplication.logs.lines) + JSON.stringify(response.body);
      expect(everything).not.toContain(wrongPassword);
      expect(everything).not.toContain(user.email);
      const logLine = testApplication.logs.find((line) => line.requestId === response.body.error.request_id);
      expect(logLine?.detail).toMatch(/sign-in refused: INVALID_CREDENTIALS \(account [A-Za-z0-9_-]{22}\)/);
    });
  });

  describe('limits on guessing', () => {
    it('after 10 wrong passwords an account is refused with 429, and an unknown email behaves the same', async () => {
      const user = await testUsers.create();
      const unknownEmail = `nobody-${randomUUID()}@example.test`;
      for (const email of [user.email, unknownEmail]) {
        for (let attempt = 0; attempt < 10; attempt++) expect((await signIn(email, 'wrong password, long enough')).status).toBe(401);
      }
      const realAccount = await signIn(user.email, user.password);
      const unknownAccount = await signIn(unknownEmail, 'wrong password, long enough');
      for (const refused of [realAccount, unknownAccount]) {
        expect(refused.status).toBe(429);
        expect(refused.body.error.code).toBe('RATE_LIMITED');
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      }
    });

    it("someone else's failures do not lock the owner out of a browser they already signed in from", async () => {
      const user = await testUsers.create();
      const ownersCookies = await signedInCookies(user);
      for (let attempt = 0; attempt < 10; attempt++) await signIn(user.email, 'attacker guessing a password');
      expect((await signIn(user.email, user.password)).status).toBe(429);
      const fromTrustedBrowser = await signIn(user.email, user.password, {
        cookies: { [TRUSTED_DEVICE_COOKIE]: ownersCookies[TRUSTED_DEVICE_COOKIE] as string },
      });
      expect(fromTrustedBrowser.status).toBe(200);
    });

    it('limits sign-in requests to 20 a minute per client address', async () => {
      const clientAddress = newClientAddress();
      for (let attempt = 0; attempt < 20; attempt++) {
        expect((await signIn(`nobody-${randomUUID()}@example.test`, 'wrong password, long enough', { clientAddress })).status).toBe(401);
      }
      const refused = await signIn(`nobody-${randomUUID()}@example.test`, 'wrong password, long enough', { clientAddress });
      expect(refused.status).toBe(429);
    });
  });

  describe('sessions', () => {
    it('the access cookie opens /auth/me; without it the answer is a plain 401', async () => {
      const user = await testUsers.create();
      const cookies = await signedInCookies(user);
      expect((await me(cookies).expect(200)).body.user.id).toBe(user.userId);
      const refused = await me({}).expect(401);
      expect(refused.body.error.code).toBe('UNAUTHENTICATED');
      assertNoInternalDetails(refused.body);
    });

    it('refresh replaces both cookies, and the new ones work', async () => {
      const user = await testUsers.create();
      const cookies = await signedInCookies(user);
      const refreshed = await refresh(cookies).expect(204);
      const newCookies = cookiesSetBy(refreshed);
      expect(newCookies[REFRESH_TOKEN_COOKIE]).not.toBe(cookies[REFRESH_TOKEN_COOKIE]);
      expect(newCookies[ACCESS_TOKEN_COOKIE]).toBeTruthy();
      await me(newCookies).expect(200);
    });

    it('a refresh token used again after its grace (three extra uses) ends the session: every cookie stops working', async () => {
      const user = await testUsers.create();
      const cookies = await signedInCookies(user);
      let latestCookies = cookies;
      for (let use = 0; use < 3; use++) latestCookies = cookiesSetBy(await refresh(cookies).expect(204));
      const reused = await refresh(cookies).expect(401);
      expect(cookiesSetBy(reused)).toEqual({ [ACCESS_TOKEN_COOKIE]: '', [REFRESH_TOKEN_COOKIE]: '' });
      await refresh(latestCookies).expect(401);
      await me(latestCookies).expect(401);
    });

    it('signing out ends the session at once: the same access cookie is refused on the next request', async () => {
      const user = await testUsers.create();
      const cookies = await signedInCookies(user);
      await me(cookies).expect(200);
      const signedOut = await client()
        .post('/api/v1/auth/sign-out')
        .set('Origin', PORTAL_ORIGIN)
        .set('Cookie', cookieHeader(cookies))
        .expect(204);
      expect(cookiesSetBy(signedOut)).toEqual({ [ACCESS_TOKEN_COOKIE]: '', [REFRESH_TOKEN_COOKIE]: '' });
      await me(cookies).expect(401);
      await refresh(cookies).expect(401);
    });

    it('disabling a user ends their access at once', async () => {
      const user = await testUsers.create();
      const cookies = await signedInCookies(user);
      await setupClient.query(`UPDATE app.portal_users SET status = 'DISABLED' WHERE id = $1`, [user.userId]);
      await me(cookies).expect(401);
    });
  });

  describe('changing the password', () => {
    const changePassword = (cookies: Record<string, string>, currentPassword: string, newPassword: string) =>
      client()
        .post('/api/v1/auth/change-password')
        .set('Origin', PORTAL_ORIGIN)
        .set('X-Forwarded-For', newClientAddress())
        .set('Cookie', cookieHeader(cookies))
        .send({ currentPassword, newPassword });

    it('names the problem: a wrong current password, or a new password that breaks the policy', async () => {
      const user = await testUsers.create();
      const cookies = await signedInCookies(user);
      const wrongCurrent = await changePassword(cookies, 'not my current password', 'a brand new long password 8314');
      expect(wrongCurrent.status).toBe(400);
      expect(wrongCurrent.body.error.fields).toEqual([{ path: 'currentPassword', code: 'incorrect' }]);
      const tooShort = await changePassword(cookies, user.password, 'short one');
      expect(tooShort.body.error.fields).toEqual([{ path: 'newPassword', code: 'too_short' }]);
    });

    it('on success every other session ends and this browser gets a fresh one', async () => {
      const user = await testUsers.create();
      const otherBrowser = await signedInCookies(user);
      const thisBrowser = await signedInCookies(user);
      const newPassword = `evening market ${randomUUID().slice(0, 8)} lantern`;
      const changed = await changePassword(thisBrowser, user.password, newPassword).expect(204);
      const freshCookies = cookiesSetBy(changed);
      await me(freshCookies).expect(200);
      await me(otherBrowser).expect(401);
      await me(thisBrowser).expect(401);
      await signIn(user.email, newPassword).expect(200);
    });
  });

  describe('cross-site requests', () => {
    it('sign-in, refresh and sign-out from another site, or with no origin at all, are refused even without cookies', async () => {
      for (const path of ['/api/v1/auth/sign-in', '/api/v1/auth/refresh', '/api/v1/auth/sign-out']) {
        const fromOtherSite = await client().post(path).set('Origin', 'https://other-site.example').send({ email: 'a@b.c', password: 'x' });
        expect(fromOtherSite.status, path).toBe(403);
        const withoutOrigin = await client().post(path).send({ email: 'a@b.c', password: 'x' });
        expect(withoutOrigin.status, path).toBe(403);
      }
    });
  });

  describe('password policy (NIST SP 800-63B revision 4)', () => {
    const check = (password: string, details = {}) => testApplication.application.get(PasswordPolicy).check(password, details);

    it('counts characters, not bytes: 15 to 128 after NFC normalisation', () => {
      expect(check('kettle orchard9')).toBe(null);
      expect(check('kettle orchard')).toBe('too_short');
      expect(check('k'.repeat(1) + 'ettle orchard '.repeat(9).slice(0, 127))).toBe(null);
      expect(check('z'.repeat(64) + 'q'.repeat(65))).toBe('too_long');
      const composed = 'café garden hills';
      const decomposed = 'café garden hills';
      expect(check(composed)).toBe(null);
      expect(check(decomposed)).toBe(null);
      expect(Array.from(decomposed.normalize('NFC')).length).toBe(Array.from(composed).length);
    });

    it('refuses common passwords, repeats and plain sequences', () => {
      expect(testApplication.application.get(PasswordPolicy).commonPasswordCount).toBeGreaterThanOrEqual(3000);
      expect(check('1q2w3e4r5t6y7u8i9o0p')).toBe('too_common');
      expect(check('aaaaaaaaaaaaaaaa')).toBe('too_common');
      expect(check('abcabcabcabcabcabc')).toBe('too_common');
      expect(check('abcdefghijklmnopq')).toBe('too_common');
      expect(check('zyxwvutsrqponmlkj')).toBe('too_common');
    });

    it('refuses passwords built from the service name or the person and station details', () => {
      expect(check('my lookup password 2026')).toBe('contains_personal_details');
      expect(check('Mwansa sunrise kettle', { fullName: 'Mwansa Banda' })).toBe('contains_personal_details');
      expect(check('kettle bmwansa99 river', { email: 'bmwansa99@example.test' })).toBe('contains_personal_details');
      expect(check('phoenix kettle river rain', { stationNames: ['Phoenix FM'] })).toBe('contains_personal_details');
      expect(check('kettle orchard river rain', { fullName: 'Mwansa Banda', stationNames: ['Phoenix FM'] })).toBe(null);
    });
  });
});
