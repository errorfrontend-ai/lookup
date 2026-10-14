import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { computeTwoFactorCode, decodeBase32, twoFactorTimeStepAt } from '@lookup/contracts';
import type pg from 'pg';
import sharp from 'sharp';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../scripts/create-super-admin.js';
import { loadDatabaseSetupConfig } from '../scripts/database-setup-config.js';
import { HUMAN_CHECK_DUMMY_TOKEN } from '../src/common/security/human-check.js';
import { CLOCK } from '../src/common/time/clock.js';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { EMAIL_SENDER, type EmailSender, type OutgoingEmail } from '../src/features/notifications/notification-senders.js';
import { databaseSetupClient } from './support/database-clients.js';
import { waitForLogWrites } from './support/log-capture.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

class RecordingEmailSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];
  async send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
  }
}

type Method = 'get' | 'post' | 'put' | 'delete';

/**
 * One station's whole life through Phase 5a's routes (P5A-AUDIT-01..04, P5A-LOGGING-01..03,
 * P5A-NOTIFICATIONS-07, -08): it signs up, is rejected, sends its application again, is approved, suspended and
 * reactivated, asks for a change that is withdrawn, approved and refused, and builds its team. Every route that
 * changes data must leave an audit row under its own request id; afterwards, nothing personal is in the log.
 */
describe('phase 5a: every write is audited, and the log holds nothing personal', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  const emails = new RecordingEmailSender();
  const clock = { time: Date.now(), now() { return new Date(this.time); } };
  const createdUserIds: string[] = [];
  const createdStationIds: string[] = [];
  const createdAssetIds: string[] = [];
  /** Every write called, with the request id it was answered under. */
  const writes: Array<{ route: string; requestId: string; isAdmin: boolean }> = [];
  /** Values that must never reach the log. */
  const secrets: string[] = [];
  const server = () => testApplication.application.getHttpServer();
  const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

  beforeAll(async () => {
    const config = { ...loadAppConfig(), NOTIFICATION_SENDING_ENABLED: true, NOTIFICATION_RETRY_DELAY_MILLISECONDS: 20 };
    testApplication = await createTestApplication({
      overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config).overrideProvider(EMAIL_SENDER).useValue(emails).overrideProvider(CLOCK).useValue(clock),
    });
    setupClient = databaseSetupClient();
    await setupClient.connect();
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.audit_events WHERE station_id = ANY($1) OR actor_portal_user_id = ANY($2) OR entity_id = ANY($2)', [createdStationIds, createdUserIds]);
    await setupClient.query('DELETE FROM app.station_change_requests WHERE station_id = ANY($1)', [createdStationIds]);
    await setupClient.query('DELETE FROM app.invitations WHERE station_id = ANY($1)', [createdStationIds]);
    await setupClient.query('DELETE FROM app.station_memberships WHERE station_id = ANY($1)', [createdStationIds]);
    await setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [createdStationIds]);
    await setupClient.query('DELETE FROM app.portal_users WHERE id = ANY($1)', [createdUserIds]);
    await setupClient.query('DELETE FROM fingerprints.audio_assets WHERE id = ANY($1)', [createdAssetIds]);
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

  /** Calls a route as the browser would; a write is remembered with its request id. */
  async function call(cookie: string | null, method: Method, path: string, body?: unknown, options: { isWrite?: boolean; isAdmin?: boolean; expected?: number } = {}) {
    let request = supertest(server())[method](`/api/v1${path}`).set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress());
    if (cookie) request = request.set('Cookie', cookie);
    const answer = body === undefined ? await request : await request.send(body as object);
    expect(answer.status, `${method.toUpperCase()} ${path}: ${JSON.stringify(answer.body)}`).toBe(options.expected ?? (answer.status < 300 ? answer.status : 200));
    if (options.isWrite ?? method !== 'get') writes.push({ route: `${method.toUpperCase()} ${path}`, requestId: answer.headers['x-request-id'] as string, isAdmin: options.isAdmin ?? false });
    return answer;
  }
  const smsTo = (phone: string) => emails.sent.filter((email) => email.to === `${phone.slice(1)}@sms.development.invalid`);
  const codeIn = (email: OutgoingEmail | undefined) => /code is ([0-9]{6})/.exec(email?.text ?? '')?.[1] as string;
  const tokenIn = (email: OutgoingEmail | undefined) => /#token=([A-Za-z0-9_-]{43})/.exec(email?.text ?? '')?.[1] as string;

  async function upload(cookie: string, startPath: string, file: { fileName: string; contentType: string; bytes: Buffer }) {
    const started = await call(cookie, 'post', startPath, { fileName: file.fileName, contentType: file.contentType, byteCount: file.bytes.length }, { isWrite: false });
    expect((await fetch(started.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.contentType }, body: file.bytes })).status).toBe(200);
    return started.body.uploadId as string;
  }

  it('P5A-AUDIT-01..04, P5A-NOTIFICATIONS-07: a station’s whole life writes an audit row for every change, under the request that made it', async () => {
    // ---- the super admin --------------------------------------------------------------------------------------
    const adminPassword = `quiet harbour lantern ${randomUUID().slice(24)}`;
    const adminEmail = `audit.admin.${randomUUID().slice(0, 8)}@example.com`;
    const enrolment = await createSuperAdmin(loadDatabaseSetupConfig().setupUrl, { email: adminEmail, fullName: 'Audit Operator', password: adminPassword }, process.env.TWO_FACTOR_ENCRYPTION_SECRET as string);
    createdUserIds.push(enrolment.portalUserId);
    const adminSignIn = await call(null, 'post', '/auth/sign-in', { email: adminEmail, password: adminPassword }, { isWrite: false });
    const admin = cookieHeader(cookiesSetBy(adminSignIn));
    await call(admin, 'post', '/auth/two-factor-code', { code: await computeTwoFactorCode(decodeBase32(enrolment.secretBase32) as Uint8Array, twoFactorTimeStepAt(Date.now())) }, { expected: 204 });

    // ---- sign-up -------------------------------------------------------------------------------------------------
    const mobileNumber = `97${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;
    const phone = `+260${mobileNumber}`;
    const applicantEmail = `audit.applicant.${randomUUID().slice(0, 8)}@example.com`;
    const password = `sunrise over the river ${randomUUID().slice(24)}`;
    secrets.push(password, applicantEmail, phone, mobileNumber, adminPassword, adminEmail);
    const signedUp = await call(null, 'post', '/registration/applicants', { fullName: 'Chanda Mwila', email: applicantEmail, mobileNumber, password, humanCheckToken: HUMAN_CHECK_DUMMY_TOKEN }, { expected: 201 });
    const stationId = signedUp.body.stationId as string;
    createdStationIds.push(stationId);
    createdUserIds.push(signedUp.body.user.id as string);
    const owner = cookieHeader(cookiesSetBy(signedUp));
    const application = `/stations/${stationId}/application`;
    const [firstSms] = await eventually(() => smsTo(phone), (sent) => sent.length === 1, 'the code');
    const [firstLink] = await eventually(() => emails.sent.filter((email) => email.to === applicantEmail), (sent) => sent.length === 1, 'the link');
    secrets.push(codeIn(firstSms), tokenIn(firstLink));

    // The notify job carries the request that caused it, and its log line says so.
    await eventually(() => testApplication.logs.lines, (lines) => lines.some((line) => line.msg === 'notification sent' && line.requestId === writes[writes.length - 1]?.requestId), 'the tagged send line');

    clock.time += 60_000;
    await call(owner, 'post', `${application}/phone-verification-codes`, undefined, { isWrite: false });
    const [, secondSms] = await eventually(() => smsTo(phone), (sent) => sent.length === 2, 'the second code');
    secrets.push(codeIn(secondSms));
    await call(owner, 'post', `${application}/phone-verification`, { code: codeIn(secondSms) }, { expected: 204 });
    clock.time += 60_000;
    await call(owner, 'post', `${application}/email-verification-links`, undefined, { isWrite: false, expected: 204 });
    const [, secondLink] = await eventually(() => emails.sent.filter((email) => email.to === applicantEmail), (sent) => sent.length === 2, 'the second link');
    secrets.push(tokenIn(secondLink));
    await call(null, 'post', '/registration/email-verifications', { token: tokenIn(secondLink) }, { expected: 204 });
    await call(owner, 'put', `${application}/account`, { fullName: 'Chanda Mwila Banda', email: applicantEmail, mobileNumber });
    await call(owner, 'put', `${application}/details`, { name: `Audit FM ${randomUUID().slice(0, 6)}`, frequencyLabel: '93.3 FM', province: 'Eastern', city: 'Chipata', timeZone: 'Africa/Lusaka', coverageNote: null, streamAddress: null });
    await call(owner, 'put', `${application}/licence`, { licenceNumber: 'IBA/2026/0303' });
    const logo = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 20, g: 90, b: 160 } } }).png().toBuffer();
    const logoUpload = await upload(owner, `${application}/logo-uploads`, { fileName: 'logo.png', contentType: 'image/png', bytes: logo });
    await call(owner, 'post', `${application}/logo-uploads/${logoUpload}/complete`, undefined, { expected: 201 });
    const pdf = Buffer.from('%PDF-1.7\n% the licence\n%%EOF\n');
    const documentUpload = await upload(owner, `${application}/licence-document-uploads`, { fileName: 'licence.pdf', contentType: 'application/pdf', bytes: pdf });
    await call(owner, 'post', `${application}/licence-document-uploads/${documentUpload}/complete`, undefined, { expected: 201 });
    // The phone came back unconfirmed with the account change: confirmed again before submitting.
    const verification = (await call(owner, 'get', application)).body.verification as { isPhoneVerified: boolean };
    if (!verification.isPhoneVerified) {
      clock.time += 60_000;
      await call(owner, 'post', `${application}/phone-verification-codes`, undefined, { isWrite: false });
      const latest = (await eventually(() => smsTo(phone), (sent) => sent.length === 3, 'the third code'))[2];
      secrets.push(codeIn(latest));
      await call(owner, 'post', `${application}/phone-verification`, { code: codeIn(latest) }, { expected: 204 });
    }
    await call(owner, 'post', `${application}/submission`, { isLicenceConfirmed: true });
    const documentKey = (await setupClient.query('SELECT licence_document_object_key AS key FROM app.stations WHERE id = $1', [stationId])).rows[0].key as string;
    secrets.push(documentKey);

    // ---- review ----------------------------------------------------------------------------------------------------
    await call(admin, 'post', `/admin/applications/${stationId}/licence-document-link`, undefined, { isAdmin: true });
    await call(admin, 'post', `/admin/applications/${stationId}/rejection`, { reason: 'Please send a clearer licence photo.' }, { isAdmin: true, expected: 204 });
    await call(owner, 'post', `${application}/submission`, { isLicenceConfirmed: true });
    await call(admin, 'post', `/admin/applications/${stationId}/approval`, undefined, { isAdmin: true, expected: 204 });
    await call(admin, 'post', `/admin/stations/${stationId}/suspension`, { reason: 'Listeners reported a scam button.' }, { isAdmin: true, expected: 204 });
    await call(admin, 'post', `/admin/stations/${stationId}/reactivation`, undefined, { isAdmin: true, expected: 204 });

    // ---- changes to the approved station ------------------------------------------------------------------------------
    const change = { name: 'Audit FM Renamed', frequencyLabel: '93.3 FM', licenceNumber: 'IBA/2026/0303', licenceDocumentUploadId: null };
    await call(owner, 'post', `/stations/${stationId}/change-requests`, change, { expected: 201 });
    await call(owner, 'post', `/stations/${stationId}/change-request/withdrawal`);
    const changeDocument = await upload(owner, `/stations/${stationId}/change-request/licence-document-uploads`, { fileName: 'new-licence.pdf', contentType: 'application/pdf', bytes: pdf });
    await call(owner, 'post', `/stations/${stationId}/change-request/licence-document-uploads/${changeDocument}/complete`, undefined, { isWrite: false, expected: 204 });
    const asked = await call(owner, 'post', `/stations/${stationId}/change-requests`, { ...change, licenceDocumentUploadId: changeDocument }, { expected: 201 });
    const changeRequestId = asked.body.open.id as string;
    await call(admin, 'post', `/admin/change-requests/${changeRequestId}/licence-document-link`, undefined, { isAdmin: true });
    await call(admin, 'post', `/admin/change-requests/${changeRequestId}/approval`, undefined, { isAdmin: true, expected: 204 });
    const refused = await call(owner, 'post', `/stations/${stationId}/change-requests`, { ...change, name: 'Audit FM Again' }, { expected: 201 });
    await call(admin, 'post', `/admin/change-requests/${refused.body.open.id as string}/rejection`, { reason: 'The new name belongs to another station.' }, { isAdmin: true, expected: 204 });

    // ---- the team -----------------------------------------------------------------------------------------------------
    const firstInvitee = `audit.member.${randomUUID().slice(0, 8)}@example.com`;
    secrets.push(firstInvitee);
    const invited = await call(owner, 'post', `/stations/${stationId}/invitations`, { email: firstInvitee, role: 'ANALYST' }, { expected: 201 });
    await call(owner, 'post', `/stations/${stationId}/invitations/${invited.body.pendingInvitations[0].id as string}/revocation`);
    await call(owner, 'post', `/stations/${stationId}/invitations`, { email: firstInvitee, role: 'MANAGER' }, { expected: 201 });
    const invitation = (await eventually(() => emails.sent.filter((email) => email.to === firstInvitee), (sent) => sent.length === 2, 'the invitation'))[1];
    secrets.push(tokenIn(invitation));
    const memberPassword = `morning tide window ${randomUUID().slice(24)}`;
    secrets.push(memberPassword);
    const joined = await call(null, 'post', '/invitations/acceptance-with-new-account', { token: tokenIn(invitation), fullName: 'Bwalya Phiri', mobileNumber: null, password: memberPassword }, { expected: 201 });
    const member = cookieHeader(cookiesSetBy(joined));
    const memberId = ((await call(member, 'get', `/stations/${stationId}/members`)).body.members as Array<{ isYou: boolean; portalUserId: string }>).find((one) => one.isYou)?.portalUserId as string;
    createdUserIds.push(memberId);
    await call(owner, 'delete', `/stations/${stationId}/members/${memberId}`);
    // Invited again, now with an account, and accepted signed in.
    await call(owner, 'post', `/stations/${stationId}/invitations`, { email: firstInvitee, role: 'ANALYST' }, { expected: 201 });
    const again = (await eventually(() => emails.sent.filter((email) => email.to === firstInvitee), (sent) => sent.length === 3, 'the second invitation'))[2];
    secrets.push(tokenIn(again));
    await call(member, 'post', '/invitations/acceptance', { token: tokenIn(again) });

    // ---- audio to check ---------------------------------------------------------------------------------------------------
    const assetIds = [randomUUID(), randomUUID()];
    for (const assetId of assetIds) {
      await setupClient.query(`INSERT INTO fingerprints.audio_assets (id, content_sha256, duration_milliseconds, fingerprint_version, hash_count) VALUES ($1, $2, 30000, 2, 100)`, [assetId, randomBytes(32)]);
      createdAssetIds.push(assetId);
    }
    const finding = (await setupClient.query(`INSERT INTO fingerprints.asset_overlaps (audio_asset_id, overlapping_audio_asset_id, overlap_milliseconds) VALUES ($1, $2, 7000) RETURNING id`, assetIds)).rows[0].id as string;
    await call(admin, 'post', `/admin/audio-overlaps/${finding}/preview-links`, undefined, { isAdmin: true });
    await call(admin, 'post', `/admin/audio-overlaps/${finding}/review`, { note: 'Two cuts of one jingle.' }, { isAdmin: true, expected: 204 });

    // ---- every write left its row ---------------------------------------------------------------------------------------------
    for (const write of writes) {
      const rows = (await setupClient.query<{ action: string; actor: string | null; request_id: string }>(
        'SELECT action, actor_portal_user_id AS actor, request_id FROM app.audit_events WHERE request_id = $1',
        [write.requestId],
      )).rows;
      expect(rows.length, `${write.route} left no audit row`).toBeGreaterThanOrEqual(1);
      if (write.isAdmin) {
        expect(rows, `${write.route}: one row, by the super admin`).toEqual([expect.objectContaining({ actor: enrolment.portalUserId, request_id: write.requestId })]);
      }
    }
    // P5A-AUDIT-01: each decision on the station names it, the decision and the super admin.
    const decisions = (await setupClient.query<{ action: string; station_id: string; actor: string }>(
      `SELECT action, station_id, actor_portal_user_id AS actor FROM app.audit_events
        WHERE station_id = $1 AND action IN ('station_application_rejected', 'station_application_approved', 'station_suspended', 'station_reactivated')
        ORDER BY occurred_at, id`,
      [stationId],
    )).rows;
    expect(decisions).toEqual(
      ['station_application_rejected', 'station_application_approved', 'station_suspended', 'station_reactivated'].map((action) => ({ action, station_id: stationId, actor: enrolment.portalUserId })),
    );
  });

  it('P5A-AUDIT-03, -04: the test above covers every phase 5a write route the API has, so a new one cannot skip it', () => {
    const express = testApplication.application.getHttpAdapter().getInstance() as { router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } };
    const routes = express.router.stack.flatMap((layer) => (layer.route ? Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route?.path}`) : []));
    const phase5aWrites = routes.filter(
      (route) => !route.startsWith('GET ') && /\/api\/v1\/(admin|registration|invitations|stations\/:stationId\/(application|change-request|invitations|members))/.test(route),
    );
    // Routes that change nothing in the database: sending a code or a link, an upload address, a description, a
    // checked change-request document (named later by its request, which is audited).
    const changesNothing = new Set([
      'POST /api/v1/stations/:stationId/application/phone-verification-codes',
      'POST /api/v1/stations/:stationId/application/email-verification-links',
      'POST /api/v1/stations/:stationId/application/logo-uploads',
      'POST /api/v1/stations/:stationId/application/licence-document-uploads',
      'POST /api/v1/stations/:stationId/change-request/licence-document-uploads',
      'POST /api/v1/stations/:stationId/change-request/licence-document-uploads/:uploadId/complete',
      'POST /api/v1/invitations/description',
    ]);
    const called = new Set(writes.map((write) => write.route.replace(/\/[0-9a-f-]{36}/g, (segment, offset, whole) => {
      const before = whole.slice(0, offset);
      if (/\/stations$/.test(before)) return '/:stationId';
      if (/\/applications$/.test(before)) return '/:stationId';
      if (/\/change-requests$/.test(before)) return '/:changeRequestId';
      if (/\/invitations$/.test(before)) return '/:invitationId';
      if (/\/members$/.test(before)) return '/:portalUserId';
      if (/\/audio-overlaps$/.test(before)) return '/:findingId';
      return '/:uploadId';
    }).replace(/^(\w+) /, '$1 /api/v1')));
    const missing = phase5aWrites.filter((route) => !changesNothing.has(route) && !called.has(route));
    expect(missing).toEqual([]);
  });

  it('P5A-LOGGING-01..03, P5A-NOTIFICATIONS-08: after all of it, no code, password, email, phone number, link token or licence key is in the log, and sends name recipients by hash', async () => {
    await waitForLogWrites();
    const log = testApplication.logs.lines.map((line) => JSON.stringify(line)).join('\n');
    expect(secrets.length).toBeGreaterThan(10);
    for (const secret of secrets.filter(Boolean)) expect(log.includes(secret), `the log holds a value it must not: ${secret.slice(0, 3)}…`).toBe(false);
    expect(log).not.toMatch(/sms\.development\.invalid/);
    const sendLines = testApplication.logs.lines.filter((line) => line.msg === 'notification sent');
    expect(sendLines.length).toBeGreaterThanOrEqual(5);
    for (const line of sendLines) {
      expect(line).toMatchObject({ requestId: expect.any(String), recipientHash: expect.any(String) });
      expect(line).not.toHaveProperty('recipient');
    }
  });
});
