import { randomInt, randomUUID } from 'node:crypto';
import type pg from 'pg';
import sharp from 'sharp';
import supertest from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HUMAN_CHECK_DUMMY_TOKEN } from '../src/common/security/human-check.js';
import { StationLogoProcessor } from '../src/features/registration/station-logo-processing.js';
import { ObjectStorage } from '../src/infrastructure/object-storage/object-storage.js';
import { databaseSetupClient } from './support/database-clients.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * Sign-up's step 3 and step 4 through HTTP, with the real object store (P5A-STATION-DETAILS-01..11,
 * P5A-LICENCE-01..09): what each field accepts and where it is kept; a file's type decided by its first bytes and its
 * size by the signature, before anything decodes it; keys made by the server and never shown to the station.
 */
describe('a station application\'s details and files', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let storage: ObjectStorage;
  const createdStationIds: string[] = [];
  const createdUserIds: string[] = [];
  /**
   * Every answer a station was given in these tests, to search for keys and addresses afterwards. The signed address a
   * station sends its document to (design §3.2) names the new key, before any document exists; those are kept apart.
   */
  const stationFacingAnswers: string[] = [];
  const uploadAddressAnswers: string[] = [];
  const server = () => testApplication.application.getHttpServer();
  const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

  beforeAll(async () => {
    testApplication = await createTestApplication();
    storage = testApplication.application.get(ObjectStorage);
    setupClient = databaseSetupClient();
    await setupClient.connect();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    const keys = await setupClient.query<{ licence_document_object_key: string | null; logo_object_key: string | null }>(
      'SELECT licence_document_object_key, logo_object_key FROM app.stations WHERE id = ANY($1)',
      [createdStationIds],
    );
    for (const row of keys.rows) {
      if (row.licence_document_object_key) await storage.deleteObjectIn(storage.licenceDocumentsBucket, row.licence_document_object_key).catch(() => undefined);
      if (row.logo_object_key) await storage.deleteObjectIn(storage.stationLogosBucket, row.logo_object_key).catch(() => undefined);
    }
    await setupClient.query('DELETE FROM app.audit_events WHERE station_id = ANY($1) OR actor_portal_user_id = ANY($2)', [createdStationIds, createdUserIds]);
    await setupClient.query('DELETE FROM app.station_memberships WHERE station_id = ANY($1)', [createdStationIds]);
    await setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [createdStationIds]);
    await setupClient.query('DELETE FROM app.portal_users WHERE id = ANY($1)', [createdUserIds]);
    await setupClient.end();
    await testApplication.close();
  });

  /** A new applicant, signed in, with a way to call their application's routes and keep every answer. */
  async function signedUpApplicant() {
    const response = await supertest(server())
      .post('/api/v1/registration/applicants')
      .set('Origin', PORTAL_ORIGIN)
      .set('X-Forwarded-For', newClientAddress())
      .send({
        fullName: 'Chanda Mwila',
        email: `applicant.${randomUUID().slice(0, 8)}@example.com`,
        mobileNumber: `97${String(randomInt(0, 10_000_000)).padStart(7, '0')}`,
        password: `sunrise over the river ${randomUUID().slice(24)}`,
        humanCheckToken: HUMAN_CHECK_DUMMY_TOKEN,
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    stationFacingAnswers.push(JSON.stringify(response.body));
    const stationId = response.body.stationId as string;
    createdStationIds.push(stationId);
    createdUserIds.push(response.body.user.id as string);
    const cookie = cookieHeader(cookiesSetBy(response));
    const call = async (method: 'get' | 'post' | 'put', path: string, body?: unknown) => {
      const request = supertest(server())[method](`/api/v1/stations/${stationId}${path}`).set('Origin', PORTAL_ORIGIN).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookie);
      const answer = body === undefined ? await request : await request.send(body as object);
      const isUploadAddress = method === 'post' && /\/(licence-document|logo)-uploads$/.test(path);
      (isUploadAddress ? uploadAddressAnswers : stationFacingAnswers).push(JSON.stringify(answer.body), JSON.stringify(answer.headers));
      return answer;
    };
    return { stationId, call };
  }
  type Applicant = Awaited<ReturnType<typeof signedUpApplicant>>;

  /** Asks for an address, sends the bytes as given, and asks the API to check them. */
  async function uploadFile(applicant: Applicant, kind: 'logo-uploads' | 'licence-document-uploads', file: { fileName: string; contentType: string; bytes: Buffer; sentAs?: string }) {
    const started = await applicant.call('post', `/application/${kind}`, { fileName: file.fileName, contentType: file.contentType, byteCount: file.bytes.length });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const stored = await fetch(started.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.sentAs ?? file.contentType }, body: file.bytes });
    expect(stored.status).toBe(200);
    return { started, completed: await applicant.call('post', `/application/${kind}/${started.body.uploadId}/complete`) };
  }

  const stationRow = async (stationId: string) =>
    (await setupClient.query('SELECT * FROM app.stations WHERE id = $1', [stationId])).rows[0] as Record<string, unknown>;
  const details = {
    name: 'Sunrise FM',
    frequencyLabel: '89.5 FM',
    province: 'Copperbelt',
    city: 'Ndola',
    timeZone: 'Africa/Lusaka',
    coverageNote: null as string | null,
    streamAddress: null as string | null,
  };
  const fieldsOf = (answer: supertest.Response) => (answer.body.error?.fields ?? []).map((field: { path: string }) => field.path);

  describe('step 3, the station\'s details', () => {
    it('P5A-STATION-DETAILS-01..05, -08, -09: name, frequency, province, town, and optional note and stream are each kept in their column', async () => {
      const applicant = await signedUpApplicant();
      expect((await applicant.call('put', '/application/details', details)).status).toBe(200);
      expect(await stationRow(applicant.stationId)).toMatchObject({
        name: 'Sunrise FM', frequency_label: '89.5 FM', province: 'Copperbelt', city: 'Ndola', time_zone: 'Africa/Lusaka', coverage_note: null, stream_address: null,
      });
      const withOptional = { ...details, coverageNote: 'Ndola and Kitwe, and along the Kafue road', streamAddress: 'https://stream.sunrise.example/live' };
      expect((await applicant.call('put', '/application/details', withOptional)).status).toBe(200);
      expect(await stationRow(applicant.stationId)).toMatchObject({ coverage_note: withOptional.coverageNote, stream_address: withOptional.streamAddress });
    });

    it('P5A-STATION-DETAILS-01, -03, -08: no name, a province outside the ten, or an unknown time zone is refused with its field', async () => {
      const applicant = await signedUpApplicant();
      const refusedFor = async (changes: Record<string, unknown>) => {
        const answer = await applicant.call('put', '/application/details', { ...details, ...changes });
        expect(answer.status).toBe(400);
        return fieldsOf(answer);
      };
      expect(await refusedFor({ name: '' })).toContain('name');
      expect(await refusedFor({ province: 'Gauteng' })).toContain('province');
      expect(await refusedFor({ timeZone: 'Africa/Atlantis' })).toContain('timeZone');
      expect((await stationRow(applicant.stationId)).name).toBeNull();
    });
  });

  describe('step 3, the logo', () => {
    it('P5A-STATION-DETAILS-06: a 2000 × 2000 PNG is kept as a 512 × 512 WebP; the original is deleted and never linked', async () => {
      const applicant = await signedUpApplicant();
      const png = await sharp({ create: { width: 2000, height: 2000, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
      const { started, completed } = await uploadFile(applicant, 'logo-uploads', { fileName: 'big-logo.png', contentType: 'image/png', bytes: png });
      expect(completed.status, JSON.stringify(completed.body)).toBe(201);
      const logoKey = (await stationRow(applicant.stationId)).logo_object_key as string;
      expect(logoKey).toMatch(/^station-logos\/.+\.webp$/);
      const facts = await storage.describeObjectIn(storage.stationLogosBucket, logoKey);
      const kept = await sharp(await storage.readObjectIn(storage.stationLogosBucket, logoKey, facts?.entityTag ?? '')).metadata();
      expect({ format: kept.format, width: kept.width, height: kept.height }).toEqual({ format: 'webp', width: 512, height: 512 });
      const originalKey = decodeURIComponent(new URL(started.body.uploadUrl).pathname).split('/').slice(2).join('/');
      expect(await storage.describeObjectIn(storage.stationLogosBucket, originalKey)).toBeNull();
      expect(JSON.stringify(completed.body)).not.toContain(originalKey);
      expect(completed.body.details.logoAddress).toContain(encodeURIComponent(logoKey).replace(/%2F/g, '/'));
    });

    it('P5A-STATION-DETAILS-07: a GIF or an SVG is refused when the upload is asked for, with a field error', async () => {
      const applicant = await signedUpApplicant();
      for (const contentType of ['image/gif', 'image/svg+xml']) {
        const answer = await applicant.call('post', '/application/logo-uploads', { fileName: 'logo', contentType, byteCount: 100 });
        expect(answer.status).toBe(400);
        expect(fieldsOf(answer)).toContain('contentType');
      }
    });

    it('P5A-STATION-DETAILS-10: a GIF or SVG named logo.png and declared a PNG is refused by its first bytes, before sharp runs; an oversized PNG is refused before upload', async () => {
      const applicant = await signedUpApplicant();
      const processing = vi.spyOn(testApplication.application.get(StationLogoProcessor), 'process');
      const disguised = [
        Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64, 1)]),
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200"/></svg>'),
      ];
      for (const bytes of disguised) {
        const { completed } = await uploadFile(applicant, 'logo-uploads', { fileName: 'logo.png', contentType: 'image/png', bytes });
        expect(completed.status).toBe(400);
        expect(completed.body.error).toMatchObject({ code: 'STATION_FILE_REJECTED', fields: [{ path: 'file', code: 'wrong_file_type' }] });
      }
      const oversized = await applicant.call('post', '/application/logo-uploads', { fileName: 'logo.png', contentType: 'image/png', byteCount: 2 * 1024 * 1024 + 1 });
      expect(oversized.status).toBe(400);
      expect(fieldsOf(oversized)).toContain('byteCount');
      expect(processing).not.toHaveBeenCalled();
      expect((await stationRow(applicant.stationId)).logo_object_key).toBeNull();
    });

    it('P5A-STATION-DETAILS-11, P5A-LICENCE-09: the key is made by the server; nothing typed (file name, licence number) is part of it', async () => {
      const applicant = await signedUpApplicant();
      await applicant.call('put', '/application/licence', { licenceNumber: 'IBA/2026/7731' });
      for (const kind of ['logo-uploads', 'licence-document-uploads'] as const) {
        const started = await applicant.call('post', `/application/${kind}`, {
          fileName: 'IBA-2026-7731 Chanda private.pdf',
          contentType: kind === 'logo-uploads' ? 'image/png' : 'application/pdf',
          byteCount: 1000,
        });
        expect(started.status).toBe(201);
        const key = decodeURIComponent(new URL(started.body.uploadUrl).pathname);
        expect(key).toMatch(new RegExp(`/${applicant.stationId}/[0-9a-f-]{36}$`));
        expect(key).not.toMatch(/IBA|7731|Chanda|private/);
      }
    });
  });

  describe('step 4, the licence', () => {
    it('P5A-LICENCE-01, -02: the number is kept; a PDF of exactly 5 MB and a JPG pass', async () => {
      const applicant = await signedUpApplicant();
      expect((await applicant.call('put', '/application/licence', { licenceNumber: 'IBA/2026/0042' })).status).toBe(200);
      expect((await stationRow(applicant.stationId)).licence_number).toBe('IBA/2026/0042');

      const fiveMegabytePdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(5 * 1024 * 1024 - 9, 0x20)]);
      expect(fiveMegabytePdf.length).toBe(5 * 1024 * 1024);
      const pdf = await uploadFile(applicant, 'licence-document-uploads', { fileName: 'licence.pdf', contentType: 'application/pdf', bytes: fiveMegabytePdf });
      expect(pdf.completed.status, JSON.stringify(pdf.completed.body)).toBe(201);
      expect(pdf.completed.body.licence.document).toMatchObject({ fileName: 'licence.pdf', contentType: 'application/pdf', byteCount: 5 * 1024 * 1024 });

      const jpeg = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 250, g: 250, b: 240 } } }).jpeg().toBuffer();
      const photo = await uploadFile(applicant, 'licence-document-uploads', { fileName: 'licence.jpg', contentType: 'image/jpeg', bytes: jpeg });
      expect(photo.completed.status).toBe(201);
      expect(photo.completed.body.licence.document).toMatchObject({ fileName: 'licence.jpg', contentType: 'image/jpeg' });
    });

    it('P5A-LICENCE-02: a file one byte over 5 MB, or a Word document, is refused when the upload is asked for', async () => {
      const applicant = await signedUpApplicant();
      const tooLarge = await applicant.call('post', '/application/licence-document-uploads', { fileName: 'licence.pdf', contentType: 'application/pdf', byteCount: 5 * 1024 * 1024 + 1 });
      expect(tooLarge.status).toBe(400);
      expect(fieldsOf(tooLarge)).toContain('byteCount');
      const word = await applicant.call('post', '/application/licence-document-uploads', {
        fileName: 'licence.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        byteCount: 2000,
      });
      expect(word.status).toBe(400);
      expect(fieldsOf(word)).toContain('contentType');
    });

    it('P5A-LICENCE-03: a program renamed licence.pdf and declared a PDF is refused by its first bytes, and deleted', async () => {
      const applicant = await signedUpApplicant();
      const program = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]), Buffer.alloc(512, 0)]);
      const { started, completed } = await uploadFile(applicant, 'licence-document-uploads', { fileName: 'licence.pdf', contentType: 'application/pdf', bytes: program });
      expect(completed.status).toBe(400);
      expect(completed.body.error).toMatchObject({ code: 'STATION_FILE_REJECTED', fields: [{ path: 'file', code: 'wrong_file_type' }] });
      const key = decodeURIComponent(new URL(started.body.uploadUrl).pathname).split('/').slice(2).join('/');
      expect(await storage.describeObjectIn(storage.licenceDocumentsBucket, key)).toBeNull();
      expect((await stationRow(applicant.stationId)).licence_document_object_key).toBeNull();
    });

    it('P5A-LICENCE-07, -08: submitting needs the confirmation, then moves the station from PENDING_VERIFICATION to PENDING_REVIEW', async () => {
      const applicant = await signedUpApplicant();
      const unconfirmed = await applicant.call('post', '/application/submission', { isLicenceConfirmed: false });
      expect(unconfirmed.status).toBe(400);
      expect(fieldsOf(unconfirmed)).toContain('isLicenceConfirmed');
      expect((await stationRow(applicant.stationId)).status).toBe('PENDING_VERIFICATION');
      // The rest of a complete application, as a superuser would set it (the journey test does it through every route).
      await setupClient.query(
        `UPDATE app.stations SET name = 'Sunrise FM', frequency_label = '89.5 FM', province = 'Copperbelt', city = 'Ndola', licence_number = 'IBA/2026/0042',
                phone_verified_at = now(), email_verified_at = now() WHERE id = $1`,
        [applicant.stationId],
      );
      const pdf = Buffer.from('%PDF-1.7\n% the licence\n%%EOF\n');
      expect((await uploadFile(applicant, 'licence-document-uploads', { fileName: 'licence.pdf', contentType: 'application/pdf', bytes: pdf })).completed.status).toBe(201);
      const submitted = await applicant.call('post', '/application/submission', { isLicenceConfirmed: true });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      expect((await stationRow(applicant.stationId)).status).toBe('PENDING_REVIEW');
    });

    it('P5A-LICENCE-04, -05: once a station has its licence document, no answer to it holds the document\'s key or any address in the licence bucket', async () => {
      const withDocuments = (await setupClient.query<{ key: string }>('SELECT licence_document_object_key AS key FROM app.stations WHERE id = ANY($1) AND licence_document_object_key IS NOT NULL', [createdStationIds])).rows;
      expect(withDocuments.length).toBeGreaterThan(1);
      for (const { key } of withDocuments) {
        expect(stationFacingAnswers.filter((answer) => answer.includes(key))).toEqual([]);
        // Only its own signed upload address named it (body and headers), before the document existed.
        expect(uploadAddressAnswers.filter((answer) => answer.includes(key)).length).toBeLessThanOrEqual(2);
      }
      for (const answer of stationFacingAnswers) {
        expect(answer).not.toContain(storage.licenceDocumentsBucket);
        expect(answer).not.toContain('licence-documents/');
      }
    });
  });
});
