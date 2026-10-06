import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { AuditModule } from './common/audit/audit.module.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { RateLimitingModule } from './common/rate-limiting/rate-limiting.module.js';
import { SecurityModule } from './common/security/security.module.js';
import { ConfigModule } from './config/config.module.js';
import { ActionCardsModule } from './features/action-cards/action-cards.module.js';
import { AdsModule } from './features/ads/ads.module.js';
import { AuthenticationModule } from './features/authentication/authentication.module.js';
import { ClientErrorsModule } from './features/client-errors/client-errors.module.js';
import { CampaignsModule } from './features/campaigns/campaigns.module.js';
import { ClientsModule } from './features/clients/clients.module.js';
import { HealthModule } from './features/health/health.module.js';
import { StationOverviewModule } from './features/station-overview/station-overview.module.js';
import { StationsModule } from './features/stations/stations.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { KeyValueStoreModule } from './infrastructure/key-value-store/key-value-store.module.js';
import { LoggingModule } from './infrastructure/logging/logging.module.js';
import { ObjectStorageModule } from './infrastructure/object-storage/object-storage.module.js';

@Module({
  imports: [
    // Infrastructure every feature relies on.
    ConfigModule,
    LoggingModule,
    // Request-scoped context: the request id, the signed-in user and session, and the station being worked on.
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true, generateId: true, idGenerator: (request) => (request as { id?: string }).id ?? 'unknown' },
    }),
    DatabaseModule,
    KeyValueStoreModule,
    ObjectStorageModule,
    SecurityModule,
    RateLimitingModule,
    AuditModule,
    // Features. AuthenticationModule also installs the guard that makes every route private by default.
    AuthenticationModule,
    HealthModule,
    StationsModule,
    ClientsModule,
    AdsModule,
    ActionCardsModule,
    CampaignsModule,
    StationOverviewModule,
    ClientErrorsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
