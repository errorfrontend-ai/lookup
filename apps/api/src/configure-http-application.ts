import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { AppConfig } from './config/app-config.js';
import { assignRequestId } from './common/http/assign-request-id.js';
import { mapBodyParserErrors } from './common/http/map-body-parser-errors.js';
import { preventResponseCaching } from './common/http/prevent-response-caching.js';
import { rejectCrossSiteCookieRequests } from './common/http/reject-cross-site-cookie-requests.js';
import { limitRequestsPerClientAddress } from './common/rate-limiting/limit-requests-per-client-address.js';
import { RateLimiter } from './common/rate-limiting/rate-limiter.js';

/**
 * HTTP setup shared by the real server and the tests, so tests exercise exactly what runs.
 * Order matters:
 *  1. request id first, so every later step (logs, errors) can carry it;
 *  2. security headers and CORS before anything that can reject, so browsers can read our errors;
 *  3. cheap rejections (rate limit, cross-site check) before the body is read;
 *  4. the body parser, with its error mapper straight after it.
 * Anything rejected goes to the central exception filter: one log format, one public envelope.
 */
export function configureHttpApplication(application: NestExpressApplication, config: AppConfig): void {
  application.set('trust proxy', config.TRUSTED_PROXY_COUNT); // so rate limits see the client, not the proxy
  application.disable('x-powered-by');
  application.use(assignRequestId);
  application.use(helmet());
  application.enableCors({ origin: [...config.ALLOWED_BROWSER_ORIGINS], credentials: true, maxAge: 600 });
  application.use(preventResponseCaching);
  application.use(limitRequestsPerClientAddress(application.get(RateLimiter), config.RATE_LIMIT_REQUESTS_PER_MINUTE));
  application.use(cookieParser());
  application.use(rejectCrossSiteCookieRequests(config.ALLOWED_BROWSER_ORIGINS));
  application.useBodyParser('json', { limit: '100kb' });
  application.use(mapBodyParserErrors);
  application.setGlobalPrefix('api/v1');
  applyServerTimeouts(application.getHttpServer() as Server);
}

/** Cut off clients that send headers or bodies too slowly to hold connections open (slowloris). */
export function applyServerTimeouts(server: Server): void {
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000; // whole request: a 256 KB clip on a slow 2G link still fits
  server.keepAliveTimeout = 65_000; // longer than the proxy's idle timeout, or it sees resets
  server.maxHeadersCount = 100;
}
