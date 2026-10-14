import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { computeTwoFactorCode, decodeBase32, INGEST_QUEUE_NAME, twoFactorTimeStepAt } from '@lookup/contracts';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSuperAdmin } from '../scripts/create-super-admin.js';
import { loadDatabaseSetupConfig } from '../scripts/database-setup-config.js';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { EMAIL_SENDER, type EmailSender, type OutgoingEmail } from '../src/features/notifications/notification-senders.js';
import { NotificationWorker, notifyWorkerHeartbeatKey } from '../src/features/notifications/notification-worker.js';
import { databaseSetupClient } from './support/database-clients.js';
import { AiringAds } from './support/listener-test-kit.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * The super-admin console's API (P5A design §3.3; journeys C, D, E, G, H; P5A-ADMIN-ACCESS, -QUEUE, -STATIONS,
 * OVERLAP-REVIEW, -HEALTH), with the notify worker on and a recording email sender, so each decision's SMS (an email
 * in development) and email are seen as the station would get them.
 */
class RecordingEmailSender implements EmailSender {
  readonly sent: OutgoingEmail[] = [];
  async send(email: OutgoingEmail): Promise<void> {
    this.sent.push(email);
  }
}

const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

describe('the super-admin console', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  const emails = new RecordingEmailSender();
  const createdStationIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdAssetIds: string[] = [];
  const createdInstallIds: string[] = [];
  let adminCookie = '';
  let adminUserId = '';
  const server = () => testApplication.application.getHttpServer();

  async function signIn(email: string, password: string): Promise<string> {
    const response = await supertest(server()).post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress())
      .send({ email, password }).expect(200);
    return cookieHeader(cookiesSetBy(response));
  }
  const asAdmin = (method: 'get' | 'post', path: string, cookie = adminCookie) =>
    supertest(server())[method](`/api/v1/admin${path}`).set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookie);

  beforeAll(async () => {
    const config = { ...loadAppConfig(), NOTIFICATION_SENDING_ENABLED: true, NOTIFICATION_RETRY_DELAY_MILLISECONDS: 20 };
    testApplication = await createTestApplication({
      overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config).overrideProvider(EMAIL_SENDER).useValue(emails),
    });
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
    const password = `quiet harbour lantern ${randomUUID().slice(24)}`;
    const email = `console.${randomUUID().slice(0, 8)}@example.com`;
    const enrolment = await createSuperAdmin(loadDatabaseSetupConfig().setupUrl, { email, fullName: 'Console Operator', password }, process.env.TWO_FACTOR_ENCRYPTION_SECRET as string);
    adminUserId = enrolment.portalUserId;
    createdUserIds.push(adminUserId);
    adminCookie = await signIn(email, password);
    const code = await computeTwoFactorCode(decodeBase32(enrolment.secretBase32) as Uint8Array, twoFactorTimeStepAt(Date.now()));
    // Before the code, the console says so; after it, it opens.
    expect((await asAdmin('get', '/summary').expect(403)).body.error.code).toBe('TWO_FACTOR_REQUIRED');
    await supertest(server()).post('/api/v1/auth/two-factor-code').set('Origin', PORTAL_ORIGIN).set('Cookie', adminCookie).send({ code }).expect(204);
  });
  afterAll(async () => {
    const stations = [...createdStationIds, ...testUsers.stationIds];
    await setupClient.query('DELETE FROM app.audit_events WHERE station_id = ANY($1) OR actor_portal_user_id = ANY($2) OR entity_id = ANY($2)', [stations, createdUserIds]);
    await setupClient.query('DELETE FROM app.station_change_requests WHERE station_id = ANY($1)', [stations]);
    await setupClient.query('DELETE FROM app.station_memberships WHERE station_id = ANY($1)', [createdStationIds]);
    await setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [createdStationIds]);
    await testUsers.cleanUp();
    await setupClient.query('DELETE FROM app.portal_users WHERE id = ANY($1)', [createdUserIds]);
    await setupClient.query('DELETE FROM fingerprints.audio_assets WHERE id = ANY($1)', [createdAssetIds]);
    await setupClient.query('DELETE FROM app.recognition_events WHERE listener_install_id = ANY($1)', [createdInstallIds]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [createdInstallIds]);
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

  /** A submitted application, as sign-up leaves it: an owner, a verified contact and (by default) a licence document. */
  async function submittedApplication(options: { city?: string; frequencyLabel?: string; hasDocument?: boolean; hasLicenceNumber?: boolean; submittedAt?: Date } = {}) {
    const stationId = randomUUID();
    const ownerId = randomUUID();
    const tag = randomUUID().slice(0, 8);
    const phone = `+447700900${String(randomInt(100, 1000))}`;
    const ownerEmail = `owner.${tag}@example.com`;
    const hasDocument = options.hasDocument ?? true;
    await setupClient.query(
      `INSERT INTO app.stations (id, name, frequency_label, province, city, status, contact_name, contact_phone_number_e164, phone_verified_at,
                                 email_verified_at, licence_number, licence_document_object_key, licence_document_file_name,
                                 licence_document_content_type, licence_document_byte_count, licence_document_uploaded_at,
                                 licence_confirmed_at, application_submitted_at)
       VALUES ($1, $2, $3, 'Copperbelt', $4, 'PENDING_REVIEW', 'Mutale Banda', $5, now(), now(), $11,
               $6, $7, $8, $9, $10, now(), $12)`,
      [
        stationId, `Applicant FM ${tag}`, options.frequencyLabel ?? `${randomInt(88, 108)}.${randomInt(0, 10)} FM`, options.city ?? `Town ${tag}`, phone,
        hasDocument ? `licence-documents/${stationId}/${randomUUID()}` : null, hasDocument ? 'licence.pdf' : null, hasDocument ? 'application/pdf' : null,
        hasDocument ? 1234 : null, hasDocument ? new Date() : null, (options.hasLicenceNumber ?? true) ? 'IBA/2026/0007' : null, options.submittedAt ?? new Date(),
      ],
    );
    await setupClient.query(`INSERT INTO app.portal_users (id, email, password_hash, full_name) VALUES ($1, $2, $3, 'Mutale Banda')`, [
      ownerId, ownerEmail, '$argon2id$v=19$m=19456,t=2,p=1$cGxhY2Vob2xkZXJzYWx0$cGxhY2Vob2xkZXJoYXNoLW5vdC1hLXJlYWwtcGFzc3dvcmQ',
    ]);
    await setupClient.query(`INSERT INTO app.station_memberships (station_id, portal_user_id, role) VALUES ($1, $2, 'OWNER')`, [stationId, ownerId]);
    createdStationIds.push(stationId);
    createdUserIds.push(ownerId);
    return { stationId, phone, ownerEmail, name: `Applicant FM ${tag}` };
  }
  const sentTo = (address: string) => emails.sent.filter((email) => email.to === address);
  const smsInbox = (phone: string) => `${phone.slice(1)}@sms.development.invalid`;

  it('P5A-ADMIN-ACCESS-01, -04, P5A-D12: anyone but a super admin who passed the second factor is answered 404, as if there were no console', async () => {
    const stationUser = await testUsers.create();
    const stationCookie = await signIn(stationUser.email, stationUser.password);
    for (const path of ['/summary', '/applications', '/stations', '/system-health']) {
      expect((await asAdmin('get', path, stationCookie).expect(404)).body.error.code).toBe('NOT_FOUND');
    }
    await supertest(server()).get('/api/v1/admin/summary').expect(401);
  });

  it('journey C: the queue lists a submitted application, oldest first, flagged when its frequency and town are taken; the detail masks the phone', async () => {
    const original = await testUsers.create();
    await setupClient.query(`UPDATE app.stations SET frequency_label = '95.5 FM', city = 'Kabwe' WHERE id = $1`, [original.stationId]);
    const application = await submittedApplication({ city: 'kabwe ', frequencyLabel: '95.5fm' });
    const queue = await asAdmin('get', '/applications').expect(200);
    const entry = queue.body.entries.find((candidate: { stationId: string }) => candidate.stationId === application.stationId);
    expect(entry).toMatchObject({ kind: 'NEW_STATION', changeRequestId: null, name: application.name, duplicate: { matchedStationStatus: 'ACTIVE' } });
    const submittedTimes = queue.body.entries.map((candidate: { submittedAt: string }) => candidate.submittedAt);
    expect(submittedTimes).toEqual([...submittedTimes].sort());

    const detail = await asAdmin('get', `/applications/${application.stationId}`).expect(200);
    expect(detail.body).toMatchObject({
      checks: { isPhoneVerified: true, isEmailVerified: true, hasLicenceDocument: true },
      contact: { name: 'Mutale Banda', phoneNumberMasked: expect.stringMatching(/^\+44 ••• ••[0-9]{2}$/) },
      licenceNumber: 'IBA/2026/0007',
      licenceDocument: { fileName: 'licence.pdf', contentType: 'application/pdf', byteCount: 1234 },
      proposedChange: null,
    });
    expect(JSON.stringify(detail.body)).not.toContain(application.phone);
    expect(JSON.stringify(detail.body)).not.toMatch(/licence-documents\//);
    const summary = await asAdmin('get', '/summary').expect(200);
    expect(summary.body.waitingApplicationCount).toBeGreaterThanOrEqual(1);
  });

  it('P5A-ADMIN-QUEUE-10, -11: the licence document opens only through a 5-minute link, and opening it is audited', async () => {
    const application = await submittedApplication();
    const link = await asAdmin('post', `/applications/${application.stationId}/licence-document-link`).expect(200);
    expect(link.body).toMatchObject({ contentType: 'application/pdf', expiresAt: expect.any(String) });
    expect(new URL(link.body.address).searchParams.get('X-Amz-Expires')).toBe('300');
    const audit = await setupClient.query(`SELECT actor_portal_user_id FROM app.audit_events WHERE station_id = $1 AND action = 'licence_document_opened'`, [application.stationId]);
    expect(audit.rows).toEqual([{ actor_portal_user_id: adminUserId }]);
  });

  it('journey C: approving makes the station active, names the reviewer, and tells it by SMS and email; a second approval is refused', async () => {
    const application = await submittedApplication();
    await asAdmin('post', `/applications/${application.stationId}/approval`).expect(204);
    const station = await setupClient.query('SELECT status, reviewed_by_portal_user_id, reviewed_at FROM app.stations WHERE id = $1', [application.stationId]);
    expect(station.rows[0]).toMatchObject({ status: 'ACTIVE', reviewed_by_portal_user_id: adminUserId, reviewed_at: expect.any(Date) });
    await eventually(() => sentTo(smsInbox(application.phone)), (sent) => sent.length === 1, 'the approval SMS');
    const [email] = await eventually(() => sentTo(application.ownerEmail), (sent) => sent.length === 1, 'the approval email');
    expect(email?.subject).toBe(`${application.name} is approved on Look Up`);
    const again = await asAdmin('post', `/applications/${application.stationId}/approval`).expect(409);
    expect(again.body.error.code).toBe('STATION_STATUS_CHANGE_NOT_ALLOWED');
  });

  it('P5A-ADMIN-QUEUE-19: an application with no licence document cannot be approved', async () => {
    const application = await submittedApplication({ hasDocument: false });
    expect((await asAdmin('post', `/applications/${application.stationId}/approval`).expect(409)).body.error.code).toBe('STATION_STATUS_CHANGE_NOT_ALLOWED');
  });

  it('P5A-ADMIN-QUEUE-19: an application with no licence number cannot be approved either, and stays waiting', async () => {
    const application = await submittedApplication({ hasLicenceNumber: false });
    expect((await asAdmin('post', `/applications/${application.stationId}/approval`).expect(409)).body.error.code).toBe('STATION_STATUS_CHANGE_NOT_ALLOWED');
    expect((await setupClient.query('SELECT status FROM app.stations WHERE id = $1', [application.stationId])).rows[0].status).toBe('PENDING_REVIEW');
  });

  it('P5A-ADMIN-QUEUE-01: three applications submitted at different times come back oldest first', async () => {
    const hour = 60 * 60 * 1000;
    const newest = await submittedApplication({ submittedAt: new Date(Date.now() - hour) });
    const oldest = await submittedApplication({ submittedAt: new Date(Date.now() - 3 * hour) });
    const middle = await submittedApplication({ submittedAt: new Date(Date.now() - 2 * hour) });
    const queue = await asAdmin('get', '/applications').expect(200);
    const order = (queue.body.entries as Array<{ stationId: string }>).map((entry) => entry.stationId).filter((id) => [newest, oldest, middle].some((one) => one.stationId === id));
    expect(order).toEqual([oldest.stationId, middle.stationId, newest.stationId]);
  });

  it('P5A-ADMIN-QUEUE-18: each decision records on the station who decided and when, and a rejection its reason', async () => {
    const approved = await submittedApplication();
    const rejected = await submittedApplication();
    const before = new Date();
    await asAdmin('post', `/applications/${approved.stationId}/approval`).expect(204);
    const reason = 'The licence number does not match the document.';
    await asAdmin('post', `/applications/${rejected.stationId}/rejection`).send({ reason }).expect(204);
    const decided = await setupClient.query('SELECT id, status, review_note, reviewed_by_portal_user_id, reviewed_at FROM app.stations WHERE id = ANY($1)', [[approved.stationId, rejected.stationId]]);
    const byId = Object.fromEntries(decided.rows.map((row) => [row.id, row]));
    expect(byId[approved.stationId]).toMatchObject({ status: 'ACTIVE', review_note: null, reviewed_by_portal_user_id: adminUserId });
    expect(byId[rejected.stationId]).toMatchObject({ status: 'REJECTED', review_note: reason, reviewed_by_portal_user_id: adminUserId });
    for (const row of decided.rows) expect((row.reviewed_at as Date).getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('P5A-ADMIN-ACCESS-01, P5A-ADMIN-QUEUE-11: a station owner is answered 404 on every console route, a caller with no session 401, and neither gets a licence link', async () => {
    const owner = await testUsers.create();
    const ownerCookie = await signIn(owner.email, owner.password);
    const application = await submittedApplication();
    const someId = randomUUID();
    const routes: Array<['get' | 'post', string]> = [
      ['get', '/summary'],
      ['get', '/applications'],
      ['get', `/applications/${application.stationId}`],
      ['post', `/applications/${application.stationId}/licence-document-link`],
      ['post', `/applications/${application.stationId}/approval`],
      ['post', `/applications/${application.stationId}/rejection`],
      ['post', `/change-requests/${someId}/licence-document-link`],
      ['post', `/change-requests/${someId}/approval`],
      ['post', `/change-requests/${someId}/rejection`],
      ['get', '/stations'],
      ['post', `/stations/${owner.stationId}/suspension`],
      ['post', `/stations/${owner.stationId}/reactivation`],
      ['get', '/audio-overlaps'],
      ['post', `/audio-overlaps/${someId}/preview-links`],
      ['post', `/audio-overlaps/${someId}/review`],
      ['get', '/system-health'],
      ['get', '/reference-codes/ABCD2345'],
    ];
    for (const [method, path] of routes) {
      const asOwner = await asAdmin(method, path, ownerCookie).send({ reason: 'A reason long enough to pass.' });
      expect(asOwner.status, `${method} ${path} as a station owner`).toBe(404);
      expect(asOwner.body.error.code).toBe('NOT_FOUND');
      const anonymous = await supertest(server())[method](`/api/v1/admin${path}`).set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).send({});
      expect(anonymous.status, `${method} ${path} with no session`).toBe(401);
    }
    expect((await setupClient.query('SELECT status FROM app.stations WHERE id = $1', [application.stationId])).rows[0].status).toBe('PENDING_REVIEW');
    const opened = await setupClient.query(`SELECT count(*)::int AS count FROM app.audit_events WHERE station_id = $1 AND action = 'licence_document_opened'`, [application.stationId]);
    expect(opened.rows[0].count).toBe(0);
  });

  it('journey D: a rejection needs a reason of at least 10 characters, which the station reads word for word', async () => {
    const application = await submittedApplication();
    await asAdmin('post', `/applications/${application.stationId}/rejection`).send({ reason: 'Too short' }).expect(400);
    const reason = 'The licence document is for another station.';
    await asAdmin('post', `/applications/${application.stationId}/rejection`).send({ reason }).expect(204);
    const station = await setupClient.query('SELECT status, review_note FROM app.stations WHERE id = $1', [application.stationId]);
    expect(station.rows[0]).toEqual({ status: 'REJECTED', review_note: reason });
    const [email] = await eventually(() => sentTo(application.ownerEmail), (sent) => sent.length === 1, 'the rejection email');
    expect(email?.text).toContain(reason);
    const [sms] = await eventually(() => sentTo(smsInbox(application.phone)), (sent) => sent.length === 1, 'the rejection SMS');
    expect(sms?.text).not.toContain(reason);
    const audit = await setupClient.query(`SELECT changes FROM app.audit_events WHERE station_id = $1 AND action = 'station_application_rejected'`, [application.stationId]);
    expect(audit.rows[0].changes).toEqual({ has_reason: true });
  });

  it('journey E: a change request is decided once; approving gives the station its new details, rejecting keeps them', async () => {
    const owner = await testUsers.create();
    await setupClient.query(`UPDATE app.stations SET contact_phone_number_e164 = '+447700900451' WHERE id = $1`, [owner.stationId]);
    const insertRequest = async (name: string) =>
      (await setupClient.query(
        `INSERT INTO app.station_change_requests (station_id, name, frequency_label, licence_number, requested_by_portal_user_id) VALUES ($1, $2, '99.9 FM', 'IBA/2026/0123', $3) RETURNING id`,
        [owner.stationId, name, owner.userId],
      )).rows[0].id as string;
    const first = await insertRequest('Renamed FM');
    const queue = await asAdmin('get', '/applications').expect(200);
    expect(queue.body.entries).toContainEqual(expect.objectContaining({ stationId: owner.stationId, kind: 'DETAIL_CHANGE', changeRequestId: first, name: 'Renamed FM' }));
    const detail = await asAdmin('get', `/applications/${owner.stationId}`).expect(200);
    expect(detail.body.proposedChange).toEqual({ name: 'Renamed FM', frequencyLabel: '99.9 FM', licenceNumber: 'IBA/2026/0123', licenceDocument: null });
    await asAdmin('post', `/change-requests/${first}/approval`).expect(204);
    const station = await setupClient.query('SELECT status, name, frequency_label, licence_number FROM app.stations WHERE id = $1', [owner.stationId]);
    expect(station.rows[0]).toEqual({ status: 'ACTIVE', name: 'Renamed FM', frequency_label: '99.9 FM', licence_number: 'IBA/2026/0123' });
    await asAdmin('post', `/change-requests/${first}/approval`).expect(404);

    const second = await insertRequest('Another Name FM');
    await asAdmin('post', `/change-requests/${second}/rejection`).send({ reason: 'The new name belongs to another station.' }).expect(204);
    expect((await setupClient.query('SELECT name FROM app.stations WHERE id = $1', [owner.stationId])).rows[0].name).toBe('Renamed FM');
    const decided = await setupClient.query('SELECT decision, decision_note FROM app.station_change_requests WHERE id = $1', [second]);
    expect(decided.rows[0]).toEqual({ decision: 'REJECTED', decision_note: 'The new name belongs to another station.' });
  });

  it('journey G: suspending an active station tells it (a critical alert); reactivating brings it back; other moves are refused', async () => {
    const owner = await testUsers.create();
    await setupClient.query(`UPDATE app.stations SET contact_phone_number_e164 = '+447700900452' WHERE id = $1`, [owner.stationId]);
    await asAdmin('post', `/stations/${owner.stationId}/suspension`).send({ reason: 'Listeners reported scam buttons on two ads.' }).expect(204);
    expect((await setupClient.query('SELECT status FROM app.stations WHERE id = $1', [owner.stationId])).rows[0].status).toBe('SUSPENDED');
    await eventually(() => sentTo(smsInbox('+447700900452')), (sent) => sent.length === 1, 'the suspension SMS');
    await eventually(() => sentTo(owner.email), (sent) => sent.length === 1, 'the suspension email');
    await asAdmin('post', `/stations/${owner.stationId}/suspension`).send({ reason: 'Listeners reported scam buttons on two ads.' }).expect(409);
    await asAdmin('post', `/stations/${owner.stationId}/reactivation`).expect(204);
    expect((await setupClient.query('SELECT status, review_note FROM app.stations WHERE id = $1', [owner.stationId])).rows[0]).toEqual({ status: 'ACTIVE', review_note: null });
    const underReview = await testUsers.create({ stationStatus: 'PENDING_REVIEW' });
    await asAdmin('post', `/stations/${underReview.stationId}/suspension`).send({ reason: 'Not yet approved, so cannot be suspended.' }).expect(409);
  });

  it('the stations list finds by part of the name, frequency or town, a page at a time, and refuses a made-up cursor', async () => {
    const tag = randomUUID().slice(0, 6);
    const members: PortalTestUser[] = [];
    for (let index = 0; index < 3; index += 1) {
      const member = await testUsers.create();
      await setupClient.query('UPDATE app.stations SET name = $2, city = $3 WHERE id = $1', [member.stationId, `Search ${tag} ${index} FM`, `Mansa ${tag}`]);
      members.push(member);
    }
    const found = await asAdmin('get', `/stations?search=${encodeURIComponent(`search ${tag}`)}`).expect(200);
    expect(found.body.stations.map((station: { name: string }) => station.name)).toEqual([`Search ${tag} 0 FM`, `Search ${tag} 1 FM`, `Search ${tag} 2 FM`]);
    expect(found.body.stations[0]).toMatchObject({ status: 'ACTIVE', memberCount: 1, city: `Mansa ${tag}` });
    const byTown = await asAdmin('get', `/stations?search=${encodeURIComponent(`mansa ${tag}`)}`).expect(200);
    expect(byTown.body.stations).toHaveLength(3);
    expect((await asAdmin('get', `/stations?search=${encodeURIComponent('%')}${tag}`).expect(200)).body.stations).toEqual([]);
    expect((await asAdmin('get', '/stations?cursor=not-a-cursor').expect(400)).body.error.fields).toEqual([{ path: 'cursor', code: 'invalid_cursor' }]);
    const firstPage = await asAdmin('get', '/stations').expect(200);
    if (firstPage.body.nextCursor) {
      const secondPage = await asAdmin('get', `/stations?cursor=${firstPage.body.nextCursor}`).expect(200);
      const firstIds = new Set(firstPage.body.stations.map((station: { id: string }) => station.id));
      expect(secondPage.body.stations.some((station: { id: string }) => firstIds.has(station.id))).toBe(false);
    }
  });

  it('audio to check: findings with the ads that use each recording, a preview link, and a review recorded once', async () => {
    const assetIds = [randomUUID(), randomUUID()];
    for (const assetId of assetIds) {
      await setupClient.query(
        `INSERT INTO fingerprints.audio_assets (id, content_sha256, duration_milliseconds, fingerprint_version, hash_count) VALUES ($1, $2, 30000, 2, 100)`,
        [assetId, randomBytes(32)],
      );
      createdAssetIds.push(assetId);
    }
    const finding = (await setupClient.query(
      `INSERT INTO fingerprints.asset_overlaps (audio_asset_id, overlapping_audio_asset_id, overlap_milliseconds) VALUES ($1, $2, 7000) RETURNING id`, assetIds,
    )).rows[0].id as string;
    const listed = await asAdmin('get', '/audio-overlaps').expect(200);
    expect(listed.body.findings).toContainEqual(expect.objectContaining({
      id: finding, overlapMilliseconds: 7000, reviewedAt: null,
      first: { audioAssetNumber: expect.any(Number), ads: [] }, second: { audioAssetNumber: expect.any(Number), ads: [] },
    }));
    expect((await asAdmin('post', `/audio-overlaps/${finding}/preview-links`).expect(200)).body).toEqual({ first: null, second: null });
    await asAdmin('post', `/audio-overlaps/${finding}/review`).send({ note: 'Two cuts of one jingle.' }).expect(204);
    await asAdmin('post', `/audio-overlaps/${finding}/review`).send({ note: null }).expect(409);
    await asAdmin('post', `/audio-overlaps/${randomUUID()}/review`).send({ note: null }).expect(404);
  });

  it('P5A-OVERLAP-REVIEW-03: only the console shows that two stations’ ads share one recording', async () => {
    const airingAds = new AiringAds(setupClient);
    try {
      const shared = await airingAds.create();
      const second = await airingAds.create({ audio: { audioAssetId: shared.audioAssetId, audioAssetNumber: shared.audioAssetNumber } });
      const other = await airingAds.create();
      const finding = (await setupClient.query(
        `INSERT INTO fingerprints.asset_overlaps (audio_asset_id, overlapping_audio_asset_id, overlap_milliseconds) VALUES ($1, $2, 5000) RETURNING id`,
        [shared.audioAssetId, other.audioAssetId],
      )).rows[0].id as string;
      const listed = (await asAdmin('get', '/audio-overlaps').expect(200)).body.findings.find((one: { id: string }) => one.id === finding);
      expect(listed.first.audioAssetNumber).toBe(shared.audioAssetNumber);
      expect(listed.first.ads.map((ad: { stationId: string }) => ad.stationId).sort()).toEqual([shared.stationId, second.stationId].sort());
      await setupClient.query('DELETE FROM fingerprints.asset_overlaps WHERE id = $1', [finding]);
    } finally {
      await airingAds.removeAll();
    }
  });

  it('System health reports each queue and worker and the last day\'s recognitions; "Find by reference code" finds an audit event by its code', async () => {
    const health = await asAdmin('get', '/system-health').expect(200);
    expect(health.body).toMatchObject({ periodHours: 24, recognitionCount: expect.any(Number) });
    expect(health.body.queues.map((queue: { name: string }) => queue.name)).toEqual(['recognize', 'ingest', 'notify']);
    expect(health.body.workers.map((worker: { name: string }) => worker.name)).toEqual(['recognize', 'ingest', 'notify']);
    expect(health.body.workers.find((worker: { name: string }) => worker.name === 'notify').isRunning).toBe(true);

    const application = await submittedApplication();
    const opened = await asAdmin('post', `/applications/${application.stationId}/licence-document-link`).expect(200);
    const requestId = opened.headers['x-request-id'] as string;
    const code = `${requestId.slice(0, 4)}-${requestId.slice(4, 8)}`.toUpperCase();
    const found = await asAdmin('get', `/reference-codes/${code}`).expect(200);
    expect(found.body.searchedFor).toBe(requestId.slice(0, 8));
    expect(found.body.auditEvents).toContainEqual(expect.objectContaining({ requestId, action: 'licence_document_opened', actorName: 'Console Operator', stationName: application.name }));
    expect((await asAdmin('get', '/reference-codes/not-a-code').expect(400)).body.error.fields).toEqual([{ path: 'code', code: 'not_a_reference_code' }]);
  });

  it('P5A-SYSTEM-HEALTH-03, -04: the match time at the 95th percentile and the error rate are those of the last day’s recognitions, seeded ones included', async () => {
    const installId = randomUUID();
    createdInstallIds.push(installId);
    await setupClient.query(`INSERT INTO app.listener_installs (id, install_id_hash, platform, app_version) VALUES ($1, $2, 'ANDROID', 'test')`, [installId, randomBytes(32)]);
    const seeded: Array<[outcome: string, latency: number]> = [['NO_MATCH', 400], ['NO_MATCH', 900], ['AMBIGUOUS', 1500], ['NO_MATCH', 4200], ['TIMEOUT', 2500], ['ERROR', 300], ['BUSY', 10]];
    for (const [outcome, latency] of seeded) {
      await setupClient.query(
        `INSERT INTO app.recognition_events (id, listener_install_id, idempotency_key, request_id, captured_at, received_at, outcome, latency_milliseconds)
         VALUES ($1, $2, $3, 'test', now() - interval '1 hour', now() - interval '1 hour', $4, $5)`,
        [randomUUID(), installId, randomUUID(), outcome, latency],
      );
    }
    // The same rows, read plainly, and the figures worked out here rather than by the console's SQL.
    const rows = (await setupClient.query<{ outcome: string; latency: number | null }>(
      `SELECT outcome, latency_milliseconds AS latency FROM app.recognition_events WHERE received_at > now() - interval '24 hours'`,
    )).rows;
    const answered = rows.filter((row) => ['MATCH', 'MATCH_DEFAULT', 'CHOOSE_STATION', 'NO_MATCH', 'AMBIGUOUS'].includes(row.outcome) && row.latency !== null)
      .map((row) => row.latency as number).sort((first, second) => first - second);
    const position = 0.95 * (answered.length - 1);
    const below = answered[Math.floor(position)] as number;
    const above = answered[Math.ceil(position)] as number;
    const expectedPercentile = Math.round(below + (above - below) * (position - Math.floor(position)));
    const finished = rows.filter((row) => row.outcome !== 'PENDING').length;
    const failed = rows.filter((row) => ['TIMEOUT', 'BUSY', 'ERROR'].includes(row.outcome)).length;

    const health = await asAdmin('get', '/system-health').expect(200);
    expect(health.body.recognitionCount).toBe(rows.length);
    expect(health.body.matchMillisecondsAt95thPercentile).toBe(expectedPercentile);
    expect(health.body.errorRate).toBeCloseTo(failed / finished, 10);
    expect(failed).toBeGreaterThanOrEqual(3);
  });

  it('P5A-SYSTEM-HEALTH-05: a failed recognition is found by the reference code the app showed the listener', async () => {
    const installId = randomUUID();
    createdInstallIds.push(installId);
    await setupClient.query(`INSERT INTO app.listener_installs (id, install_id_hash, platform, app_version) VALUES ($1, $2, 'ANDROID', 'test')`, [installId, randomBytes(32)]);
    const requestId = randomUUID();
    await setupClient.query(
      `INSERT INTO app.recognition_events (id, listener_install_id, idempotency_key, request_id, captured_at, received_at, outcome)
       VALUES ($1, $2, $3, $4, now() - interval '2 days', now() - interval '2 days', 'ERROR')`,
      [randomUUID(), installId, randomUUID(), requestId],
    );
    // The app shows the first eight digits as "XXXX-XXXX".
    const code = `${requestId.slice(0, 4)}-${requestId.slice(4, 8)}`.toUpperCase();
    const found = await asAdmin('get', `/reference-codes/${code}`).expect(200);
    expect(found.body.recognitions).toContainEqual(expect.objectContaining({ requestId, outcome: 'ERROR', stationName: null }));
  });

  it('P5A-SYSTEM-HEALTH-01: a queue’s depth counts the jobs waiting in it', async () => {
    const ingest = new Queue(INGEST_QUEUE_NAME, { connection: new Redis(process.env.KEY_VALUE_STORE_URL as string, { maxRetriesPerRequest: null }), prefix: process.env.QUEUE_KEY_PREFIX });
    const depthOf = async () => ((await asAdmin('get', '/system-health').expect(200)).body.queues as Array<{ name: string; depth: number }>).find((queue) => queue.name === 'ingest')?.depth;
    try {
      const before = await depthOf();
      // Held back an hour, so nothing takes them while the test looks.
      const jobs = await Promise.all([1, 2].map((number) => ingest.add('health-check', { number }, { delay: 3_600_000, jobId: `health-check-${randomUUID()}` })));
      expect(await depthOf()).toBe((before ?? 0) + 2);
      await Promise.all(jobs.map((job) => job.remove()));
      expect(await depthOf()).toBe(before);
    } finally {
      await ingest.close();
    }
  });

  // Last in this file: it stops the notification worker that the tests above rely on.
  it('P5A-SYSTEM-HEALTH-02: a stopped worker shows as not running', async () => {
    const isNotifyRunning = async () => ((await asAdmin('get', '/system-health').expect(200)).body.workers as Array<{ name: string; isRunning: boolean }>).find((worker) => worker.name === 'notify')?.isRunning;
    expect(await isNotifyRunning()).toBe(true);
    await testApplication.application.get(NotificationWorker).onApplicationShutdown();
    // A stopped worker's heartbeat lapses after 45 seconds; the test lets it lapse at once.
    const store = new Redis(process.env.KEY_VALUE_STORE_URL as string);
    try {
      await store.del(notifyWorkerHeartbeatKey(loadAppConfig().QUEUE_KEY_PREFIX));
    } finally {
      store.disconnect();
    }
    expect(await isNotifyRunning()).toBe(false);
  });
});
