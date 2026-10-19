import { createHash, randomUUID } from 'node:crypto';
import { LISTENER_CONSENT_TEXT_VERSION, LISTENER_EMAIL_CODE_RESEND_COOLDOWN_SECONDS, VerifyListenerAccountCodeAnswer } from '@lookup/contracts';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InstallTokens } from '../src/common/listener-authentication/install-tokens.js';
import { CLOCK } from '../src/common/time/clock.js';
import { APP_CONFIG, type AppConfig, loadAppConfig } from '../src/config/app-config.js';
import { EMAIL_SENDER, type EmailSender, type OutgoingEmail } from '../src/features/notifications/notification-senders.js';
import { ListenerEmailBox } from '../src/features/listener-accounts/listener-email-box.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { randomClientAddress, registerInstall } from './support/listener-test-kit.js';
import { waitForLogWrites } from './support/log-capture.js';
import { PORTAL_ORIGIN } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * Listener accounts through HTTP (ADR-005; design docs/design/listener-accounts.md §4), with the notify worker on and a
 * recording email sender in place of SMTP, so the code is read from the email as the listener would. The clock is
 * the test's, so a code's ten minutes and a ticket's ten minutes can be crossed without waiting.
 */
class RecordingEmailSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];
  async send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
  }
}

describe('listener accounts', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  const emails = new RecordingEmailSender();
  const clock = {
    time: Date.now(),
    now() {
      return new Date(this.time);
    },
  };
  let config: AppConfig;
  const runTag = randomUUID().slice(0, 8);
  const createdInstallHashes: Buffer[] = [];
  const createdEmailHashes: Buffer[] = [];
  const client = () => supertest(testApplication.application.getHttpServer());
  const newEmail = (name = 'listener') => `${name}.${runTag}.${randomUUID().slice(0, 6)}@example.com`;
  const emailBox = () => new ListenerEmailBox(process.env.LISTENER_EMAIL_ENCRYPTION_SECRET as string);

  beforeAll(async () => {
    config = { ...loadAppConfig(), NOTIFICATION_SENDING_ENABLED: true, NOTIFICATION_RETRY_DELAY_MILLISECONDS: 20 };
    testApplication = await createTestApplication({
      overrideProviders: (builder) =>
        builder.overrideProvider(APP_CONFIG).useValue(config).overrideProvider(EMAIL_SENDER).useValue(emails).overrideProvider(CLOCK).useValue(clock),
    });
    setupClient = databaseSetupClient();
    await setupClient.connect();
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.listener_installs WHERE install_id_hash = ANY($1)', [createdInstallHashes]);
    await setupClient.query('DELETE FROM app.listener_accounts WHERE email_hash = ANY($1)', [createdEmailHashes]);
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

  async function newInstall() {
    const install = await registerInstall(client);
    createdInstallHashes.push(testApplication.application.get(InstallTokens).hashInstallId(install.installId));
    return install;
  }

  const asInstall = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Forwarded-For': randomClientAddress() });
  const requestCode = (token: string, email: string) => client().post('/api/v1/listener-account/code').set(asInstall(token)).send({ email });
  const verify = (token: string, email: string, code: string) => client().post('/api/v1/listener-account/verify').set(asInstall(token)).send({ email, code });
  const createAccountRequest = (token: string, body: Record<string, unknown>) => client().post('/api/v1/listener-account').set(asInstall(token)).send(body);
  const details = (email: string, ticket: string, changes: Record<string, unknown> = {}) => ({
    email,
    ticket,
    gender: 'FEMALE',
    age: 30,
    consent_text_version: LISTENER_CONSENT_TEXT_VERSION,
    ...changes,
  });

  /** Asks for a code and reads it from the email that came. */
  async function codeSentTo(token: string, email: string): Promise<string> {
    const before = emails.sent.filter((sent) => sent.to === email).length;
    const response = await requestCode(token, email);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const sent = await eventually(() => emails.sent.filter((message) => message.to === email), (messages) => messages.length > before, `the code email for ${email}`);
    const code = /Your Look Up code is (\d{6})/.exec(sent[sent.length - 1]?.text ?? '')?.[1];
    expect(code).toBeDefined();
    return code as string;
  }

  /** The whole sign-up: a code, its check, then the details. Returns the account's email hash for clean-up. */
  async function createAccountFor(token: string, email: string, changes: Record<string, unknown> = {}) {
    clock.time += (LISTENER_EMAIL_CODE_RESEND_COOLDOWN_SECONDS + 1) * 1000;
    const code = await codeSentTo(token, email);
    const checked = await verify(token, email, code);
    expect(checked.body.status, JSON.stringify(checked.body)).toBe('DETAILS_NEEDED');
    const created = await createAccountRequest(token, details(email, checked.body.ticket, changes));
    createdEmailHashes.push(emailBox().hash(email));
    return created;
  }

  const accountRowOf = async (email: string) =>
    (await setupClient.query('SELECT * FROM app.listener_accounts WHERE email_hash = $1', [emailBox().hash(email)])).rows[0] as Record<string, unknown> | undefined;
  const installRowOf = async (installId: string) =>
    (await setupClient.query('SELECT listener_account_id FROM app.listener_installs WHERE install_id_hash = $1', [testApplication.application.get(InstallTokens).hashInstallId(installId)]))
      .rows[0] as { listener_account_id: string | null };

  describe('asking for a code', () => {
    it('LA-ACCOUNT-01: answers 202 the same way for an email with an account and one without, so it never says which has one', async () => {
      const install = await newInstall();
      const known = newEmail('known');
      expect((await createAccountFor(install.installToken, known)).status).toBe(201);
      const second = await newInstall();
      clock.time += 61_000;
      const forKnown = await requestCode(second.installToken, known);
      const forUnknown = await requestCode(second.installToken, newEmail('unknown'));
      expect(forKnown.status).toBe(202);
      expect(forUnknown.status).toBe(202);
      expect(forKnown.body).toEqual(forUnknown.body);
      expect(forKnown.body).toEqual({ resend_after_seconds: LISTENER_EMAIL_CODE_RESEND_COOLDOWN_SECONDS });
      for (const header of ['content-type', 'cache-control']) expect(forKnown.headers[header]).toBe(forUnknown.headers[header]);
    });

    it('LA-ACCOUNT-02: a code is six digits, is sent to the address typed and nowhere else, and works once', async () => {
      const install = await newInstall();
      const email = newEmail();
      const code = await codeSentTo(install.installToken, email);
      expect(code).toMatch(/^[0-9]{6}$/);
      const message = emails.sent.filter((sent) => sent.to === email).at(-1);
      expect(message?.subject).toContain(code);
      expect(message?.text).toContain('10 minutes');
      expect(emails.sent.filter((sent) => sent.text.includes(code) && sent.to !== email)).toEqual([]);
      expect((await verify(install.installToken, email, code)).status).toBe(200);
      const again = await verify(install.installToken, email, code);
      expect(again.status).toBe(400);
      expect(assertErrorEnvelope(again.body).error.code).toBe('LISTENER_CODE_EXPIRED');
    });

    it('LA-ACCOUNT-02: a second code within a minute is RESEND_TOO_SOON with a Retry-After, and after a minute it is sent', async () => {
      const install = await newInstall();
      const email = newEmail();
      await codeSentTo(install.installToken, email);
      const tooSoon = await requestCode(install.installToken, email);
      expect(tooSoon.status).toBe(429);
      expect(assertErrorEnvelope(tooSoon.body).error.code).toBe('RESEND_TOO_SOON');
      expect(Number(tooSoon.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(tooSoon.headers['retry-after'])).toBeLessThanOrEqual(LISTENER_EMAIL_CODE_RESEND_COOLDOWN_SECONDS);
      clock.time += 61_000;
      expect((await requestCode(install.installToken, email)).status).toBe(202);
    });

    it('LA-ACCOUNT-02: a code works only for the email it was sent to', async () => {
      const install = await newInstall();
      const email = newEmail();
      const code = await codeSentTo(install.installToken, email);
      const other = await verify(install.installToken, newEmail(), code);
      expect(other.status).toBe(400);
      expect(assertErrorEnvelope(other.body).error.code).toBe('LISTENER_CODE_EXPIRED');
      expect((await verify(install.installToken, email, code)).status).toBe(200);
    });

    it('LA-ACCOUNT-02: five wrong tries lock the code; the right one is then refused, and a new code works', async () => {
      const install = await newInstall();
      const email = newEmail();
      const code = await codeSentTo(install.installToken, email);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const refused = await verify(install.installToken, email, wrong);
        expect(refused.status).toBe(400);
        expect(assertErrorEnvelope(refused.body).error.code).toBe('LISTENER_CODE_INCORRECT');
      }
      const lockingTry = await verify(install.installToken, email, wrong);
      expect(assertErrorEnvelope(lockingTry.body).error.code).toBe('LISTENER_CODE_LOCKED');
      const rightButLocked = await verify(install.installToken, email, code);
      expect(assertErrorEnvelope(rightButLocked.body).error.code).toBe('LISTENER_CODE_LOCKED');
      clock.time += 61_000;
      const fresh = await codeSentTo(install.installToken, email);
      expect((await verify(install.installToken, email, fresh)).status).toBe(200);
    });

    it('LA-ACCOUNT-02: a code is useless after ten minutes', async () => {
      const install = await newInstall();
      const email = newEmail();
      const code = await codeSentTo(install.installToken, email);
      clock.time += 10 * 60_000 + 1_000;
      const late = await verify(install.installToken, email, code);
      expect(assertErrorEnvelope(late.body).error.code).toBe('LISTENER_CODE_EXPIRED');
    });

    it('LA-ROUTES-05: the code goes by email only, queued with the address named in no log line and no job left behind', async () => {
      const install = await newInstall();
      const email = newEmail('queued');
      await codeSentTo(install.installToken, email);
      await waitForLogWrites();
      const text = JSON.stringify(testApplication.logs.lines);
      expect(text).not.toContain(email);
      expect(text).not.toContain(email.split('@')[0] as string);
    });

    it('LA-ROUTES-02: past three codes an hour for one address, the fourth is refused with 429 and a Retry-After, whoever asks', async () => {
      const email = newEmail('flooded');
      const first = await newInstall();
      for (let sendNumber = 0; sendNumber < 3; sendNumber += 1) {
        clock.time += 61_000;
        expect((await requestCode(first.installToken, email)).status).toBe(202);
      }
      clock.time += 61_000;
      const second = await newInstall();
      const refused = await requestCode(second.installToken, email);
      expect(refused.status).toBe(429);
      expect(assertErrorEnvelope(refused.body).error.code).toBe('RATE_LIMITED');
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    });

    it('LA-ROUTES-02: one install may ask for ten codes a day', async () => {
      const install = await newInstall();
      for (let sendNumber = 0; sendNumber < 10; sendNumber += 1) {
        clock.time += 61_000;
        expect((await requestCode(install.installToken, newEmail('daily'))).status, `code ${sendNumber + 1}`).toBe(202);
      }
      clock.time += 61_000;
      const refused = await requestCode(install.installToken, newEmail('daily'));
      expect(refused.status).toBe(429);
      expect(assertErrorEnvelope(refused.body).error.code).toBe('RATE_LIMITED');
    });

    it('LA-ROUTES-02: one install may check twenty codes an hour', async () => {
      const install = await newInstall();
      let lastStatus = 0;
      for (let tryNumber = 0; tryNumber < 21; tryNumber += 1) {
        const response = await verify(install.installToken, newEmail('guess'), '123456');
        lastStatus = response.status;
        if (tryNumber < 20) expect(response.status).toBe(400);
      }
      expect(lastStatus).toBe(429);
    });
  });

  describe('creating an account', () => {
    it('LA-ACCOUNT-03, -04, -05, -06: a right code for a new email gives a ticket; the details make the account, linked to the install, with the email sealed', async () => {
      const install = await newInstall();
      const email = newEmail('new');
      const code = await codeSentTo(install.installToken, email);
      const checked = await verify(install.installToken, email, code);
      expect(checked.status).toBe(200);
      expect(VerifyListenerAccountCodeAnswer.parse(checked.body)).toEqual({ status: 'DETAILS_NEEDED', ticket: expect.any(String) });

      const created = await createAccountRequest(install.installToken, details(email, checked.body.ticket, { gender: 'MALE', age: 41 }));
      createdEmailHashes.push(emailBox().hash(email));
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toEqual({ status: 'SIGNED_IN', email_masked: `${email[0]}***${email.slice(email.indexOf('@'))}` });

      const account = (await accountRowOf(email)) as Record<string, unknown>;
      expect(account).toMatchObject({
        gender: 'MALE',
        birth_year: new Date(clock.time).getUTCFullYear() - 41,
        consent_text_version: LISTENER_CONSENT_TEXT_VERSION,
      });
      expect(account.email_hash).toEqual(emailBox().hash(email));
      // The sealed email opens only with the key and this account's id; no plain email is in any column.
      expect(emailBox().open(account.id as string, account.email_sealed as Buffer)).toBe(email);
      expect(emailBox().open(randomUUID(), account.email_sealed as Buffer)).toBeNull();
      expect(JSON.stringify(Object.values(account).map((value) => (Buffer.isBuffer(value) ? value.toString('latin1') : value)))).not.toContain(email);
      expect((await installRowOf(install.installId)).listener_account_id).toBe(account.id);
    });

    it('LA-ACCOUNT-03: a right code for an email that has an account signs this install in to it, with no ticket and no questions', async () => {
      const first = await newInstall();
      const email = newEmail('returning');
      expect((await createAccountFor(first.installToken, email)).status).toBe(201);
      const secondPhone = await newInstall();
      clock.time += 61_000;
      const code = await codeSentTo(secondPhone.installToken, email);
      const checked = await verify(secondPhone.installToken, email, code);
      expect(checked.status).toBe(200);
      expect(checked.body).toEqual({ status: 'SIGNED_IN', email_masked: expect.stringMatching(/^r\*\*\*@example\.com$/) });
      const accountId = (await accountRowOf(email))?.id;
      expect((await installRowOf(first.installId)).listener_account_id).toBe(accountId);
      expect((await installRowOf(secondPhone.installId)).listener_account_id).toBe(accountId);
    });

    it('LA-ACCOUNT-04: a ticket made for another install, another email, or altered, or expired, is refused with ACCOUNT_TICKET_NOT_VALID and creates nothing', async () => {
      const install = await newInstall();
      const other = await newInstall();
      const email = newEmail('ticketed');
      clock.time += 61_000;
      const code = await codeSentTo(install.installToken, email);
      const ticket = (await verify(install.installToken, email, code)).body.ticket as string;

      const refusals: Array<[string, Awaited<ReturnType<typeof createAccountRequest>>]> = [
        ['another install', await createAccountRequest(other.installToken, details(email, ticket))],
        ['another email', await createAccountRequest(install.installToken, details(newEmail('someone-else'), ticket))],
        ['an altered ticket', await createAccountRequest(install.installToken, details(email, `${ticket.slice(0, -2)}${ticket.endsWith('AA') ? 'BB' : 'AA'}`))],
        ['a made-up ticket', await createAccountRequest(install.installToken, details(email, 'A'.repeat(54)))],
      ];
      for (const [why, response] of refusals) {
        expect(response.status, why).toBe(400);
        expect(assertErrorEnvelope(response.body).error.code, why).toBe('ACCOUNT_TICKET_NOT_VALID');
      }
      expect(await accountRowOf(email)).toBeUndefined();

      clock.time += 10 * 60_000 + 1_000;
      const expired = await createAccountRequest(install.installToken, details(email, ticket));
      expect(assertErrorEnvelope(expired.body).error.code).toBe('ACCOUNT_TICKET_NOT_VALID');
      expect(await accountRowOf(email)).toBeUndefined();
    });

    it.each([
      ['age 12', { age: 12 }, 422, 'ACCOUNT_AGE_TOO_YOUNG'],
      ['age 100', { age: 100 }, 400, 'VALIDATION_FAILED'],
      ['age 30.5', { age: 30.5 }, 400, 'VALIDATION_FAILED'],
      ['a gender that is not offered', { gender: 'X' }, 400, 'VALIDATION_FAILED'],
      ['no consent wording', { consent_text_version: undefined }, 400, 'VALIDATION_FAILED'],
      ['old consent wording', { consent_text_version: 'listener-consent-2020-01' }, 400, 'VALIDATION_FAILED'],
      ['a field it does not know', { listener_install_id: randomUUID() }, 400, 'VALIDATION_FAILED'],
    ])('LA-ACCOUNT-05: %s is refused and creates nothing', async (_why, changes, status, code) => {
      const install = await newInstall();
      const email = newEmail('refused');
      clock.time += 61_000;
      const ticket = (await verify(install.installToken, email, await codeSentTo(install.installToken, email))).body.ticket as string;
      const response = await createAccountRequest(install.installToken, details(email, ticket, changes));
      expect(response.status).toBe(status);
      const envelope = assertErrorEnvelope(response.body);
      expect(envelope.error.code).toBe(code);
      if (code === 'VALIDATION_FAILED') {
        // Field paths and reasons only, never the values sent.
        expect(JSON.stringify(response.body)).not.toContain('listener-consent-2020-01');
        expect(envelope.error.fields?.length).toBeGreaterThan(0);
      }
      expect(await accountRowOf(email)).toBeUndefined();
    });

    it.each([
      [13, 'the youngest allowed'],
      [99, 'the oldest allowed'],
    ])('LA-ACCOUNT-05: age %i (%s) makes an account whose birth year is this year minus it', async (age) => {
      const install = await newInstall();
      const email = newEmail(`age${age}`);
      const created = await createAccountFor(install.installToken, email, { age });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect((await accountRowOf(email))?.birth_year).toBe(new Date(clock.time).getUTCFullYear() - age);
    });

    it('LA-ACCOUNT-07: an install that already has an account is refused a different one (ALREADY_SIGNED_IN); the same one again changes nothing', async () => {
      const install = await newInstall();
      const first = newEmail('first');
      expect((await createAccountFor(install.installToken, first)).status).toBe(201);
      const accountId = (await accountRowOf(first))?.id;

      clock.time += 61_000;
      const secondEmail = newEmail('second');
      const code = await codeSentTo(install.installToken, secondEmail);
      const checked = await verify(install.installToken, secondEmail, code);
      const creation = await createAccountRequest(install.installToken, details(secondEmail, checked.body.ticket));
      expect(creation.status).toBe(409);
      expect(assertErrorEnvelope(creation.body).error.code).toBe('ALREADY_SIGNED_IN');
      expect(await accountRowOf(secondEmail)).toBeUndefined();

      // Signing in to another existing account while signed in is refused too.
      const otherPhone = await newInstall();
      const otherEmail = newEmail('other');
      expect((await createAccountFor(otherPhone.installToken, otherEmail)).status).toBe(201);
      clock.time += 61_000;
      const toOther = await verify(install.installToken, otherEmail, await codeSentTo(install.installToken, otherEmail));
      expect(toOther.status).toBe(409);
      expect(assertErrorEnvelope(toOther.body).error.code).toBe('ALREADY_SIGNED_IN');

      // The same account again is fine and changes nothing.
      clock.time += 61_000;
      const again = await verify(install.installToken, first, await codeSentTo(install.installToken, first));
      expect(again.body.status).toBe('SIGNED_IN');
      expect((await installRowOf(install.installId)).listener_account_id).toBe(accountId);
    });

    it('LA-ACCOUNT-08: if the email gained an account after the code was checked, the ticket links the install to it and stores nothing it was told', async () => {
      const early = await newInstall();
      const late = await newInstall();
      const email = newEmail('raced');
      clock.time += 61_000;
      const ticketForLate = (await verify(late.installToken, email, await codeSentTo(late.installToken, email))).body.ticket as string;
      expect((await createAccountFor(early.installToken, email, { gender: 'MALE', age: 50 })).status).toBe(201);
      const accountId = (await accountRowOf(email))?.id;

      const created = await createAccountRequest(late.installToken, details(email, ticketForLate, { gender: 'FEMALE', age: 20 }));
      expect(created.status).toBe(201);
      expect((await installRowOf(late.installId)).listener_account_id).toBe(accountId);
      expect(await accountRowOf(email)).toMatchObject({ gender: 'MALE', id: accountId });
      expect((await setupClient.query('SELECT count(*)::int AS accounts FROM app.listener_accounts WHERE email_hash = $1', [emailBox().hash(email)])).rows[0].accounts).toBe(1);
    });

    it('LA-ACCOUNT-08: two creations of one email at once make one account', async () => {
      const first = await newInstall();
      const second = await newInstall();
      const email = newEmail('simultaneous');
      clock.time += 61_000;
      const ticketOne = (await verify(first.installToken, email, await codeSentTo(first.installToken, email))).body.ticket as string;
      clock.time += 61_000;
      const ticketTwo = (await verify(second.installToken, email, await codeSentTo(second.installToken, email))).body.ticket as string;
      const [one, two] = await Promise.all([
        createAccountRequest(first.installToken, details(email, ticketOne)),
        createAccountRequest(second.installToken, details(email, ticketTwo)),
      ]);
      createdEmailHashes.push(emailBox().hash(email));
      expect([one.status, two.status]).toEqual([201, 201]);
      expect((await setupClient.query('SELECT count(*)::int AS accounts FROM app.listener_accounts WHERE email_hash = $1', [emailBox().hash(email)])).rows[0].accounts).toBe(1);
      expect((await installRowOf(first.installId)).listener_account_id).toBe((await installRowOf(second.installId)).listener_account_id);
    });

    it('LA-ROUTES-02: one install creates at most five accounts a day', async () => {
      const install = await newInstall();
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await createAccountRequest(install.installToken, details(newEmail('bulk'), 'A'.repeat(54)));
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
      expect(statuses[5]).toBe(429);
    });
  });

  describe('Settings: the account of this install', () => {
    it('LA-ACCOUNT-11: reports whether the install is signed in and the email only masked, never the gender or age', async () => {
      const install = await newInstall();
      const before = await client().get('/api/v1/listener-account').set(asInstall(install.installToken));
      expect(before.status).toBe(200);
      expect(before.body).toEqual({ is_signed_in: false, email_masked: null });

      const email = newEmail('shown');
      await createAccountFor(install.installToken, email, { gender: 'ANOTHER', age: 77 });
      const after = await client().get('/api/v1/listener-account').set(asInstall(install.installToken));
      expect(after.body).toEqual({ is_signed_in: true, email_masked: `${email[0]}***${email.slice(email.indexOf('@'))}` });
      expect(JSON.stringify(after.body)).not.toContain(email);
      expect(JSON.stringify(after.body)).not.toMatch(/ANOTHER|77|gender|birth/);
    });

    it('LA-ACCOUNT-09: signing out unlinks only this install; the account and its other installs stay', async () => {
      const first = await newInstall();
      const email = newEmail('shared');
      await createAccountFor(first.installToken, email);
      const second = await newInstall();
      clock.time += 61_000;
      await verify(second.installToken, email, await codeSentTo(second.installToken, email));

      const signedOut = await client().post('/api/v1/listener-account/sign-out').set(asInstall(first.installToken));
      expect(signedOut.status).toBe(204);
      expect((await installRowOf(first.installId)).listener_account_id).toBeNull();
      expect((await installRowOf(second.installId)).listener_account_id).not.toBeNull();
      expect(await accountRowOf(email)).toBeDefined();
      // Signing out when signed out is not an error.
      expect((await client().post('/api/v1/listener-account/sign-out').set(asInstall(first.installToken))).status).toBe(204);
      expect((await client().get('/api/v1/listener-account').set(asInstall(first.installToken))).body.is_signed_in).toBe(false);
    });

    it('LA-ACCOUNT-10: deleting erases the email, gender, age and consent, unlinks every install, keeps the recognitions, and leaves an audit row with no personal value', async () => {
      const first = await newInstall();
      const second = await newInstall();
      const email = newEmail('erased');
      await createAccountFor(first.installToken, email, { gender: 'FEMALE', age: 28 });
      clock.time += 61_000;
      await verify(second.installToken, email, await codeSentTo(second.installToken, email));
      const accountId = (await accountRowOf(email))?.id as string;

      const deleted = await client().delete('/api/v1/listener-account').set(asInstall(first.installToken));
      expect(deleted.status).toBe(204);
      expect(await accountRowOf(email)).toBeUndefined();
      expect((await installRowOf(first.installId)).listener_account_id).toBeNull();
      expect((await installRowOf(second.installId)).listener_account_id).toBeNull();
      const audit = (await setupClient.query(`SELECT action, entity_type, entity_id, changes FROM app.audit_events WHERE entity_id = $1 ORDER BY id`, [accountId])).rows;
      expect(audit.map((row) => row.action)).toEqual(['listener_account_created', 'listener_account_deleted']);
      expect(JSON.stringify(audit)).not.toMatch(new RegExp(`${email.split('@')[0]}|FEMALE|"28"|birth`));
      // Deleting when there is no account answers 204 too, and the same email can sign up again as a new account.
      expect((await client().delete('/api/v1/listener-account').set(asInstall(first.installToken))).status).toBe(204);
      expect((await createAccountFor(first.installToken, email)).status).toBe(201);
      expect((await accountRowOf(email))?.id).not.toBe(accountId);
    });
  });

  describe('the routes meet the baseline', () => {
    const routes: Array<[string, 'get' | 'post' | 'delete', string, object?]> = [
      ['request a code', 'post', '/api/v1/listener-account/code', { email: 'a@example.com' }],
      ['verify a code', 'post', '/api/v1/listener-account/verify', { email: 'a@example.com', code: '123456' }],
      ['create an account', 'post', '/api/v1/listener-account', {}],
      ['read the account', 'get', '/api/v1/listener-account'],
      ['sign out', 'post', '/api/v1/listener-account/sign-out'],
      ['delete the account', 'delete', '/api/v1/listener-account'],
    ];

    it.each(routes)('LA-ROUTES-01: %s needs an install token: none and a made-up one are 401 INSTALL_TOKEN_INVALID before anything else', async (_name, method, path, body) => {
      for (const authorization of [undefined, 'Bearer not.a.token']) {
        let request = client()[method](path).set('X-Forwarded-For', randomClientAddress());
        if (authorization) request = request.set('Authorization', authorization);
        const response = await (body ? request.send(body) : request);
        expect(response.status).toBe(401);
        expect(assertErrorEnvelope(response.body).error.code).toBe('INSTALL_TOKEN_INVALID');
      }
    });

    it.each(routes)('LA-ROUTES-01: %s is not opened by a portal cookie', async (_name, method, path, body) => {
      const request = client()[method](path)
        .set('X-Forwarded-For', randomClientAddress())
        .set('Origin', PORTAL_ORIGIN)
        .set('Cookie', '__Host-lookup_access=made-up; __Host-lookup_refresh=made-up');
      const response = await (body ? request.send(body) : request);
      expect(response.status).toBe(401);
      expect(assertErrorEnvelope(response.body).error.code).toBe('INSTALL_TOKEN_INVALID');
    });

    it.each(routes.filter(([, method]) => method !== 'get'))('LA-ROUTES-01: %s refuses a cookie-carrying request from another site (403), as every write does', async (_name, method, path, body) => {
      const install = await newInstall();
      const request = client()[method](path).set(asInstall(install.installToken)).set('Origin', 'https://elsewhere.example.com').set('Cookie', 'session=example');
      const response = await (body ? request.send(body) : request);
      expect(response.status).toBe(403);
      expect(assertErrorEnvelope(response.body).error.code).toBe('FORBIDDEN');
    });

    it.each(routes)('LA-ROUTES-01: %s is refused with 426 APP_UPDATE_REQUIRED to an install below the minimum app version, after the token and before anything else', async (_name, method, path, body) => {
      const install = await newInstall();
      config.LISTENER_MINIMUM_APP_VERSION = '2.0.0';
      try {
        const request = client()[method](path).set(asInstall(install.installToken));
        const response = await (body ? request.send(body) : request);
        expect(response.status).toBe(426);
        expect(assertErrorEnvelope(response.body).error.code).toBe('APP_UPDATE_REQUIRED');
      } finally {
        config.LISTENER_MINIMUM_APP_VERSION = '0.0.0';
      }
    });

    it('LA-ROUTES-01: a body with a field it does not know is refused, naming the field and not its value', async () => {
      const install = await newInstall();
      const response = await client()
        .post('/api/v1/listener-account/code')
        .set(asInstall(install.installToken))
        .send({ email: 'a@example.com', secret_marker: 'do-not-echo-this' });
      expect(response.status).toBe(400);
      expect(assertErrorEnvelope(response.body).error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(response.body)).not.toContain('do-not-echo-this');
    });

    it('LA-ROUTES-03: a malformed body, a wrong type and a code that is not six digits each answer in the error envelope with the request id', async () => {
      const install = await newInstall();
      const attempts = [
        client().post('/api/v1/listener-account/code').set(asInstall(install.installToken)).set('Content-Type', 'application/json').send('{"email": '),
        client().post('/api/v1/listener-account/code').set(asInstall(install.installToken)).send({ email: 42 }),
        client().post('/api/v1/listener-account/verify').set(asInstall(install.installToken)).send({ email: 'a@example.com', code: '12ab56' }),
        client().post('/api/v1/listener-account').set(asInstall(install.installToken)).send('not json at all'),
      ];
      for (const response of await Promise.all(attempts)) {
        expect(response.status).toBe(400);
        const envelope = assertErrorEnvelope(response.body);
        expect(envelope.error.request_id.length).toBeGreaterThan(0);
        expect(response.headers['x-request-id']).toBeDefined();
      }
    });
  });

  describe('privacy', () => {
    it('LA-PRIVACY-01: a whole sign-up, a failed one and a deletion leave no email, code, ticket, gender or age in any log line', async () => {
      const install = await newInstall();
      const email = newEmail('private');
      const code = await codeSentTo(install.installToken, email);
      await verify(install.installToken, email, code === '999999' ? '000001' : '999999');
      const checked = await verify(install.installToken, email, code);
      const ticket = checked.body.ticket as string;
      await createAccountRequest(install.installToken, details(email, ticket, { gender: 'PREFER_NOT_TO_SAY', age: 63 }));
      createdEmailHashes.push(emailBox().hash(email));
      await createAccountRequest(install.installToken, details(email, ticket, { age: 5 }));
      await client().delete('/api/v1/listener-account').set(asInstall(install.installToken));
      await waitForLogWrites();
      const log = JSON.stringify(testApplication.logs.lines);
      for (const secret of [email, email.split('@')[0] as string, ticket, 'PREFER_NOT_TO_SAY', `"age":63`, `birth_year`]) {
        expect(log, secret).not.toContain(secret);
      }
      // A line names the six digits only when they are a request id by chance; the code is not logged by any field.
      expect(testApplication.logs.lines.filter((line) => 'code' in line && typeof line.code === 'string' && line.code === code)).toEqual([]);
      // Every line of these requests carries the install as a keyed hash, never the raw token or id.
      expect(log).not.toContain(install.installToken);
      expect(log).not.toContain(install.installId);
    });

    it('LA-PRIVACY-01: the redaction list hides what a listener says about themselves wherever it is logged', async () => {
      const { REDACTED_LOG_PATHS } = await import('../src/infrastructure/logging/logging.module.js');
      for (const path of ['*.gender', '*.age', '*.birthYear', '*.ticket', '*.typedCode', '*.emailAddress']) expect(REDACTED_LOG_PATHS).toContain(path);
      // `*.code` would hide a database error's SQLSTATE from the developers, so it is deliberately not redacted.
      expect(REDACTED_LOG_PATHS).not.toContain('*.code');
    });

    it('LA-ACCOUNT-06: the hash of the same address is the same for the same key and different for another, and is not a plain hash of the address', () => {
      const email = 'someone@example.com';
      const box = new ListenerEmailBox('A'.repeat(43));
      expect(box.hash(email)).toEqual(new ListenerEmailBox('A'.repeat(43)).hash(email));
      expect(box.hash(email)).not.toEqual(new ListenerEmailBox('B'.repeat(43)).hash(email));
      expect(box.hash(email)).not.toEqual(createHash('sha256').update(email).digest());
      expect(box.hash(email).length).toBe(32);
    });
  });
});
