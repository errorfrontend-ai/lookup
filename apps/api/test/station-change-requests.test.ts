import { randomInt } from 'node:crypto';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { databaseSetupClient } from './support/database-clients.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * O2 as the user chose (P5A-D4; journey E; P5A design §3.3): an approved station asks to change its name, frequency
 * or licence and stays live under its approved details until a super admin decides; one request at a time; a new
 * licence document is checked before a request may name it, and only once.
 */
const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

describe('changes to an approved station', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  const server = () => testApplication.application.getHttpServer();

  beforeAll(async () => {
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.station_change_requests WHERE station_id = ANY($1)', [[...testUsers.stationIds]]);
    await testUsers.cleanUp();
    await setupClient.end();
    await testApplication.close();
  });

  async function signedIn(user: PortalTestUser) {
    const response = await supertest(server())
      .post('/api/v1/auth/sign-in').set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress())
      .send({ email: user.email, password: user.password }).expect(200);
    const cookie = cookieHeader(cookiesSetBy(response));
    return (method: 'get' | 'post', path: string) =>
      supertest(server())[method](`/api/v1/stations/${user.stationId}${path}`).set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookie);
  }
  const change = { name: 'Renamed FM', frequencyLabel: '98.1 FM', licenceNumber: 'IBA/2026/0099', licenceDocumentUploadId: null };

  it('an owner asks once; the station stays live as approved; a second request waits for the first; withdrawing closes it', async () => {
    const owner = await testUsers.create();
    const call = await signedIn(owner);
    const before = await call('get', '/change-request').expect(200);
    expect(before.body).toEqual({ approved: { name: expect.stringMatching(/^Test Station/), frequencyLabel: '98.1 FM', licenceNumber: null }, open: null, lastDecided: null });

    const opened = await call('post', '/change-requests').send(change).expect(201);
    expect(opened.body.open).toMatchObject({ name: 'Renamed FM', frequencyLabel: '98.1 FM', licenceNumber: 'IBA/2026/0099', hasNewLicenceDocument: false, decision: null });
    const station = await setupClient.query('SELECT status, name FROM app.stations WHERE id = $1', [owner.stationId]);
    expect(station.rows[0]).toEqual({ status: 'ACTIVE', name: before.body.approved.name });

    const second = await call('post', '/change-requests').send({ ...change, name: 'Another FM' }).expect(409);
    expect(second.body.error).toMatchObject({ code: 'CHANGE_REQUEST_ALREADY_OPEN', message: 'You already have a change waiting for review.' });

    const withdrawn = await call('post', '/change-request/withdrawal').expect(200);
    expect(withdrawn.body).toMatchObject({ open: null, lastDecided: { name: 'Renamed FM', decision: 'WITHDRAWN', decidedAt: expect.any(String) } });
    await call('post', '/change-request/withdrawal').expect(404);
  });

  it('a request that changes nothing is refused', async () => {
    const owner = await testUsers.create();
    await setupClient.query(`UPDATE app.stations SET licence_number = 'IBA/2026/0001' WHERE id = $1`, [owner.stationId]);
    const call = await signedIn(owner);
    const { body: state } = await call('get', '/change-request').expect(200);
    const same = await call('post', '/change-requests').send({ ...change, name: state.approved.name, licenceNumber: 'IBA/2026/0001' }).expect(400);
    expect(same.body.error.fields).toEqual([{ path: 'name', code: 'nothing_changed' }]);
  });

  it('a new licence document is checked first, then named by the request, and only once', async () => {
    const owner = await testUsers.create();
    const call = await signedIn(owner);
    const pdf = Buffer.from('%PDF-1.7\n% the new licence\n%%EOF\n');
    const upload = await call('post', '/change-request/licence-document-uploads').send({ fileName: 'new-licence.pdf', contentType: 'application/pdf', byteCount: pdf.length }).expect(201);
    const unchecked = await call('post', '/change-requests').send({ ...change, licenceDocumentUploadId: upload.body.uploadId }).expect(400);
    expect(unchecked.body.error.fields).toEqual([{ path: 'licenceDocumentUploadId', code: 'upload_not_received' }]);

    const second = await call('post', '/change-request/licence-document-uploads').send({ fileName: 'new-licence.pdf', contentType: 'application/pdf', byteCount: pdf.length }).expect(201);
    await fetch(second.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: pdf }).then((answer) => expect(answer.status).toBe(200));
    await call('post', `/change-request/licence-document-uploads/${second.body.uploadId}/complete`).expect(204);
    const opened = await call('post', '/change-requests').send({ ...change, licenceDocumentUploadId: second.body.uploadId }).expect(201);
    expect(opened.body.open).toMatchObject({ hasNewLicenceDocument: true });
    expect(JSON.stringify(opened.body)).not.toMatch(/licence-change-documents\//);
    const stored = await setupClient.query('SELECT licence_document_object_key FROM app.station_change_requests WHERE station_id = $1', [owner.stationId]);
    expect(stored.rows[0].licence_document_object_key).toMatch(new RegExp(`^licence-change-documents/${owner.stationId}/`));

    await call('post', '/change-request/withdrawal').expect(200);
    const reused = await call('post', '/change-requests').send({ ...change, licenceDocumentUploadId: second.body.uploadId }).expect(400);
    expect(reused.body.error.fields).toEqual([{ path: 'licenceDocumentUploadId', code: 'upload_not_received' }]);
  });

  it('only an owner of an approved station asks; any member reads', async () => {
    const owner = await testUsers.create();
    const manager = await testUsers.create({ joinStationId: owner.stationId, role: 'MANAGER' });
    const asManager = await signedIn(manager);
    await asManager('get', '/change-request').expect(200);
    expect((await asManager('post', '/change-requests').send(change).expect(403)).body.error.code).toBe('FORBIDDEN');

    const underReview = await testUsers.create({ stationStatus: 'PENDING_REVIEW' });
    const asApplicant = await signedIn(underReview);
    expect((await asApplicant('post', '/change-requests').send(change).expect(403)).body.error.code).toBe('STATION_NOT_ACTIVE');
  });
});
