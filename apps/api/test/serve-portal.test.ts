import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { portalContentSecurityPolicy } from '../src/common/http/serve-portal.js';
import { APP_CONFIG, loadAppConfig, type AppConfig } from '../src/config/app-config.js';
import { assertErrorEnvelope } from './support/internal-detail-patterns.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const INDEX_HTML = '<!doctype html><html><head><title>Look Up — Station portal</title></head><body><div id="root"></div></body></html>';
const HASHED_SCRIPT = 'console.log("portal");';

/**
 * The showcase serves the built portal from the API's own address (PORTAL_STATIC_DIRECTORY), so the two share one
 * origin. A folder made here stands in for apps/portal/dist, with a secret file next to it that must never be read.
 */
describe('the API serving the built portal', () => {
  let testApplication: TestApplication;
  let config: AppConfig;
  let workFolder: string;
  const client = () => supertest(testApplication.application.getHttpServer());

  beforeAll(async () => {
    workFolder = mkdtempSync(join(tmpdir(), 'lookup-portal-'));
    const portalFolder = join(workFolder, 'dist');
    mkdirSync(join(portalFolder, 'assets'), { recursive: true });
    writeFileSync(join(portalFolder, 'index.html'), INDEX_HTML);
    writeFileSync(join(portalFolder, 'assets', 'index-B4xQ9z1k.js'), HASHED_SCRIPT);
    writeFileSync(join(portalFolder, 'assets', 'index-B4xQ9z1k.js.map'), '{"sources":["../src/main.tsx"]}');
    writeFileSync(join(portalFolder, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
    writeFileSync(join(portalFolder, '.env'), 'SECRET=never-served');
    writeFileSync(join(workFolder, 'secret.txt'), 'outside the portal');
    config = { ...loadAppConfig(), PORTAL_STATIC_DIRECTORY: portalFolder };
    testApplication = await createTestApplication({ overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config) });
  });
  afterAll(async () => {
    await testApplication.close();
    rmSync(workFolder, { recursive: true, force: true });
  });

  it('answers the portal’s page at / with the portal’s own security policy, checked again on every visit', async () => {
    const response = await client().get('/');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.text).toBe(INDEX_HTML);
    expect(response.headers['cache-control']).toBe('no-cache');
    const policy = response.headers['content-security-policy'] as string;
    const storageOrigin = new URL(config.OBJECT_STORAGE_PUBLIC_ENDPOINT).origin;
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(policy).toContain(`connect-src 'self' ${storageOrigin}`);
    expect(policy).toContain(`media-src 'self' blob: ${storageOrigin}`);
    expect(policy).toContain(`frame-src https://challenges.cloudflare.com ${storageOrigin}`);
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    // The test's portal is plain http, so nothing is upgraded; an https portal upgrades every http address.
    expect(policy).not.toContain('upgrade-insecure-requests');
    expect(portalContentSecurityPolicy('https://account.r2.cloudflarestorage.com', true)).toMatch(/; upgrade-insecure-requests$/);
  });

  it('answers every page of the portal with index.html, so a link to a station page or a sign-in link opens', async () => {
    for (const path of ['/sign-in', '/stations/0190f1a2-0000-7000-8000-000000000100/overview', '/verify-email', '/admin/applications']) {
      const response = await client().get(path);
      expect(response.status, path).toBe(200);
      expect(response.text, path).toBe(INDEX_HTML);
    }
  });

  it('serves a hashed build file to be kept for a year, and any other file to be checked again', async () => {
    const script = await client().get('/assets/index-B4xQ9z1k.js');
    expect(script.status).toBe(200);
    expect(script.text).toBe(HASHED_SCRIPT);
    expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const robots = await client().get('/robots.txt');
    expect(robots.status).toBe(200);
    expect(robots.headers['cache-control']).toBe('public, max-age=0');
  });

  it('a missing build file is a 404, not the page', async () => {
    const missing = await client().get('/assets/index-Missing01.js');
    expect(missing.status).toBe(404);
    expect(assertErrorEnvelope(missing.body).error).toMatchObject({ code: 'NOT_FOUND', request_id: missing.headers['x-request-id'] });
    expect(missing.text).not.toContain('<html');
  });

  it('never serves a source map, so the original source stays private', async () => {
    const map = await client().get('/assets/index-B4xQ9z1k.js.map');
    expect(map.status).toBe(404);
    assertErrorEnvelope(map.body);
    expect(map.text).not.toContain('sources');
  });

  it('never serves a dotfile or anything outside the portal’s folder', async () => {
    for (const path of ['/.env', '/../secret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt']) {
      const response = await client().get(path);
      expect(response.text, path).not.toContain('never-served');
      expect(response.text, path).not.toContain('outside the portal');
    }
  });

  it('leaves the API to the API: a route answers as before, an unknown one with the error envelope, and a POST is never a page', async () => {
    const health = await client().get('/api/v1/health');
    expect(health.status).toBe(200);
    expect(health.headers['content-security-policy']).not.toContain('challenges.cloudflare.com');
    const unknown = await client().get('/api/v1/no-such-route');
    expect(unknown.status).toBe(404);
    assertErrorEnvelope(unknown.body);
    const posted = await client().post('/stations/x/overview').send({});
    expect(posted.status).toBe(404);
    expect(assertErrorEnvelope(posted.body).error).toMatchObject({ code: 'NOT_FOUND', request_id: posted.headers['x-request-id'] });
    expect(posted.text).not.toContain('Cannot POST');
  });
});
