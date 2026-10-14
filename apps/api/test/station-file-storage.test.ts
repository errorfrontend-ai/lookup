import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectStorage } from '../src/infrastructure/object-storage/object-storage.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

/**
 * Phase 5a's private buckets (P5A design §3.1; P5A-LICENCE-03..05): an upload goes in through a signed PUT that fixes
 * its type and length; a stored file comes out only through a short link whose answer has the type the API chose and
 * an inline disposition, so a file can never be served as a page.
 */
describe('licence document and logo storage', () => {
  let testApplication: TestApplication;
  let storage: ObjectStorage;
  const created: Array<[string, string]> = [];

  beforeAll(async () => {
    testApplication = await createTestApplication();
    storage = testApplication.application.get(ObjectStorage);
  });
  afterAll(async () => {
    for (const [bucket, key] of created) await storage.deleteObjectIn(bucket, key).catch(() => undefined);
    await testApplication.close();
  });

  const pdf = Buffer.from('%PDF-1.7\n% a licence for the tests\n%%EOF\n');

  it('a signed PUT stores a file in the licence bucket only with the type and length it was signed for', async () => {
    const key = `licence-documents/${randomUUID()}/${randomUUID()}`;
    created.push([storage.licenceDocumentsBucket, key]);
    const address = await storage.createUploadUrlIn(storage.licenceDocumentsBucket, key, 'application/pdf', pdf.length, 600);
    const wrongType = await fetch(address, { method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: pdf });
    expect(wrongType.ok).toBe(false);
    const stored = await fetch(address, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: pdf });
    expect(stored.status).toBe(200);
    expect(await storage.describeObjectIn(storage.licenceDocumentsBucket, key)).toMatchObject({ sizeBytes: pdf.length, contentType: 'application/pdf' });
    expect(await storage.describeObjectIn(storage.adUploadsBucket, key)).toBeNull();
  });

  it.each([
    ['licence', 'licenceDocumentsBucket', 'application/pdf'],
    ['logo', 'stationLogosBucket', 'image/png'],
  ] as const)('P5A-LICENCE-09, P5A-STATION-DETAILS-11: the %s bucket itself refuses a PUT longer than signed, of another type, or after the address expired', async (_name, bucketName, contentType) => {
    const bucket = storage[bucketName];
    const key = `checks/${randomUUID()}/${randomUUID()}`;
    created.push([bucket, key]);
    const signed = await storage.createUploadUrlIn(bucket, key, contentType, pdf.length, 600);
    const longer = await fetch(signed, { method: 'PUT', headers: { 'Content-Type': contentType }, body: Buffer.concat([pdf, Buffer.from('x')]) });
    expect(longer.ok).toBe(false);
    const otherType = await fetch(signed, { method: 'PUT', headers: { 'Content-Type': 'image/svg+xml' }, body: pdf });
    expect(otherType.ok).toBe(false);
    expect(await storage.describeObjectIn(bucket, key)).toBeNull();

    const shortLived = await storage.createUploadUrlIn(bucket, key, contentType, pdf.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const late = await fetch(shortLived, { method: 'PUT', headers: { 'Content-Type': contentType }, body: pdf });
    expect(late.status).toBe(403);
    expect(await storage.describeObjectIn(bucket, key)).toBeNull();
  });

  it('P5A-LICENCE-04: a stored licence document cannot be read without a signed link', async () => {
    const key = `licence-documents/${randomUUID()}/${randomUUID()}`;
    created.push([storage.licenceDocumentsBucket, key]);
    await storage.putObjectIn(storage.licenceDocumentsBucket, key, pdf, 'application/pdf');
    const signed = new URL(await storage.createDownloadUrlIn(storage.licenceDocumentsBucket, key, 300, { contentType: 'application/pdf', fileName: 'licence.pdf' }));
    const unsigned = await fetch(`${signed.origin}${signed.pathname}`);
    expect(unsigned.status).toBe(403);
    expect(Buffer.from(await unsigned.arrayBuffer()).includes(Buffer.from('%PDF'))).toBe(false);
    expect((await fetch(signed)).status).toBe(200);
  });

  it('a download link fixes the type and an inline disposition, whatever the file was stored as, with a safe file name', async () => {
    const key = `licence-documents/${randomUUID()}/${randomUUID()}`;
    created.push([storage.licenceDocumentsBucket, key]);
    await storage.putObjectIn(storage.licenceDocumentsBucket, key, Buffer.from('<html><script>alert(1)</script></html>'), 'text/html');
    const address = await storage.createDownloadUrlIn(storage.licenceDocumentsBucket, key, 300, {
      contentType: 'application/pdf',
      fileName: 'Licence "2026"\r\n<script>.pdf',
    });
    const answer = await fetch(address);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('application/pdf');
    expect(answer.headers.get('content-disposition')).toBe('inline; filename="Licence 2026script.pdf"');
    expect(new URL(address).searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('the logo bucket takes a processed logo and serves it back', async () => {
    const key = `station-logos/${randomUUID()}/${randomUUID()}.webp`;
    created.push([storage.stationLogosBucket, key]);
    const webp = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1');
    await storage.putObjectIn(storage.stationLogosBucket, key, webp, 'image/webp');
    const facts = await storage.describeObjectIn(storage.stationLogosBucket, key);
    expect(facts).toMatchObject({ sizeBytes: webp.length, contentType: 'image/webp' });
    expect(await storage.readObjectIn(storage.stationLogosBucket, key, facts?.entityTag ?? '')).toEqual(webp);
    await storage.deleteObjectIn(storage.stationLogosBucket, key);
    expect(await storage.describeObjectIn(storage.stationLogosBucket, key)).toBeNull();
  });
});
