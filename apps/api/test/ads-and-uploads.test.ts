import { randomInt, randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type pg from 'pg';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../src/config/app-config.js';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { ObjectStorage } from '../src/infrastructure/object-storage/object-storage.js';
import { UPLOAD_REFUSAL_REASONS } from '@lookup/contracts';
import { m4aBytes, mp3Bytes, notAudioBytes, wavBytes } from './support/audio-fixtures.js';
import { databaseSetupClient } from './support/database-clients.js';
import { assertNoInternalDetails } from './support/internal-detail-patterns.js';
import { cookieHeader, cookiesSetBy, PORTAL_ORIGIN, type PortalTestUser, PortalTestUsers } from './support/portal-test-users.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

describe('ads and direct audio uploads', () => {
  let testApplication: TestApplication;
  let setupClient: pg.Client;
  let testUsers: PortalTestUsers;
  let objectStorage: ObjectStorage;
  const client = () => supertest(testApplication.application.getHttpServer());
  const sessions = new Map<string, Record<string, string>>();

  beforeAll(async () => {
    testApplication = await createTestApplication();
    setupClient = databaseSetupClient();
    await setupClient.connect();
    testUsers = new PortalTestUsers(setupClient, testApplication.application.get(PasswordHasher));
    objectStorage = testApplication.application.get(ObjectStorage);
  });
  afterAll(async () => {
    await testUsers.cleanUp();
    await setupClient.end();
    await testApplication.close();
  });

  function expectStatus(response: supertest.Response, httpStatus: number): supertest.Response {
    expect(response.status, JSON.stringify(response.body)).toBe(httpStatus);
    return response;
  }

  async function cookiesFor(user: PortalTestUser): Promise<Record<string, string>> {
    const existing = sessions.get(user.userId);
    if (existing) return existing;
    const response = await client()
      .post('/api/v1/auth/sign-in')
      .set('Origin', PORTAL_ORIGIN)
      .set('X-Forwarded-For', newClientAddress())
      .send({ email: user.email, password: user.password });
    const cookies = cookiesSetBy(expectStatus(response, 200));
    sessions.set(user.userId, cookies);
    return cookies;
  }

  const get = async (user: PortalTestUser, path: string) => {
    const cookies = await cookiesFor(user);
    return client().get(path).set('X-Forwarded-For', newClientAddress()).set('Cookie', cookieHeader(cookies));
  };
  const post = async (user: PortalTestUser, path: string, body: object = {}) => {
    const cookies = await cookiesFor(user);
    return client()
      .post(path)
      .set('Origin', PORTAL_ORIGIN)
      .set('X-Forwarded-For', newClientAddress())
      .set('Cookie', cookieHeader(cookies))
      .send(body);
  };

  /** An owner, their station and one client. */
  async function stationWithClient(role: 'OWNER' | 'ANALYST' = 'OWNER') {
    const owner = await testUsers.create();
    const clientResponse = expectStatus(await post(owner, `/api/v1/stations/${owner.stationId}/clients`, { name: 'Brand A' }), 201);
    const member = role === 'OWNER' ? owner : await testUsers.create({ joinStationId: owner.stationId, role });
    return { owner, member, clientId: clientResponse.body.id as string, adsPath: `/api/v1/stations/${owner.stationId}/ads` };
  }

  const uploadRequest = (bytes: Buffer, contentType = 'audio/mpeg', fileName = 'summer_offer_final.mp3') => ({
    fileName,
    contentType,
    sizeBytes: bytes.length,
  });

  const putFile = (url: string, bytes: Buffer, contentType: string) =>
    fetch(url, { method: 'PUT', body: bytes, headers: { 'Content-Type': contentType } }).then((response) => response.status);

  async function createAd(owner: PortalTestUser, adsPath: string, clientId: string, bytes: Buffer, contentType = 'audio/mpeg') {
    const response = expectStatus(
      await post(owner, adsPath, { clientId, title: 'Summer service offer', upload: uploadRequest(bytes, contentType) }),
      201,
    );
    return response.body as { adId: string; upload: { method: string; url: string; headers: Record<string, string>; expiresAt: string } };
  }

  async function adRow(adId: string) {
    return (
      await setupClient.query(
        'SELECT status, processing_error_code, upload_object_key, upload_entity_tag, upload_original_file_name FROM app.ads WHERE id = $1',
        [adId],
      )
    ).rows[0];
  }

  describe('creating an ad and its upload URL', () => {
    it('signs exactly Content-Type and Content-Length for 10 minutes, with no checksum parameters, and audits it', async () => {
      const { owner, clientId, adsPath } = await stationWithClient();
      const created = await createAd(owner, adsPath, clientId, mp3Bytes());
      expect(created.upload.method).toBe('PUT');
      expect(created.upload.headers).toEqual({ 'Content-Type': 'audio/mpeg' });
      const signedUrl = new URL(created.upload.url);
      expect(signedUrl.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
      expect(signedUrl.searchParams.get('X-Amz-Expires')).toBe('600');
      expect(created.upload.url).not.toMatch(/x-amz-checksum|x-amz-sdk-checksum-algorithm/i);
      // The key is made by the server: station and ad ids, never the station's file name.
      expect(signedUrl.pathname).toMatch(new RegExp(`/ad-uploads/${owner.stationId}/${created.adId}/[0-9a-f-]{36}$`));
      expect((await adRow(created.adId)).status).toBe('AWAITING_UPLOAD');
      const audit = await setupClient.query(`SELECT action, changes FROM app.audit_events WHERE entity_id = $1`, [created.adId]);
      expect(audit.rows).toEqual([
        {
          action: 'ad_created',
          changes: {
            title: 'Summer service offer',
            clientId,
            upload: { fileName: 'summer_offer_final.mp3', contentType: 'audio/mpeg', sizeBytes: 2048 },
          },
        },
      ]);
    });

    it('keeps only a clean last path segment of the file name, for display', async () => {
      const { owner, clientId, adsPath } = await stationWithClient();
      const bytes = mp3Bytes();
      const response = expectStatus(
        await post(owner, adsPath, {
          clientId,
          title: 'Path trick',
          upload: { fileName: '..\\..\\windows\\system32\\evil‮play.mp3', contentType: 'audio/mpeg', sizeBytes: bytes.length },
        }),
        201,
      );
      expect((await adRow(response.body.adId)).upload_original_file_name).toBe('evilplay.mp3');
    });

    it('refuses an unknown client, a client of another station, files over 20 MiB and unsupported types, naming the field', async () => {
      const { owner, clientId, adsPath } = await stationWithClient();
      const other = await stationWithClient();
      const bytes = mp3Bytes();
      const cases: Array<[object, Array<{ path: string; code: string }>]> = [
        [{ clientId: randomUUID(), title: 'x', upload: uploadRequest(bytes) }, [{ path: 'clientId', code: 'unknown_client' }]],
        [{ clientId: other.clientId, title: 'x', upload: uploadRequest(bytes) }, [{ path: 'clientId', code: 'unknown_client' }]],
        [{ clientId, title: 'x', upload: { ...uploadRequest(bytes), sizeBytes: 20 * 1024 * 1024 + 1 } }, [{ path: 'upload.sizeBytes', code: 'too_big' }]],
        [{ clientId, title: 'x', upload: { ...uploadRequest(bytes), contentType: 'text/html' } }, [{ path: 'upload.contentType', code: 'invalid_value' }]],
        [{ clientId, title: ' ', upload: uploadRequest(bytes) }, [{ path: 'title', code: 'too_small' }]],
      ];
      for (const [body, expectedFields] of cases) {
        const refused = expectStatus(await post(owner, adsPath, body), 400);
        expect(refused.body.error.fields).toEqual(expectedFields);
      }
    });
  });

  describe('what the storage itself refuses', () => {
    it('accepts the exact file, and refuses a bigger file, a smaller file and another type', async () => {
      const { owner, clientId, adsPath } = await stationWithClient();
      const bytes = mp3Bytes(4096);
      const signed = (await createAd(owner, adsPath, clientId, bytes)).upload.url;
      expect(await putFile(signed, mp3Bytes(4097), 'audio/mpeg')).toBe(403);
      expect(await putFile(signed, mp3Bytes(4095), 'audio/mpeg')).toBe(403);
      expect(await putFile(signed, bytes, 'text/html')).toBe(403);
      expect(await putFile(signed, bytes, 'audio/mpeg')).toBe(200);
    });

    it('refuses an upload once its URL has expired', async () => {
      const bytes = mp3Bytes();
      const shortLivedUrl = await objectStorage.createUploadUrl(`ad-uploads/expiry-test/${randomUUID()}`, 'audio/mpeg', bytes.length, 1);
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      expect(await putFile(shortLivedUrl, bytes, 'audio/mpeg')).toBe(403);
    });

    it('lets the portal origin, and only it, upload from a browser (CORS preflight)', async () => {
      const { owner, clientId, adsPath } = await stationWithClient();
      const signed = (await createAd(owner, adsPath, clientId, mp3Bytes())).upload.url;
      const preflight = (origin: string) =>
        fetch(signed, {
          method: 'OPTIONS',
          headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' },
        });
      expect((await preflight(PORTAL_ORIGIN)).headers.get('access-control-allow-origin')).toBe(PORTAL_ORIGIN);
      expect((await preflight('https://other-site.example')).headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  describe('completing an upload', () => {
    it.each([
      ['MP3', mp3Bytes(), 'audio/mpeg'],
      ['WAV', wavBytes(), 'audio/wav'],
      ['M4A', m4aBytes(), 'audio/mp4'],
    ])('accepts a real %s file, moves the ad to processing, audits it, and is safe to repeat', async (_format, bytes, contentType) => {
      const { owner, clientId, adsPath } = await stationWithClient();
      const created = await createAd(owner, adsPath, clientId, bytes, contentType);
      expect(await putFile(created.upload.url, bytes, contentType)).toBe(200);
      const completed = expectStatus(await post(owner, `${adsPath}/${created.adId}/complete`), 200);
      expect(completed.body).toMatchObject({ id: created.adId, status: 'PROCESSING', client: { id: clientId, name: 'Brand A' } });
      expect((await adRow(created.adId)).upload_entity_tag).toMatch(/^"?[0-9a-f]{32}"?$/);
      expectStatus(await post(owner, `${adsPath}/${created.adId}/complete`), 200);
      const verifiedAudits = await setupClient.query(
        `SELECT 1 FROM app.audit_events WHERE entity_id = $1 AND action = 'ad_upload_verified'`,
        [created.adId],
      );
      expect(verifiedAudits.rowCount).toBe(1);
    });

    it('a file that is not really audio is refused, deleted from storage, and the ad marked FAILED with the reason', async () => {
      const { owner, clientId, adsPath } = await stationWithClient();
      const disguised = notAudioBytes();
      const created = await createAd(owner, adsPath, clientId, disguised);
      expect(await putFile(created.upload.url, disguised, 'audio/mpeg')).toBe(200);
      const objectKey = (await adRow(created.adId)).upload_object_key as string;
      const refused = expectStatus(await post(owner, `${adsPath}/${created.adId}/complete`), 400);
      expect(refused.body.error.code).toBe('UPLOAD_REJECTED');
      assertNoInternalDetails(refused.body);
      expect(JSON.stringify(refused.body)).not.toMatch(/S3|Bucket|x-amz|versity/i);
      expect(await adRow(created.adId)).toMatchObject({ status: 'FAILED', processing_error_code: 'not_the_declared_audio_format' });
      expect(await objectStorage.describeObject(objectKey)).toBeNull();
      // S2-ADS-10: the station sees why, as one of the shared contract's codes.
      const detail = expectStatus(await get(owner, `${adsPath}/${created.adId}`), 200).body;
      expect(detail).toMatchObject({ status: 'FAILED', processingErrorCode: 'not_the_declared_audio_format' });
      expect(UPLOAD_REFUSAL_REASONS).toContain(detail.processingErrorCode);
    });

    it('an object that differs from what was declared (written around the signed URL) is refused', async () => {
      const { owner, clientId, adsPath } = await stationWithClient();
      const created = await createAd(owner, adsPath, clientId, mp3Bytes(2048));
      const objectKey = (await adRow(created.adId)).upload_object_key as string;
      const config = testApplication.application.get<AppConfig>(APP_CONFIG);
      const directClient = new S3Client({
        region: config.OBJECT_STORAGE_REGION,
        endpoint: config.OBJECT_STORAGE_ENDPOINT,
        forcePathStyle: true,
        credentials: { accessKeyId: config.OBJECT_STORAGE_ACCESS_KEY_ID, secretAccessKey: config.OBJECT_STORAGE_SECRET_ACCESS_KEY },
      });
      await directClient.send(
        new PutObjectCommand({ Bucket: config.OBJECT_STORAGE_AD_UPLOADS_BUCKET, Key: objectKey, Body: mp3Bytes(9000), ContentType: 'audio/mpeg' }),
      );
      directClient.destroy();
      expectStatus(await post(owner, `${adsPath}/${created.adId}/complete`), 400);
      expect(await adRow(created.adId)).toMatchObject({ status: 'FAILED', processing_error_code: 'size_or_type_mismatch' });
    });

    it('completing before the file has arrived says so and leaves the ad waiting', async () => {
      const { owner, clientId, adsPath } = await stationWithClient();
      const created = await createAd(owner, adsPath, clientId, mp3Bytes());
      const notYet = expectStatus(await post(owner, `${adsPath}/${created.adId}/complete`), 409);
      expect(notYet.body.error.code).toBe('UPLOAD_NOT_RECEIVED');
      expect((await adRow(created.adId)).status).toBe('AWAITING_UPLOAD');
    });

    it('after a refused file the station can upload again with a fresh URL', async () => {
      const { owner, clientId, adsPath } = await stationWithClient();
      const created = await createAd(owner, adsPath, clientId, notAudioBytes());
      await putFile(created.upload.url, notAudioBytes(), 'audio/mpeg');
      expectStatus(await post(owner, `${adsPath}/${created.adId}/complete`), 400);
      const realFile = wavBytes(3000);
      const retry = expectStatus(
        await post(owner, `${adsPath}/${created.adId}/upload-url`, { upload: uploadRequest(realFile, 'audio/wav', 'fixed.wav') }),
        200,
      );
      expect((await adRow(created.adId)).status).toBe('AWAITING_UPLOAD');
      expect(await putFile(retry.body.url, realFile, 'audio/wav')).toBe(200);
      expect(expectStatus(await post(owner, `${adsPath}/${created.adId}/complete`), 200).body.status).toBe('PROCESSING');
      const again = expectStatus(await post(owner, `${adsPath}/${created.adId}/upload-url`, { upload: uploadRequest(realFile, 'audio/wav') }), 409);
      expect(again.body.error.message).toBe("This ad's audio has already been uploaded and checked.");
    });
  });

  describe('playing an ad back', () => {
    it('gives a short-lived URL once the upload is verified, and not before', async () => {
      const { owner, clientId, adsPath } = await stationWithClient();
      const bytes = mp3Bytes(3333);
      const created = await createAd(owner, adsPath, clientId, bytes);
      expectStatus(await get(owner, `${adsPath}/${created.adId}/playback-url`), 409);
      await putFile(created.upload.url, bytes, 'audio/mpeg');
      expectStatus(await post(owner, `${adsPath}/${created.adId}/complete`), 200);
      const playback = expectStatus(await get(owner, `${adsPath}/${created.adId}/playback-url`), 200);
      expect(new URL(playback.body.url).searchParams.get('X-Amz-Expires')).toBe('300');
      const downloaded = await fetch(playback.body.url);
      expect(downloaded.status).toBe(200);
      expect(Buffer.from(await downloaded.arrayBuffer()).equals(bytes)).toBe(true);
    });
  });

  describe('listing ads', () => {
    it('pages 20 at a time, newest change first, with no ad missing or repeated', async () => {
      const { owner, clientId, adsPath } = await stationWithClient();
      const createdIds: string[] = [];
      for (let adNumber = 0; adNumber < 21; adNumber++) createdIds.push((await createAd(owner, adsPath, clientId, mp3Bytes())).adId);
      const firstPage = expectStatus(await get(owner, adsPath), 200).body;
      expect(firstPage.ads).toHaveLength(20);
      expect(firstPage.nextCursor).toEqual(expect.any(String));
      const secondPage = expectStatus(await get(owner, `${adsPath}?cursor=${firstPage.nextCursor}`), 200).body;
      expect(secondPage.ads).toHaveLength(1);
      expect(secondPage.nextCursor).toBeNull();
      const listedIds = [...firstPage.ads, ...secondPage.ads].map((ad: { id: string }) => ad.id);
      expect(new Set(listedIds).size).toBe(21);
      expect(listedIds.sort()).toEqual([...createdIds].sort());
      expect(firstPage.ads[0].id).toBe(createdIds[20]);
    });

    it('refuses a malformed cursor', async () => {
      const { owner, adsPath } = await stationWithClient();
      const refused = expectStatus(await get(owner, `${adsPath}?cursor=not-a-cursor`), 400);
      expect(refused.body.error.fields).toEqual([{ path: 'cursor', code: 'invalid_cursor' }]);
    });
  });

  describe('who can see and change ads', () => {
    it("another station gets 404 on every one of this station's ads", async () => {
      const { owner, clientId, adsPath } = await stationWithClient();
      const created = await createAd(owner, adsPath, clientId, mp3Bytes());
      const outsider = await testUsers.create();
      const outsiderPath = `/api/v1/stations/${outsider.stationId}/ads/${created.adId}`;
      for (const response of [
        await get(outsider, outsiderPath),
        await post(outsider, `${outsiderPath}/complete`),
        await post(outsider, `${outsiderPath}/upload-url`, { upload: uploadRequest(mp3Bytes()) }),
        await get(outsider, `${outsiderPath}/playback-url`),
        await get(outsider, `${adsPath}/${created.adId}`),
        await get(owner, `${adsPath}/not-a-uuid`),
      ]) {
        expectStatus(response, 404);
      }
    });

    it('an analyst can list and read ads but not create one or complete an upload', async () => {
      const { owner, member: analyst, clientId, adsPath } = await stationWithClient('ANALYST');
      const created = await createAd(owner, adsPath, clientId, mp3Bytes());
      expectStatus(await get(analyst, adsPath), 200);
      expectStatus(await get(analyst, `${adsPath}/${created.adId}`), 200);
      expectStatus(await post(analyst, adsPath, { clientId, title: 'x', upload: uploadRequest(mp3Bytes()) }), 403);
      expectStatus(await post(analyst, `${adsPath}/${created.adId}/complete`), 403);
    });
  });
});
