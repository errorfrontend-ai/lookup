import { randomInt, randomUUID } from 'node:crypto';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { EMAIL_SENDER, type EmailSender, type OutgoingEmail } from '../src/features/notifications/notification-senders.js';
import { databaseSetupClient } from './support/database-clients.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * A station's team (P5A design §3.3, §4.5; journey F; P5A-TEAM-*, P5A-D16), with the notify worker on and a recording
 * email sender: an owner invites by email; the invitee opens the link, then joins with a new account or signed in with
 * the invited email; an invitation works once and lasts 7 days; the last owner is never removed.
 */
class RecordingEmailSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];
  async send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
  }
}
const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

describe('team invitations', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  const emails = new RecordingEmailSender();
  const createdUserIds: string[] = [];
  const server = () => testApplication.application.getHttpServer();

  beforeAll(async () => {
    const config = { ...loadAppConfig(), NOTIFICATION_SENDING_ENABLED: true, NOTIFICATION_RETRY_DELAY_MILLISECONDS: 20 };
    testApplication = await createTestApplication({
      overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config).overrideProvider(EMAIL_SENDER).useValue(emails),
    });
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.station_memberships WHERE portal_user_id = ANY($1)', [createdUserIds]);
    await setupClient.query('DELETE FROM app.audit_events WHERE actor_portal_user_id = ANY($1)', [createdUserIds]);
    await setupClient.query('DELETE FROM app.invitations WHERE station_id = ANY($1)', [[...testUsers.stationIds]]);
    await testUsers.cleanUp();
    await setupClient.query('DELETE FROM app.portal_users WHERE id = ANY($1)', [createdUserIds]);
    await setupClient.end();
    await testApplication.close();
  });

  async function eventually<Result>(read: () => Result, isDone: (value: Result) => boolean, what: string): Promise<Result> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = read();
      if (isDone(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  async function signedIn(user: { email: string; password: string }) {
    const response = await supertest(server()).post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress())
      .send({ email: user.email, password: user.password }).expect(200);
    return cookieHeader(cookiesSetBy(response));
  }
  const at = (cookie: string, method: 'get' | 'post' | 'delete', path: string) =>
    supertest(server())[method](`/api/v1${path}`).set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookie);
  const publicly = (path: string) => supertest(server()).post(`/api/v1${path}`).set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress());
  const tokenIn = (email: OutgoingEmail | undefined) => /\/invitations\/accept#token=([A-Za-z0-9_-]{43})/.exec(email?.text ?? '')?.[1] as string;

  async function invite(owner: PortalTestUser, cookie: string, email: string, role = 'MANAGER') {
    const response = await at(cookie, 'post', `/stations/${owner.stationId}/invitations`).send({ email, role }).expect(201);
    const [sent] = await eventually(() => emails.sent.filter((candidate) => candidate.to === email.toLowerCase()), (list) => list.length > 0, 'the invitation email');
    return { team: response.body, token: tokenIn(emails.sent.filter((candidate) => candidate.to === email.toLowerCase()).at(-1) ?? sent) };
  }

  it('journey F: an owner invites; the link describes itself; the invitee joins with a new account, is signed in, and sees the team', async () => {
    const owner = await testUsers.create();
    const ownerCookie = await signedIn(owner);
    const inviteeEmail = `invitee.${randomUUID().slice(0, 8)}@example.com`;
    const { team, token } = await invite(owner, ownerCookie, inviteeEmail);
    expect(team).toMatchObject({ canManage: true, pendingInvitations: [{ email: inviteeEmail, role: 'MANAGER' }] });
    expect(JSON.stringify(team)).not.toMatch(/token/i);
    const [email] = emails.sent.filter((candidate) => candidate.to === inviteeEmail);
    expect(email?.subject).toMatch(/^You're invited to Test Station/);
    // P5A-TEAM-01, -07: one row and one email per invitation; the row names the owner who sent it and the role it grants.
    expect(emails.sent.filter((candidate) => candidate.to === inviteeEmail)).toHaveLength(1);
    const stored = await setupClient.query('SELECT kind, station_role, invited_by_portal_user_id FROM app.invitations WHERE station_id = $1', [owner.stationId]);
    expect(stored.rows).toEqual([{ kind: 'STATION_MEMBER', station_role: 'MANAGER', invited_by_portal_user_id: owner.userId }]);
    // P5A-TEAM-06, P5A-DATABASE-07: what is kept is a hash, not the token the link carries.
    const kept = (await setupClient.query('SELECT token_hash FROM app.invitations WHERE station_id = $1', [owner.stationId])).rows[0].token_hash as Buffer;
    expect(kept).toHaveLength(32);
    expect(kept.equals(Buffer.from(token, 'base64url'))).toBe(false);
    expect(kept.toString('latin1').includes(token)).toBe(false);

    const described = await publicly('/invitations/description').send({ token }).expect(200);
    expect(described.body).toMatchObject({ state: 'OPEN', role: 'MANAGER', invitedEmail: inviteeEmail, hasAccount: false, frequencyLabel: '98.1 FM' });

    const password = `morning tide window ${randomUUID().slice(24)}`;
    const joined = await publicly('/invitations/acceptance-with-new-account').send({ token, fullName: 'Bwalya Phiri', mobileNumber: null, password }).expect(201);
    expect(joined.body).toEqual({ stationId: owner.stationId });
    const inviteeCookie = cookieHeader(cookiesSetBy(joined));
    const seen = await at(inviteeCookie, 'get', `/stations/${owner.stationId}/members`).expect(200);
    expect(seen.body).toMatchObject({ canManage: false, pendingInvitations: [] });
    const you = seen.body.members.find((member: { isYou: boolean }) => member.isYou);
    expect(you).toMatchObject({ fullName: 'Bwalya Phiri', role: 'MANAGER' });
    createdUserIds.push(you.portalUserId);
    expect((await publicly('/invitations/acceptance-with-new-account').send({ token, fullName: 'Bwalya Phiri', mobileNumber: null, password }).expect(400)).body.error.code).toBe('INVITATION_NOT_VALID');
  });

  it('a person with an account accepts signed in, only with the invited email; the newest invitation replaces an open one', async () => {
    const owner = await testUsers.create();
    const ownerCookie = await signedIn(owner);
    const other = await testUsers.create();
    const stranger = await testUsers.create();
    const first = await invite(owner, ownerCookie, other.email, 'ANALYST');
    const second = await invite(owner, ownerCookie, other.email.toUpperCase(), 'MANAGER');
    expect(second.team.pendingInvitations).toHaveLength(1);
    expect((await publicly('/invitations/description').send({ token: first.token }).expect(200)).body.state).toBe('REVOKED');
    expect((await publicly('/invitations/description').send({ token: second.token }).expect(200)).body).toMatchObject({ state: 'OPEN', hasAccount: true });
    const asStranger = await signedIn(stranger);
    expect((await at(asStranger, 'post', '/invitations/acceptance').send({ token: second.token }).expect(403)).body.error.code).toBe('INVITATION_FOR_ANOTHER_EMAIL');
    const asOther = await signedIn(other);
    expect((await at(asOther, 'post', '/invitations/acceptance').send({ token: second.token }).expect(200)).body).toEqual({ stationId: owner.stationId });
    const withAccount = await publicly('/invitations/acceptance-with-new-account').send({ token: second.token, fullName: 'X', mobileNumber: null, password: `a password long enough ${randomUUID()}` }).expect(400);
    expect(withAccount.body.error.code).toBe('INVITATION_NOT_VALID');
    expect((await at(ownerCookie, 'post', `/stations/${owner.stationId}/invitations`).send({ email: other.email, role: 'ANALYST' }).expect(409)).body.error.code).toBe('ALREADY_A_MEMBER');
  });

  it('an expired or revoked invitation no longer works, and says why', async () => {
    const owner = await testUsers.create();
    const ownerCookie = await signedIn(owner);
    const expiring = await invite(owner, ownerCookie, `late.${randomUUID().slice(0, 8)}@example.com`);
    await setupClient.query(`UPDATE app.invitations SET expires_at = now() - interval '1 second' WHERE station_id = $1`, [owner.stationId]);
    const password = `long enough phrase here ${randomUUID().slice(24)}`;
    expect((await publicly('/invitations/acceptance-with-new-account').send({ token: expiring.token, fullName: 'Late Person', mobileNumber: null, password }).expect(400)).body.error.code).toBe('INVITATION_EXPIRED');
    const revoked = await invite(owner, ownerCookie, `withdrawn.${randomUUID().slice(0, 8)}@example.com`);
    const invitationId = revoked.team.pendingInvitations[0].id as string;
    await at(ownerCookie, 'post', `/stations/${owner.stationId}/invitations/${invitationId}/revocation`).expect(200);
    await at(ownerCookie, 'post', `/stations/${owner.stationId}/invitations/${invitationId}/revocation`).expect(404);
    expect((await publicly('/invitations/description').send({ token: revoked.token }).expect(200)).body.state).toBe('REVOKED');
    expect((await publicly('/invitations/description').send({ token: 'x'.repeat(43) }).expect(400)).body.error.code).toBe('INVITATION_NOT_VALID');
  });

  it('P5A-D16, P5A-TEAM-05: an owner removes members but never the last owner; managers and analysts can neither invite nor remove', async () => {
    const owner = await testUsers.create();
    const manager = await testUsers.create({ joinStationId: owner.stationId, role: 'MANAGER' });
    const analyst = await testUsers.create({ joinStationId: owner.stationId, role: 'ANALYST' });
    const ownerCookie = await signedIn(owner);
    const managerCookie = await signedIn(manager);
    const analystCookie = await signedIn(analyst);
    for (const [cookie, target] of [[managerCookie, analyst.userId], [analystCookie, manager.userId]] as const) {
      expect((await at(cookie, 'post', `/stations/${owner.stationId}/invitations`).send({ email: `x.${randomUUID().slice(0, 8)}@example.com`, role: 'ANALYST' }).expect(403)).body.error.code).toBe('FORBIDDEN');
      expect((await at(cookie, 'delete', `/stations/${owner.stationId}/members/${target}`).expect(403)).body.error.code).toBe('FORBIDDEN');
      expect((await at(cookie, 'get', `/stations/${owner.stationId}/members`).expect(200)).body.canManage).toBe(false);
    }
    await at(ownerCookie, 'delete', `/stations/${owner.stationId}/members/${analyst.userId}`).expect(200);
    const last = await at(ownerCookie, 'delete', `/stations/${owner.stationId}/members/${owner.userId}`).expect(409);
    expect(last.body.error).toMatchObject({ code: 'LAST_OWNER', message: 'A station needs at least one owner. Invite another owner first.' });
    const removed = await at(ownerCookie, 'delete', `/stations/${owner.stationId}/members/${manager.userId}`).expect(200);
    expect(removed.body.members.map((member: { portalUserId: string }) => member.portalUserId)).toEqual([owner.userId]);
    await at(managerCookie, 'get', `/stations/${owner.stationId}/members`).expect(404);
  });
});
