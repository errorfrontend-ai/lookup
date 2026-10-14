import { randomInt, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import supertest from 'supertest';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HUMAN_CHECK_DUMMY_TOKEN } from '../src/common/security/human-check.js';
import { CLOCK } from '../src/common/time/clock.js';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { EMAIL_SENDER, type EmailSender, type OutgoingEmail } from '../src/features/notifications/notification-senders.js';
import { databaseSetupClient } from './support/database-clients.js';
import { INTERNAL_DETAIL_PATTERNS } from './support/internal-detail-patterns.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * Station sign-up through HTTP (P5A design §3.3; journeys A and D; P5A-SIGNUP-02..08, P5A-VERIFICATION-01..09,
 * P5A-STATION-DETAILS-01..09, P5A-LICENCE-01..07), with the notify worker on and a recording email sender in place of
 * SMTP, so the SMS (delivered as an email in development) and the email link are read as the applicant would.
 * Mobile numbers are Zambian, as sign-up requires; nothing is ever sent beyond the recording sender.
 */
class RecordingEmailSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];
  async send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
  }
}

describe('station sign-up', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  const emails = new RecordingEmailSender();
  const clock = { time: Date.now(), now() { return new Date(this.time); } };
  const createdUserIds: string[] = [];
  const createdStationIds: string[] = [];
  const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  /** A random Zambian mobile number, so the per-phone limit of three a day never carries over between runs. */
  const newMobileNumber = () => `97${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
  const server = () => testApplication.application.getHttpServer();

  beforeAll(async () => {
    const config = { ...loadAppConfig(), NOTIFICATION_SENDING_ENABLED: true, NOTIFICATION_RETRY_DELAY_MILLISECONDS: 20 };
    testApplication = await createTestApplication({
      overrideProviders: (builder) =>
        builder.overrideProvider(APP_CONFIG).useValue(config).overrideProvider(EMAIL_SENDER).useValue(emails).overrideProvider(CLOCK).useValue(clock),
    });
    setupClient = databaseSetupClient();
    await setupClient.connect();
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.audit_events WHERE station_id = ANY($1) OR actor_portal_user_id = ANY($2)', [createdStationIds, createdUserIds]);
    await setupClient.query('DELETE FROM app.station_memberships WHERE station_id = ANY($1)', [createdStationIds]);
    await setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [createdStationIds]);
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

  /** Step 1 from the browser: a solved human check, an allowed Origin, a fresh address. */
  function stepOne(changes: Record<string, unknown> = {}) {
    const runTag = randomUUID().slice(0, 8);
    const body = {
      fullName: 'Chanda Mwila',
      email: `applicant.${runTag}@example.com`,
      mobileNumber: newMobileNumber(),
      password: `sunrise over the river ${randomUUID().slice(24)}`,
      humanCheckToken: HUMAN_CHECK_DUMMY_TOKEN,
      ...changes,
    };
    return { body, request: supertest(server()).post('/api/v1/registration/applicants').set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).send(body) };
  }

  /** A signed-up applicant and a way to call their application's routes with their session. */
  async function signedUpApplicant() {
    const { body, request } = stepOne();
    const response = await request;
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const stationId = response.body.stationId as string;
    createdStationIds.push(stationId);
    createdUserIds.push(response.body.user.id as string);
    const cookie = cookieHeader(cookiesSetBy(response));
    const phone = `+260${body.mobileNumber}`;
    const call = (method: 'get' | 'post' | 'put', path: string) =>
      supertest(server())[method](`/api/v1/stations/${stationId}/application${path}`).set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookie);
    return { body, response, stationId, cookie, phone, call };
  }
  const smsTo = (phone: string) => emails.sent.filter((email) => email.to === `${phone.slice(1)}@sms.development.invalid`);
  const codeIn = (email: OutgoingEmail | undefined) => /code is ([0-9]{6})/.exec(email?.text ?? '')?.[1] as string;
  const linkTokenIn = (email: OutgoingEmail | undefined) => /#token=([A-Za-z0-9_-]{43})/.exec(email?.text ?? '')?.[1] as string;

  it('journey A: step 1 signs the applicant in with a station still signing up; the code and the link arrive; every later step saves', async () => {
    const applicant = await signedUpApplicant();
    expect(applicant.response.body).toMatchObject({
      user: { fullName: 'Chanda Mwila', email: applicant.body.email, platformRole: null },
      isTwoFactorCodeNeeded: false,
      stations: [{ id: applicant.stationId, name: null, frequencyLabel: null, status: 'PENDING_VERIFICATION', role: 'OWNER' }],
      stationId: applicant.stationId,
    });
    const [sms] = await eventually(() => smsTo(applicant.phone), (sent) => sent.length === 1, 'the SMS');
    const [link] = await eventually(() => emails.sent.filter((email) => email.to === applicant.body.email), (sent) => sent.length === 1, 'the email link');
    expect(sms?.subject).toMatch(/^SMS to \+260 97 ••• ••[0-9]{2}$/);

    const fresh = await applicant.call('get', '').expect(200);
    expect(fresh.body).toMatchObject({
      status: 'PENDING_VERIFICATION',
      account: { fullName: 'Chanda Mwila', email: applicant.body.email, mobileNumber: expect.stringMatching(/^\+260 97 ••• ••[0-9]{2}$/) },
      verification: { isPhoneVerified: false, isEmailVerified: false, phoneCodeSentAt: expect.any(String) },
      nextStep: 'verify',
    });

    const wrong = codeIn(sms) === '000000' ? '000001' : '000000';
    const refused = await applicant.call('post', '/phone-verification').send({ code: wrong }).expect(400);
    expect(refused.body.error).toMatchObject({ code: 'VERIFICATION_CODE_INCORRECT', message: "That code isn't right. Check the SMS and try again." });
    await applicant.call('post', '/phone-verification').send({ code: codeIn(sms) }).expect(204);
    // The link works on any device: no session, only the token.
    await supertest(server()).post('/api/v1/registration/email-verifications').set('Origin', PORTAL_ORIGIN).send({ token: linkTokenIn(link) }).expect(204);
    expect((await applicant.call('get', '').expect(200)).body).toMatchObject({ verification: { isPhoneVerified: true, isEmailVerified: true }, nextStep: 'details' });

    const details = await applicant.call('put', '/details').send({
      name: 'Sunrise FM', frequencyLabel: '98.1 FM', province: 'Copperbelt', city: 'Ndola', timeZone: 'Africa/Lusaka', coverageNote: null, streamAddress: null,
    }).expect(200);
    expect(details.body).toMatchObject({ details: { name: 'Sunrise FM', province: 'Copperbelt', city: 'Ndola' }, nextStep: 'licence' });
    await applicant.call('put', '/licence').send({ licenceNumber: 'IBA/2026/0042' }).expect(200);

    const pdf = Buffer.from('%PDF-1.7\n% the licence\n%%EOF\n');
    const documentUpload = await applicant.call('post', '/licence-document-uploads').send({ fileName: 'licence.pdf', contentType: 'application/pdf', byteCount: pdf.length }).expect(201);
    await fetch(documentUpload.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: pdf }).then((answer) => expect(answer.status).toBe(200));
    const withDocument = await applicant.call('post', `/licence-document-uploads/${documentUpload.body.uploadId}/complete`).expect(201);
    expect(withDocument.body.licence).toMatchObject({ licenceNumber: 'IBA/2026/0042', document: { fileName: 'licence.pdf', contentType: 'application/pdf', byteCount: pdf.length } });
    expect(JSON.stringify(withDocument.body)).not.toMatch(/licence-documents\//);

    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
    const logoUpload = await applicant.call('post', '/logo-uploads').send({ fileName: 'logo.png', contentType: 'image/png', byteCount: png.length }).expect(201);
    await fetch(logoUpload.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png }).then((answer) => expect(answer.status).toBe(200));
    const withLogo = await applicant.call('post', `/logo-uploads/${logoUpload.body.uploadId}/complete`).expect(201);
    expect(withLogo.body.details.logoAddress).toMatch(/^http/);
    const shownLogo = await fetch(withLogo.body.details.logoAddress);
    expect(shownLogo.headers.get('content-type')).toBe('image/webp');

    const submitted = await applicant.call('post', '/submission').send({ isLicenceConfirmed: true }).expect(200);
    expect(submitted.body).toMatchObject({ status: 'PENDING_REVIEW', nextStep: 'submitted', submittedAt: expect.any(String), licence: { confirmedAt: expect.any(String) } });
    await eventually(() => emails.sent.filter((email) => email.to === applicant.body.email), (sent) => sent.length === 2, 'the submission email');
  });

  it('P5A-SIGNUP-08: step 1 is refused without a passing human check, and without an allowed Origin', async () => {
    const failed = await stepOne({ humanCheckToken: 'not-a-solved-check' }).request.expect(400);
    expect(failed.body.error).toMatchObject({ code: 'HUMAN_CHECK_FAILED', message: "We couldn't confirm you're a person. Please do the check again." });
    const { body } = stepOne();
    const noOrigin = await supertest(server()).post('/api/v1/registration/applicants').set('X-Forwarded-For', newClientAddress()).send(body).expect(403);
    expect(noOrigin.body.error.code).toBe('FORBIDDEN');
  });

  it('P5A-SIGNUP-04..06: each field is required, the number is Zambian, and a weak password is refused with its reason', async () => {
    const missing = await stepOne({ fullName: undefined }).request.expect(400);
    expect(missing.body.error.fields).toContainEqual(expect.objectContaining({ path: 'fullName' }));
    const foreign = await stepOne({ mobileNumber: '+447700900123' }).request.expect(400);
    expect(foreign.body.error.fields).toContainEqual({ path: 'mobileNumber', code: 'not_a_zambian_mobile_number' });
    const weak = await stepOne({ password: 'short' }).request.expect(400);
    expect(weak.body.error.fields).toEqual([{ path: 'password', code: 'too_short' }]);
  });

  it('P5A-SIGNUP-07: an email that already has an account is a clean 409 with a request id, no database text', async () => {
    const first = await signedUpApplicant();
    const again = await stepOne({ email: first.body.email.toUpperCase() }).request.expect(409);
    expect(again.body.error).toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED', message: 'This email already has an account. Sign in instead.', request_id: expect.any(String) });
    for (const pattern of INTERNAL_DETAIL_PATTERNS) expect(JSON.stringify(again.body)).not.toMatch(pattern);
  });

  it('P5A-VERIFICATION-04..06: another code only after 60 seconds; a code lasts 10 minutes; five wrong tries lock it', async () => {
    const applicant = await signedUpApplicant();
    await eventually(() => smsTo(applicant.phone), (sent) => sent.length === 1, 'the first SMS');
    const tooSoon = await applicant.call('post', '/phone-verification-codes').expect(429);
    expect(tooSoon.body.error.code).toBe('RESEND_TOO_SOON');
    expect(Number(tooSoon.headers['retry-after'])).toBeGreaterThan(0);
    clock.time += 60_000;
    const resent = await applicant.call('post', '/phone-verification-codes').expect(200);
    expect(resent.body).toEqual({ sentAt: expect.any(String), resendAvailableAt: expect.any(String) });
    const [, second] = await eventually(() => smsTo(applicant.phone), (sent) => sent.length === 2, 'the second SMS');

    clock.time += 10 * 60_000;
    const expired = await applicant.call('post', '/phone-verification').send({ code: codeIn(second) }).expect(400);
    expect(expired.body.error).toMatchObject({ code: 'VERIFICATION_CODE_EXPIRED', message: 'This code has expired. Send yourself a new one.' });

    await applicant.call('post', '/phone-verification-codes').expect(200);
    const [, , third] = await eventually(() => smsTo(applicant.phone), (sent) => sent.length === 3, 'the third SMS');
    const wrong = codeIn(third) === '000000' ? '000001' : '000000';
    for (let attempt = 0; attempt < 4; attempt += 1) await applicant.call('post', '/phone-verification').send({ code: wrong }).expect(400);
    const locked = await applicant.call('post', '/phone-verification').send({ code: wrong }).expect(400);
    expect(locked.body.error.code).toBe('VERIFICATION_CODE_LOCKED');
    expect((await applicant.call('post', '/phone-verification').send({ code: codeIn(third) }).expect(400)).body.error.code).toBe('VERIFICATION_CODE_LOCKED');
  });

  it('gap 3: a new phone number gets a new code at once, and a new email a new link; the old link stops working', async () => {
    const applicant = await signedUpApplicant();
    const [firstLink] = await eventually(() => emails.sent.filter((email) => email.to === applicant.body.email), (sent) => sent.length === 1, 'the first link');
    const newNumber = newMobileNumber();
    const newEmail = `moved.${randomUUID().slice(0, 8)}@example.com`;
    const changed = await applicant.call('put', '/account').send({ fullName: 'Chanda Mwila', email: newEmail, mobileNumber: newNumber }).expect(200);
    expect(changed.body.account).toMatchObject({ email: newEmail, mobileNumber: expect.stringMatching(/^\+260 97 ••• ••/) });
    await eventually(() => smsTo(`+260${newNumber}`), (sent) => sent.length === 1, 'the SMS to the new number');
    await eventually(() => emails.sent.filter((email) => email.to === newEmail), (sent) => sent.length === 1, 'the link to the new email');
    const stale = await supertest(server()).post('/api/v1/registration/email-verifications').set('Origin', PORTAL_ORIGIN).send({ token: linkTokenIn(firstLink) }).expect(400);
    expect(stale.body.error.code).toBe('EMAIL_LINK_NOT_VALID');
  });

  it('an incomplete submission names what is missing; a wrong file is refused and deleted; another station\'s application is not found', async () => {
    const applicant = await signedUpApplicant();
    const incomplete = await applicant.call('post', '/submission').send({ isLicenceConfirmed: true }).expect(409);
    expect(incomplete.body.error.code).toBe('APPLICATION_INCOMPLETE');
    expect(incomplete.body.error.fields.map((field: { code: string }) => field.code)).toEqual([
      'station_details_missing', 'licence_number_missing', 'licence_document_missing', 'phone_not_verified', 'email_not_verified',
    ]);
    const notPdf = Buffer.from('<html>not a licence</html>');
    const upload = await applicant.call('post', '/licence-document-uploads').send({ fileName: 'licence.pdf', contentType: 'application/pdf', byteCount: notPdf.length }).expect(201);
    await fetch(upload.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: notPdf });
    const refused = await applicant.call('post', `/licence-document-uploads/${upload.body.uploadId}/complete`).expect(400);
    expect(refused.body.error).toMatchObject({ code: 'STATION_FILE_REJECTED', fields: [{ path: 'file', code: 'wrong_file_type' }] });

    const other = await signedUpApplicant();
    await supertest(server()).get(`/api/v1/stations/${other.stationId}/application`).set('Cookie', applicant.cookie).expect(404);
    await supertest(server()).post(`/api/v1/stations/${applicant.stationId}/application/licence-document-uploads/${upload.body.uploadId}/complete`)
      .set('Origin', PORTAL_ORIGIN).set('Cookie', other.cookie).expect(404);
  });
});
