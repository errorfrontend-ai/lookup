/**
 * Apply (or revert the latest) database migrations as lookup_schema_owner, so every table is
 * owned by a role nothing logs in as. A separate step from starting the API — on Render it runs as
 * the pre-deploy command; the API itself never changes the schema.
 *
 *   npm run database:migrate          apply pending migrations
 *   npm run database:revert-latest    revert the latest one
 *
 * DATABASE_TLS_MODE (disable, require, verify-full) applies here exactly as it does to the API.
 */
import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import { DataSource } from 'typeorm';
import { DATABASE_TLS_MODES, type DatabaseTlsMode } from '../src/config/app-config.js';
import { lookupDataSourceOptions } from '../src/infrastructure/database/data-source-options.js';
import { loadDatabaseSetupConfig } from './database-setup-config.js';

export async function runMigrations(setupUrl: string, options: { revertLatest?: boolean } = {}): Promise<string[]> {
  const tlsMode = (process.env.DATABASE_TLS_MODE ?? 'disable') as DatabaseTlsMode;
  if (!DATABASE_TLS_MODES.includes(tlsMode)) throw new Error(`DATABASE_TLS_MODE must be one of: ${DATABASE_TLS_MODES.join(', ')}`);
  const dataSource = new DataSource({
    ...lookupDataSourceOptions({ url: setupUrl, applicationName: 'lookup-database-migrations', tlsMode }),
    schema: 'app',
    migrationsTransactionMode: 'each',
    // Every object created is owned by the schema owner, not by the login that ran the script.
    extra: { options: '-c role=lookup_schema_owner' },
    logging: ['error'],
  });
  await dataSource.initialize();
  try {
    if (options.revertLatest) {
      await dataSource.undoLastMigration({ transaction: 'each' });
      return [];
    }
    return (await dataSource.runMigrations({ transaction: 'each' })).map((migration) => migration.name);
  } finally {
    await dataSource.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const revertLatest = process.argv.includes('--revert-latest');
  runMigrations(loadDatabaseSetupConfig().setupUrl, { revertLatest })
    .then((appliedMigrations) =>
      console.log(
        revertLatest
          ? 'Reverted the latest migration.'
          : appliedMigrations.length
            ? `Applied: ${appliedMigrations.join(', ')}`
            : 'Database is up to date.',
      ),
    )
    .catch((error: unknown) => {
      console.error('Migration failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
