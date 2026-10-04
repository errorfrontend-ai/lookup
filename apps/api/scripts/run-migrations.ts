/**
 * Apply (or revert the latest) database migrations as lookup_schema_owner, so every table is
 * owned by a role nothing logs in as. A separate step from starting the API — on Render it runs as
 * the pre-deploy command; the API itself never changes the schema.
 *
 *   npm run database:migrate    apply pending migrations
 *   npm run database:revert     revert the latest one
 */
import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import { DataSource } from 'typeorm';
import { ALL_MIGRATIONS } from '../src/infrastructure/database/migrations/all-migrations.js';
import { loadDatabaseSetupConfig } from './database-setup-config.js';

export async function runMigrations(setupUrl: string, options: { revertLatest?: boolean } = {}): Promise<string[]> {
  const dataSource = new DataSource({
    type: 'postgres',
    url: setupUrl,
    schema: 'app',
    migrations: ALL_MIGRATIONS,
    migrationsTableName: 'migrations',
    migrationsTransactionMode: 'each',
    installExtensions: false,
    applicationName: 'lookup-database-migrations',
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
