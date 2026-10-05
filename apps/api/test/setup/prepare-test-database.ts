import { createDatabaseRoles } from '../../scripts/create-database-roles.js';
import { loadDatabaseSetupConfig } from '../../scripts/database-setup-config.js';
import { prepareObjectStorage } from '../../scripts/prepare-object-storage.js';
import { runMigrations } from '../../scripts/run-migrations.js';

/** Bring the test database to the current schema and the object storage bucket into shape, once, before any test file runs. */
export default async function prepareTestDatabase(): Promise<void> {
  const { setupUrl, rolePasswords } = loadDatabaseSetupConfig();
  await createDatabaseRoles(setupUrl, rolePasswords);
  await runMigrations(setupUrl);
  await prepareObjectStorage();
}
