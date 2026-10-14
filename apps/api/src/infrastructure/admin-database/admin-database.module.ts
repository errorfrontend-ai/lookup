import { Global, Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm';
import { ClsService } from 'nestjs-cls';
import type { DataSource, EntityManager } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { lookupDataSourceOptions } from '../database/data-source-options.js';
import { assertDatabaseRoleIsRestricted, type QueryRunnerLike } from '../database/database-role-check.js';

/** The name of the super-admin data source, for @InjectDataSource. */
export const ADMIN_DATA_SOURCE = 'admin';

/**
 * The super-admin endpoints' connection, as lookup_admin_api (P5A design §3.1): it sees every station through its
 * full-access policies, so only features/admin uses it (the source scan holds that). It refuses to start as anything
 * but lookup_admin_api, with the same checks as the API's own connection.
 */
export async function assertDatabaseRoleIsTheAdminRole(database: QueryRunnerLike): Promise<void> {
  await assertDatabaseRoleIsRestricted(database);
  const rows = (await database.query('SELECT current_user AS role_name')) as Array<{ role_name: string }>;
  if (rows[0]?.role_name !== 'lookup_admin_api') {
    throw new Error(`Refusing to start: the admin database address must connect as lookup_admin_api (role=${rows[0]?.role_name ?? 'unknown'}).`);
  }
}

/**
 * The only way the admin feature touches the database: one transaction that first sets the super admin as the
 * current user (and the station worked on, if any), so the audit rows it writes name them.
 */
@Injectable()
export class AdminTransaction {
  constructor(
    @InjectDataSource(ADMIN_DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly requestContext: ClsService,
  ) {}

  run<Result>(work: (database: EntityManager) => Promise<Result>, scope: { stationId?: string } = {}): Promise<Result> {
    const userId = this.requestContext.get<string | undefined>('userId') ?? '';
    return this.dataSource.transaction(async (database) => {
      await database.query(
        `SELECT set_config('app.current_station_id', $1, true), set_config('app.current_user_id', $2, true)`,
        [scope.stationId ?? '', userId],
      );
      return work(database);
    });
  }
}

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: ADMIN_DATA_SOURCE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        ...lookupDataSourceOptions({ url: config.ADMIN_DATABASE_URL, applicationName: 'lookup-api-admin', tlsMode: config.DATABASE_TLS_MODE }),
        name: ADMIN_DATA_SOURCE,
        retryAttempts: 3,
        retryDelay: 2_000,
        // Few super admins: a small pool, so the admin console can never take the API's connections.
        extra: { statement_timeout: 15_000, max: 3 },
      }),
    }),
  ],
  providers: [AdminTransaction],
  exports: [AdminTransaction],
})
export class AdminDatabaseModule implements OnApplicationBootstrap {
  constructor(@InjectDataSource(ADMIN_DATA_SOURCE) private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    await assertDatabaseRoleIsTheAdminRole(this.dataSource);
  }
}
