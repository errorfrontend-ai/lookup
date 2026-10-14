import { randomUUID } from 'node:crypto';
import { computeTwoFactorCode, decodeBase32, twoFactorTimeStepAt } from '@lookup/contracts';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin, resetSuperAdminTwoFactor, SuperAdminProblem } from '../scripts/create-super-admin.js';
import { loadDatabaseSetupConfig } from '../scripts/database-setup-config.js';
import { TwoFactorSecretBox } from '../src/common/security/two-factor-secret-box.js';
import { CLOCK } from '../src/common/time/clock.js';
import { databaseSetupClient } from './support/database-clients.js';
import { cookieHeader, cookiesSetBy } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * The super admin's second factor (P5A design §3.3, §5.4; P5A-ADMIN-ACCESS-01..10; gap 12): enrolment by the operator
 * command only, then after the password one authenticator code per session, each 30-second step accepted once, wrong
 * codes limited per account.
 */
const ORIGIN = { Origin: 'http://localhost:5180' };

describe('the super admin\'s second factor', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  const clock = { time: Date.parse('2026-10-14T09:00:00.000Z'), now() { return new Date(this.time); } };
  const { setupUrl } = loadDatabaseSetupConfig();
  const encryptionSecret = process.env.TWO_FACTOR_ENCRYPTION_SECRET as string;
  const password = `quiet river lantern ${randomUUID()}`;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    testApplication = await createTestApplication({ overrideProviders: (builder) => builder.overrideProvider(CLOCK).useValue(clock) });
    setupClient = databaseSetupClient();
    await setupClient.connect();
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.audit_events WHERE actor_portal_user_id = ANY($1) OR entity_id = ANY($1)', [createdUserIds]);
    await setupClient.query('DELETE FROM app.portal_users WHERE id = ANY($1)', [createdUserIds]);
    await setupClient.end();
    await testApplication.close();
  });

  async function enrolledAdmin() {
    const email = `admin.${randomUUID().slice(0, 8)}@example.com`;
    const enrolment = await createSuperAdmin(setupUrl, { email, fullName: 'Platform Admin', password }, encryptionSecret);
    createdUserIds.push(enrolment.portalUserId);
    return { email, ...enrolment, secret: decodeBase32(enrolment.secretBase32) as Uint8Array };
  }
  /** Signs in by password; the session's cookies go with each later request, as the browser sends them. */
  async function signIn(email: string) {
    const server = testApplication.application.getHttpServer();
    const response = await supertest(server).post('/api/v1/auth/sign-in').set(ORIGIN).send({ email, password }).expect(200);
    const cookie = cookieHeader(cookiesSetBy(response));
    const session = {
      sendCode: (code: string) => supertest(server).post('/api/v1/auth/two-factor-code').set(ORIGIN).set('Cookie', cookie).send({ code }),
      me: () => supertest(server).get('/api/v1/auth/me').set('Cookie', cookie),
    };
    return { session, signedIn: response.body };
  }
  const codeAt = (secret: Uint8Array, drift = 0) => computeTwoFactorCode(secret, twoFactorTimeStepAt(clock.time) + drift);

  it('the operator command makes a super admin whose secret is stored sealed, never in the clear, and prints the authenticator address', async () => {
    const admin = await enrolledAdmin();
    expect(admin.enrolmentAddress).toMatch(new RegExp(`^otpauth://totp/Look%20Up:${encodeURIComponent(admin.email)}\\?secret=${admin.secretBase32}&issuer=Look%20Up`));
    const stored = await setupClient.query('SELECT platform_role, two_factor_secret_ciphertext, two_factor_enrolled_at FROM app.portal_users WHERE id = $1', [admin.portalUserId]);
    expect(stored.rows[0]).toMatchObject({ platform_role: 'SUPER_ADMIN', two_factor_enrolled_at: expect.any(Date) });
    const sealed = stored.rows[0].two_factor_secret_ciphertext as Buffer;
    expect(sealed.includes(Buffer.from(admin.secret))).toBe(false);
    expect(Buffer.from(new TwoFactorSecretBox(encryptionSecret).open(admin.portalUserId, sealed) ?? [])).toEqual(Buffer.from(admin.secret));
  });

  it('P5A-ADMIN-ACCESS-02: after the password the code is still needed; a right code is accepted once per session', async () => {
    const admin = await enrolledAdmin();
    const { session, signedIn } = await signIn(admin.email);
    expect(signedIn).toMatchObject({ user: { platformRole: 'SUPER_ADMIN' }, isTwoFactorCodeNeeded: true, stations: [] });
    await session.sendCode(await codeAt(admin.secret)).expect(204);
    expect((await session.me().expect(200)).body.isTwoFactorCodeNeeded).toBe(false);
    // A new session asks again.
    const second = await signIn(admin.email);
    expect((await second.session.me().expect(200)).body.isTwoFactorCodeNeeded).toBe(true);
  });

  it('a code counts for one step either side; the same step twice, or an older one, is refused', async () => {
    const admin = await enrolledAdmin();
    const { session } = await signIn(admin.email);
    await session.sendCode(await codeAt(admin.secret, 1)).expect(204);
    const reused = await session.sendCode(await codeAt(admin.secret, 1)).expect(400);
    expect(reused.body.error.code).toBe('TWO_FACTOR_CODE_INCORRECT');
    const older = await session.sendCode(await codeAt(admin.secret, 0)).expect(400);
    expect(older.body.error.message).toBe("That code isn't right. Use the current code in your authenticator app.");
    const tooOld = await signIn(admin.email);
    await tooOld.session.sendCode(await codeAt(admin.secret, -2)).expect(400);
  });

  it('P5A-ADMIN-ACCESS-10: five wrong codes for one account refuse even the right one for 15 minutes', async () => {
    const admin = await enrolledAdmin();
    const { session } = await signIn(admin.email);
    const right = await codeAt(admin.secret);
    const wrong = right === '000000' ? '000001' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await session.sendCode(wrong).expect(400);
    }
    const limited = await session.sendCode(right).expect(429);
    expect(limited.headers['retry-after']).toMatch(/^[0-9]+$/);
  });

  it('P5A-D12: a station user is refused (403); a malformed code is refused before anything is checked', async () => {
    const admin = await enrolledAdmin();
    const { session } = await signIn(admin.email);
    const malformed = await session.sendCode('12345a').expect(400);
    expect(malformed.body.error.code).toBe('VALIDATION_FAILED');
    await setupClient.query(`UPDATE app.portal_users SET platform_role = NULL, two_factor_secret_ciphertext = NULL, two_factor_enrolled_at = NULL WHERE id = $1`, [admin.portalUserId]);
    const refused = await session.sendCode(await codeAt(admin.secret)).expect(403);
    expect(refused.body.error.code).toBe('FORBIDDEN');
  });

  it('gap 12: a reset gives a new secret, ends every session, and the old authenticator no longer works', async () => {
    const admin = await enrolledAdmin();
    const { session } = await signIn(admin.email);
    const reset = await resetSuperAdminTwoFactor(setupUrl, admin.email, encryptionSecret);
    expect(reset.secretBase32).not.toBe(admin.secretBase32);
    await session.me().expect(401);
    const sessions = await setupClient.query('SELECT revocation_reason FROM app.portal_sessions WHERE portal_user_id = $1', [admin.portalUserId]);
    expect(sessions.rows.map((row) => row.revocation_reason)).toEqual(['TWO_FACTOR_RESET']);
    const next = await signIn(admin.email);
    const old = await codeAt(admin.secret);
    const fresh = await codeAt(decodeBase32(reset.secretBase32) as Uint8Array);
    if (old !== fresh) await next.session.sendCode(old).expect(400);
    await next.session.sendCode(fresh).expect(204);
    const audit = await setupClient.query(`SELECT action FROM app.audit_events WHERE entity_id = $1 AND action IN ('super_admin_enrolled', 'two_factor_reset') ORDER BY id`, [admin.portalUserId]);
    expect(audit.rows.map((row) => row.action)).toEqual(['super_admin_enrolled', 'two_factor_reset']);
  });

  it('the command refuses a weak password, a bad email, and a reset for someone who is not a super admin', async () => {
    await expect(createSuperAdmin(setupUrl, { email: `weak.${randomUUID().slice(0, 8)}@example.com`, fullName: 'Weak Admin', password: 'short' }, encryptionSecret)).rejects.toBeInstanceOf(SuperAdminProblem);
    await expect(createSuperAdmin(setupUrl, { email: 'not an email', fullName: 'Admin', password }, encryptionSecret)).rejects.toThrow(/SUPER_ADMIN_EMAIL/);
    await expect(resetSuperAdminTwoFactor(setupUrl, `nobody.${randomUUID().slice(0, 8)}@example.com`, encryptionSecret)).rejects.toThrow(/No super admin has that email/);
  });
});
