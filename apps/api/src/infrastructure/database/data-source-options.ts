import type { DataSourceOptions } from 'typeorm';
import type { DatabaseTlsMode } from '../../config/app-config.js';
import { ALL_MIGRATIONS } from './migrations/all-migrations.js';

type PostgresConnectionOptions = Extract<DataSourceOptions, { type: 'postgres' }>;

/**
 * The one definition of how Look Up connects to Postgres, shared by the running API and the
 * migration script. They differ only in who connects (the URL: lookup_api, or the setup login that
 * acts as lookup_schema_owner) and in what each adds on top: the API its pool size and timeouts,
 * the migration script its schema owner role.
 *
 * Neither ever changes the schema implicitly: no synchronising, no migrations at start-up, no
 * extension installs. Migrations run only when the migration script is asked to.
 */
export function lookupDataSourceOptions(connection: { url: string; applicationName: string; tlsMode: DatabaseTlsMode }): PostgresConnectionOptions {
  return {
    type: 'postgres',
    url: connection.url,
    applicationName: connection.applicationName,
    // `require` encrypts the connection; `verify-full` also checks the server's certificate.
    ssl: connection.tlsMode === 'disable' ? false : { rejectUnauthorized: connection.tlsMode === 'verify-full' },
    entities: [],
    migrations: ALL_MIGRATIONS,
    migrationsTableName: 'migrations',
    synchronize: false,
    migrationsRun: false,
    installExtensions: false,
    logging: false,
  };
}
