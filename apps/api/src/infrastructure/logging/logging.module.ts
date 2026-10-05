import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { ConfigModule, LOG_DESTINATION } from '../../config/config.module.js';
import { serializeErrorForLog } from './serialize-error-for-log.js';

/**
 * Anything that could identify a person or unlock an account is removed before a line is
 * written. Paths cover the request log and any object we log ourselves.
 */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.refreshToken',
  '*.email',
  '*.phoneNumber',
  '*.phoneNumberE164',
  '*.audio',
  '*.audioBase64',
  '*.accessToken',
  '*.refreshTokenHash',
  '*.computedPasswordHash',
  '*.currentPassword',
  '*.newPassword',
  '*.deviceCookie',
  '*.uploadUrl',
  '*.playbackUrl',
];

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [APP_CONFIG, LOG_DESTINATION],
      useFactory: (config: AppConfig, destination: DestinationStream) => ({
        // Fields added during a request (the signed-in actor) also go on its "request completed" line.
        assignResponse: true,
        pinoHttp: [
          {
            level: config.LOG_LEVEL,
            base: { service: 'lookup-api' },
            redact: { paths: REDACTED_LOG_PATHS, censor: '[redacted]' },
            genReqId: (request) => (request as { id?: string }).id ?? 'unknown',
            serializers: {
              // Errors never carry the values a query was sent (see serializeErrorForLog).
              err: serializeErrorForLog,
              // Request lines carry method, path and status only; bodies and query strings (which
              // can hold tokens or personal data) are logged only behind LOG_REQUEST_DETAILS.
              ...(config.LOG_REQUEST_DETAILS
                ? {}
                : {
                    req: (request: { id?: string; method?: string; url?: string }) => ({
                      id: request.id,
                      method: request.method,
                      path: request.url?.split('?')[0],
                    }),
                    res: (response: { statusCode?: number }) => ({ statusCode: response.statusCode }),
                  }),
            },
            customProps: () => ({}),
            autoLogging: { ignore: (request) => request.url === '/api/v1/health' },
          },
          destination,
        ],
      }),
    }),
  ],
})
export class LoggingModule {}
