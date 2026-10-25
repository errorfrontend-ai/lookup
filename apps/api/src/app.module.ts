import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { AuditModule } from './common/audit/audit.module.js';
import { ListenerAuthenticationModule } from './common/listener-authentication/listener-authentication.module.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';
import { RateLimitingModule } from './common/rate-limiting/rate-limiting.module.js';
import { SecurityModule } from './common/security/security.module.js';
import { ClockModule } from './common/time/clock.js';
import { ConfigModule } from './config/config.module.js';
import { ActionCardsModule } from './features/action-cards/action-cards.module.js';
import { AdminModule } from './features/admin/admin.module.js';
import { AdHistoryModule } from './features/ad-history/ad-history.module.js';
import { AdsModule } from './features/ads/ads.module.js';
import { AuthenticationModule } from './features/authentication/authentication.module.js';
import { ClientErrorsModule } from './features/client-errors/client-errors.module.js';
import { CampaignsModule } from './features/campaigns/campaigns.module.js';
import { ClientsModule } from './features/clients/clients.module.js';
import { ClientViewersModule } from './features/client-viewers/client-viewers.module.js';
import { AirTimeRemindersModule } from './features/air-time-reminders/air-time-reminders.module.js';
import { ClientAreaModule } from './features/client-area/client-area.module.js';
import { HealthModule } from './features/health/health.module.js';
import { ListenerInstallsModule } from './features/listener-installs/listener-installs.module.js';
import { ListenerAccountsModule } from './features/listener-accounts/listener-accounts.module.js';
import { ListenerStationsModule } from './features/listener-stations/listener-stations.module.js';
import { MembersModule } from './features/members/members.module.js';
import { NotificationsModule } from './features/notifications/notifications.module.js';
import { RecognitionModule } from './features/recognition/recognition.module.js';
import { EngagementsModule } from './features/engagements/engagements.module.js';
import { RecognitionReportsModule } from './features/recognition-reports/recognition-reports.module.js';
import { RegistrationModule } from './features/registration/registration.module.js';
import { StationOverviewModule } from './features/station-overview/station-overview.module.js';
import { StationsModule } from './features/stations/stations.module.js';
import { AdminDatabaseModule } from './infrastructure/admin-database/admin-database.module.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { JobQueuesModule } from './infrastructure/job-queues/job-queues.module.js';
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
    AdminDatabaseModule,
    KeyValueStoreModule,
    ObjectStorageModule,
    JobQueuesModule,
    SecurityModule,
    ClockModule,
    RateLimitingModule,
    AuditModule,
    ListenerAuthenticationModule,
    // SMS and email for sign-up, review and the team (phase 5a).
    NotificationsModule,
    // Features. AuthenticationModule also installs the guard that makes every route private by default.
    AuthenticationModule,
    HealthModule,
    StationsModule,
    // Station sign-up and the super-admin console (phase 5a).
    RegistrationModule,
    AdminModule,
    MembersModule,
    ClientsModule,
    ClientViewersModule,
    ClientAreaModule,
    AirTimeRemindersModule,
    AdsModule,
    ActionCardsModule,
    AdHistoryModule,
    CampaignsModule,
    StationOverviewModule,
    ClientErrorsModule,
    // The listener app (Step 3; the "My station" list and "Report this" from P4).
    ListenerInstallsModule,
    // Listener accounts (ADR-005): an email proved by a code, a gender and an age.
    ListenerAccountsModule,
    RecognitionModule,
    ListenerStationsModule,
    RecognitionReportsModule,
    EngagementsModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
