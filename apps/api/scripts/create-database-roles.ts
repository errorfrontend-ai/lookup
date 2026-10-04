/**
 * Create (or update) the database roles and schemas. Runs with a connection that may create
 * roles: the local Docker superuser, or the managed database's admin user at deploy time.
 *
 *   lookup_schema_owner        cannot log in; owns every table; migrations run as it
 *   lookup_api                 the API (row-level security applies)
 *   lookup_admin_api           super-admin endpoints (policies grant it everything; still not an owner)
 *   lookup_fingerprint_worker  the fingerprint worker (fingerprints schema only)
 *
 * Schemas: app (business data), fingerprints (audio fingerprint store), recognition (matching functions).
 *
 *   npm run database:create-roles   (reads DATABASE_SETUP_URL and the *_DATABASE_PASSWORD variables)
 */
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { type ApplicationRolePasswords, loadDatabaseSetupConfig } from './database-setup-config.js';

const LOGIN_ROLE_ATTRIBUTES = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT';
const OWNER_ROLE_ATTRIBUTES = 'NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS';
const SCHEMAS = ['app', 'fingerprints', 'recognition'];

/**
 * Server-side limits per role, so a runaway query or a transaction left open by a bug can't
 * hold locks or connections indefinitely, even if a client forgets its own timeouts.
 * The worker gets longer limits: storing an ad's fingerprints is one large insert.
 */
const ROLE_TIME_LIMITS: Record<keyof ApplicationRolePasswords, { statement: string; lockWait: string; idleInTransaction: string }> = {
  lookup_api: { statement: '5s', lockWait: '3s', idleInTransaction: '15s' },
  lookup_admin_api: { statement: '15s', lockWait: '5s', idleInTransaction: '30s' },
  lookup_fingerprint_worker: { statement: '60s', lockWait: '10s', idleInTransaction: '60s' },
};

const SEARCH_PATH_BY_ROLE: Record<keyof ApplicationRolePasswords, string> = {
  lookup_api: 'app',
  lookup_admin_api: 'app',
  lookup_fingerprint_worker: 'fingerprints, app',
};

export async function createDatabaseRoles(setupUrl: string, rolePasswords: ApplicationRolePasswords): Promise<void> {
  const client = new pg.Client({ connectionString: setupUrl, application_name: 'lookup-database-roles' });
  await client.connect();
  try {
    const databaseName: string = (await client.query('SELECT current_database() AS name')).rows[0].name;
    await client.query('BEGIN');

    const createOrUpdateRole = async (roleName: string, attributes: string, password?: string) => {
      const roleExists = ((await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName])).rowCount ?? 0) > 0;
      const passwordClause = password ? ` PASSWORD ${client.escapeLiteral(password)}` : '';
      await client.query(`${roleExists ? 'ALTER' : 'CREATE'} ROLE ${client.escapeIdentifier(roleName)} ${attributes}${passwordClause}`);
    };
    await createOrUpdateRole('lookup_schema_owner', OWNER_ROLE_ATTRIBUTES);
    for (const [roleName, password] of Object.entries(rolePasswords)) {
      await createOrUpdateRole(roleName, LOGIN_ROLE_ATTRIBUTES, password);
    }

    const database = client.escapeIdentifier(databaseName);
    const applicationRoles = Object.keys(rolePasswords).map((roleName) => client.escapeIdentifier(roleName)).join(', ');
    // Nobody connects or creates temporary tables by default; each role is granted what it needs.
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await client.query(`GRANT CREATE, CONNECT ON DATABASE ${database} TO lookup_schema_owner`);
    await client.query(`GRANT CONNECT ON DATABASE ${database} TO ${applicationRoles}`);
    for (const schema of SCHEMAS) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${client.escapeIdentifier(schema)} AUTHORIZATION lookup_schema_owner`);
    }

    for (const roleName of Object.keys(rolePasswords) as Array<keyof ApplicationRolePasswords>) {
      const role = client.escapeIdentifier(roleName);
      const limits = ROLE_TIME_LIMITS[roleName];
      await client.query(`ALTER ROLE ${role} SET search_path = ${SEARCH_PATH_BY_ROLE[roleName]}`);
      await client.query(`ALTER ROLE ${role} SET statement_timeout = ${client.escapeLiteral(limits.statement)}`);
      await client.query(`ALTER ROLE ${role} SET lock_timeout = ${client.escapeLiteral(limits.lockWait)}`);
      await client.query(
        `ALTER ROLE ${role} SET idle_in_transaction_session_timeout = ${client.escapeLiteral(limits.idleInTransaction)}`,
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { setupUrl, rolePasswords } = loadDatabaseSetupConfig();
  createDatabaseRoles(setupUrl, rolePasswords)
    .then(() => console.log('Database roles and schemas are ready.'))
    .catch((error: unknown) => {
      console.error('Could not create database roles:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
