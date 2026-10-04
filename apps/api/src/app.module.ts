import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { RateLimitingModule } from './common/rate-limiting/rate-limiting.module.js';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './features/health/health.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { KeyValueStoreModule } from './infrastructure/key-value-store/key-value-store.module.js';
import { LoggingModule } from './infrastructure/logging/logging.module.js';

@Module({
  imports: [
    // Infrastructure every feature relies on.
    ConfigModule,
    LoggingModule,
    // Request-scoped context (request id now; station and user ids once sign-in lands in step 2).
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true, generateId: true, idGenerator: (request) => (request as { id?: string }).id ?? 'unknown' },
    }),
    DatabaseModule,
    KeyValueStoreModule,
    RateLimitingModule,
    // Features.
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
