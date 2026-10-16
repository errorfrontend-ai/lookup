import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Passwords for the roles the applications log in as. */
export interface ApplicationRolePasswords {
  lookup_api: string;
  lookup_admin_api: string;
  lookup_fingerprint_worker: string;
}

export interface DatabaseSetupConfig {
  /** A connection allowed to create roles and run migrations (local superuser, or the managed database's admin). */
  setupUrl: string;
  rolePasswords: ApplicationRolePasswords;
}

const MINIMUM_PASSWORD_LENGTH = 16;
const TLS_MODES = ['disable', 'require', 'verify-full'] as const;

/**
 * How the setup scripts encrypt their connection, from DATABASE_TLS_MODE exactly as the API reads it: a managed
 * database reached over its public address refuses an unencrypted one (`require`, or `verify-full` to check its
 * certificate too); the local Docker database has none (`disable`, the default).
 */
export function setupConnectionTls(): false | { rejectUnauthorized: boolean } {
  const mode = process.env.DATABASE_TLS_MODE ?? 'disable';
  if (!(TLS_MODES as readonly string[]).includes(mode)) throw new Error(`DATABASE_TLS_MODE must be one of: ${TLS_MODES.join(', ')}`);
  return mode === 'disable' ? false : { rejectUnauthorized: mode === 'verify-full' };
}

/**
 * Configuration for the setup scripts only (roles and migrations), read from apps/api/.env
 * locally or from real environment variables in CI and deploys. The running API never sees
 * DATABASE_SETUP_URL.
 */
export function loadDatabaseSetupConfig(): DatabaseSetupConfig {
  const environmentFile = resolve(import.meta.dirname, '..', '.env');
  if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);

  const passwordVariables = {
    lookup_api: 'LOOKUP_API_DATABASE_PASSWORD',
    lookup_admin_api: 'LOOKUP_ADMIN_API_DATABASE_PASSWORD',
    lookup_fingerprint_worker: 'LOOKUP_FINGERPRINT_WORKER_DATABASE_PASSWORD',
  } as const;
  const requiredVariables = ['DATABASE_SETUP_URL', ...Object.values(passwordVariables)];
  const missingVariables = requiredVariables.filter((name) => !process.env[name]);
  if (missingVariables.length) throw new Error(`Missing configuration: ${missingVariables.join(', ')}`);
  const weakPasswords = Object.values(passwordVariables).filter(
    (name) => (process.env[name] as string).length < MINIMUM_PASSWORD_LENGTH,
  );
  if (weakPasswords.length) {
    throw new Error(`Passwords must be at least ${MINIMUM_PASSWORD_LENGTH} characters: ${weakPasswords.join(', ')}`);
  }

  return {
    setupUrl: process.env.DATABASE_SETUP_URL as string,
    rolePasswords: {
      lookup_api: process.env[passwordVariables.lookup_api] as string,
      lookup_admin_api: process.env[passwordVariables.lookup_admin_api] as string,
      lookup_fingerprint_worker: process.env[passwordVariables.lookup_fingerprint_worker] as string,
    },
  };
}
