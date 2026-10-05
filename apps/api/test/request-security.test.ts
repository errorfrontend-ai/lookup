import { randomInt } from 'node:crypto';
import type { Server } from 'node:http';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/common/errors/app-error.js';
import { RateLimiter } from '../src/common/rate-limiting/rate-limiter.js';
import type { DerivedKeys } from '../src/common/security/derived-keys.js';
import { APP_CONFIG, loadAppConfig } from '../src/config/app-config.js';
import { FailureRoutesModule } from './support/failure-routes.module.js';
import { assertNoInternalDetails } from './support/internal-detail-patterns.js';
import { waitForLogWrites } from './support/log-capture.js';
import { createTestApplication, type TestApplication } from './support/test-application.js';

const PORTAL_ORIGIN = 'http://localhost:5180';
const OTHER_SITE_ORIGIN = 'https://other-site.example';
const BASELINE_REQUESTS_PER_MINUTE = 20; // production default: 300

/** A fresh client address, so each test has its own rate-limit counters (reruns included). */
const newClientAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

describe('request-layer security', () => {
  let testApplication: TestApplication;
  const client = () => supertest(testApplication.application.getHttpServer());

  beforeAll(async () => {
    const config = {
      ...loadAppConfig(),
      RATE_LIMIT_REQUESTS_PER_MINUTE: BASELINE_REQUESTS_PER_MINUTE,
      ALLOWED_BROWSER_ORIGINS: [PORTAL_ORIGIN],
    };
    testApplication = await createTestApplication({
      extraModules: [FailureRoutesModule],
      overrideProviders: (builder) => builder.overrideProvider(APP_CONFIG).useValue(config),
    });
  });
  afterAll(async () => testApplication.close());

  function expectErrorEnvelope(response: supertest.Response, httpStatus: number, code: string) {
    expect(response.status).toBe(httpStatus);
    expect(response.body.error.code).toBe(code);
    expect(response.body.error.request_id).toBe(response.headers['x-request-id']);
    assertNoInternalDetails(response.body);
  }

  describe('response headers', () => {
    it('sends security headers, forbids caching, and hides the framework', async () => {
      const response = await client().get('/api/v1/health').set('X-Forwarded-For', newClientAddress()).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['strict-transport-security']).toMatch(/max-age=\d+/);
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(response.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('cross-origin requests (CORS)', () => {
    it('allows the portal origin with credentials, and nobody else', async () => {
      const clientAddress = newClientAddress();
      const fromPortal = await client().get('/api/v1/health').set('X-Forwarded-For', clientAddress).set('Origin', PORTAL_ORIGIN);
      expect(fromPortal.headers['access-control-allow-origin']).toBe(PORTAL_ORIGIN);
      expect(fromPortal.headers['access-control-allow-credentials']).toBe('true');
      const fromOtherSite = await client()
        .get('/api/v1/health')
        .set('X-Forwarded-For', clientAddress)
        .set('Origin', OTHER_SITE_ORIGIN);
      expect(fromOtherSite.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('error responses carry CORS headers too, so the portal can show the request id', async () => {
      const response = await client()
        .post('/api/v1/test-only/echo')
        .set('X-Forwarded-For', newClientAddress())
        .set('Origin', PORTAL_ORIGIN)
        .set('Content-Type', 'application/json')
        .send('{"broken": ');
      expectErrorEnvelope(response, 400, 'INVALID_JSON');
      expect(response.headers['access-control-allow-origin']).toBe(PORTAL_ORIGIN);
    });
  });

  describe('cross-site request forgery (cookie requests)', () => {
    const postEcho = (clientAddress: string) =>
      client().post('/api/v1/test-only/echo').set('X-Forwarded-For', clientAddress).send({ example: 1 });

    it('refuses a cookie-carrying write from another site, and logs why', async () => {
      const response = await postEcho(newClientAddress()).set('Cookie', 'session=example').set('Origin', OTHER_SITE_ORIGIN);
      expectErrorEnvelope(response, 403, 'FORBIDDEN');
      await waitForLogWrites();
      const logLine = testApplication.logs.find((line) => line.requestId === response.body.error.request_id);
      expect(logLine?.detail).toContain('cross-site check');
    });

    it('refuses a cookie-carrying write with no origin at all', async () => {
      expectErrorEnvelope(await postEcho(newClientAddress()).set('Cookie', 'session=example'), 403, 'FORBIDDEN');
    });

    it('allows cookie writes from the portal (Origin or Referer)', async () => {
      const clientAddress = newClientAddress();
      await postEcho(clientAddress).set('Cookie', 'session=example').set('Origin', PORTAL_ORIGIN).expect(201);
      await postEcho(clientAddress).set('Cookie', 'session=example').set('Referer', `${PORTAL_ORIGIN}/station/ads`).expect(201);
    });

    it('does not affect the mobile app (no cookies) or methods without side effects', async () => {
      const clientAddress = newClientAddress();
      await postEcho(clientAddress).expect(201);
      await client()
        .get('/api/v1/health')
        .set('X-Forwarded-For', clientAddress)
        .set('Cookie', 'session=example')
        .set('Origin', OTHER_SITE_ORIGIN)
        .expect(200);
    });
  });

  describe('input validation', () => {
    const postValidated = (body: unknown) =>
      client().post('/api/v1/test-only/validated').set('X-Forwarded-For', newClientAddress()).send(body as object);

    it('passes valid input through, parsed', async () => {
      const response = await postValidated({ name: 'Brand A', count: 2 }).expect(201);
      expect(response.body).toEqual({ name: 'Brand A', count: 2 });
    });

    it('rejects unknown fields without echoing their names', async () => {
      const response = await postValidated({ name: 'Brand A', count: 2, isSuperAdmin: true });
      expectErrorEnvelope(response, 400, 'VALIDATION_FAILED');
      expect(response.body.error.fields).toEqual([{ path: '', code: 'unrecognized_keys' }]);
      expect(JSON.stringify(response.body)).not.toContain('isSuperAdmin');
    });

    it('names the bad field and a reason code, never the submitted value', async () => {
      const response = await postValidated({ name: 'Brand A', count: 'lots<script>' });
      expectErrorEnvelope(response, 400, 'VALIDATION_FAILED');
      expect(response.body.error.fields).toEqual([{ path: 'count', code: 'invalid_type' }]);
      expect(JSON.stringify(response.body)).not.toContain('lots');
    });

    it('rejects a missing body', async () => {
      const response = await client().post('/api/v1/test-only/validated').set('X-Forwarded-For', newClientAddress());
      expectErrorEnvelope(response, 400, 'VALIDATION_FAILED');
    });
  });

  describe('rate limits', () => {
    it('a route limit returns 429 with Retry-After, per client', async () => {
      const clientAddress = newClientAddress();
      for (let requestNumber = 0; requestNumber < 3; requestNumber++) {
        await client().get('/api/v1/test-only/rate-limited').set('X-Forwarded-For', clientAddress).expect(200);
      }
      const response = await client().get('/api/v1/test-only/rate-limited').set('X-Forwarded-For', clientAddress);
      expectErrorEnvelope(response, 429, 'RATE_LIMITED');
      expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(60);
      await client().get('/api/v1/test-only/rate-limited').set('X-Forwarded-For', newClientAddress()).expect(200);
    });

    it('the baseline limit covers every URL, unknown ones included', async () => {
      const clientAddress = newClientAddress();
      for (let requestNumber = 0; requestNumber < BASELINE_REQUESTS_PER_MINUTE; requestNumber++) {
        await client().get('/api/v1/no-such-route').set('X-Forwarded-For', clientAddress).expect(404);
      }
      expectErrorEnvelope(await client().get('/api/v1/no-such-route').set('X-Forwarded-For', clientAddress), 429, 'RATE_LIMITED');
      expectErrorEnvelope(await client().get('/api/v1/health').set('X-Forwarded-For', clientAddress), 429, 'RATE_LIMITED');
      await client().get('/api/v1/health').set('X-Forwarded-For', newClientAddress()).expect(200);
    });
  });

  describe('slow-client protection', () => {
    it('sets header, request and keep-alive timeouts', () => {
      const server = testApplication.application.getHttpServer() as Server;
      expect(server.headersTimeout).toBe(20_000);
      expect(server.requestTimeout).toBe(60_000);
      expect(server.keepAliveTimeout).toBe(65_000);
    });
  });
});

describe('rate limiter when its store is unreachable', () => {
  const unreachableKeyValueStore = { eval: () => Promise.reject(new Error('connect ECONNREFUSED')) } as unknown as Redis;
  const response = { setHeader: vi.fn() } as unknown as Response;
  const quietLogger = () => ({ setContext: vi.fn(), warn: vi.fn() });
  const derivedKeys = { hashIdentifier: (identifier: string) => identifier } as unknown as DerivedKeys;

  it('refuses requests for counters marked to refuse (e.g. sign-in)', async () => {
    const rateLimiter = new RateLimiter(unreachableKeyValueStore, quietLogger() as unknown as PinoLogger, derivedKeys);
    const rule = { counterName: 'sign-in', maximumRequests: 5, windowSeconds: 60, refuseWhenStoreUnavailable: true };
    const error = await rateLimiter.countRequest(rule, '192.0.2.4', response).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('allows other requests through and logs a warning', async () => {
    const logger = quietLogger();
    const rateLimiter = new RateLimiter(unreachableKeyValueStore, logger as unknown as PinoLogger, derivedKeys);
    const rule = { counterName: 'client-address', maximumRequests: 5, windowSeconds: 60 };
    await expect(rateLimiter.countRequest(rule, '192.0.2.4', response)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
