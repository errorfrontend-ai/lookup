import { Global, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { assertDatabaseRoleIsRestricted } from './database-role-check.js';
import { RecognitionEventPartitions } from './recognition-event-partitions.js';
import { StationScopedTransaction } from './station-scoped-transaction.js';

/**
 * The API's database connection, as the restricted lookup_api role. Schema changes never happen
 * here: migrations run as a separate step (npm run database:migrate) under the schema owner role.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        type: 'postgres' as const,
        url: config.DATABASE_URL,
        applicationName: 'lookup-api',
        entities: [],
        synchronize: false,
        migrationsRun: false,
        installExtensions: false,
        retryAttempts: 3,
        retryDelay: 2_000,
        ssl: config.DATABASE_TLS_MODE === 'disable' ? false : { rejectUnauthorized: config.DATABASE_TLS_MODE === 'verify-full' },
        extra: { statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MILLISECONDS, max: 10 },
        logging: false,
      }),
    }),
  ],
  providers: [StationScopedTransaction, RecognitionEventPartitions],
  exports: [StationScopedTransaction],
})
export class DatabaseModule implements OnApplicationBootstrap {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    await assertDatabaseRoleIsRestricted(this.dataSource);
  }
}
