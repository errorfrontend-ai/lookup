/**
 * Enrols a super admin, or gives one a new second factor (P5A design §5.4; gap 12; P5A-D19). No web route can do
 * either, so a stolen session can never enrol a second factor for someone else.
 *
 *   SUPER_ADMIN_EMAIL=… SUPER_ADMIN_FULL_NAME=… SUPER_ADMIN_PASSWORD=… npm run admin:create-super-admin
 *   SUPER_ADMIN_EMAIL=… npm run admin:create-super-admin -- --reset-two-factor
 *
 * The details come from the environment, never from arguments, which would stay in the shell's history. It prints the
 * authenticator address and the secret once, and nowhere else: scan the address into the authenticator app, then
 * clear the terminal. A reset also ends every session of that super admin. Connects with DATABASE_SETUP_URL, as the
 * migration and role scripts do.
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  EmailAddress,
  encodeBase32,
  FullName,
  TWO_FACTOR_SECRET_BYTES,
  twoFactorEnrolmentAddress,
} from '@lookup/contracts';
import pg from 'pg';
import { TwoFactorSecretBox } from '../src/common/security/two-factor-secret-box.js';
import { normalizeEmail } from '../src/features/authentication/authentication.service.js';
import { PasswordHasher } from '../src/features/authentication/password-hasher.js';
import { PasswordPolicy } from '../src/features/authentication/password-policy.js';
import { loadDatabaseSetupConfig, setupConnectionTls } from './database-setup-config.js';

export class SuperAdminProblem extends Error {}

export interface SuperAdminEnrolment {
  portalUserId: string;
  /** The otpauth:// address an authenticator app reads. */
  enrolmentAddress: string;
  /** The same secret in base32, for an app that is typed into. */
  secretBase32: string;
}

/**
 * Creates (or updates) the super admin and gives them a new second-factor secret: a random one, or (the development
 * seed only) the one given, so a local authenticator app and the browser tests keep working across re-seeds.
 */
export async function createSuperAdmin(
  setupUrl: string,
  details: { email: string; fullName: string; password: string },
  encryptionSecret: string,
  secret: Uint8Array = randomBytes(TWO_FACTOR_SECRET_BYTES),
): Promise<SuperAdminEnrolment> {
  const email = EmailAddress.safeParse(details.email);
  const fullName = FullName.safeParse(details.fullName);
  if (!email.success) throw new SuperAdminProblem('SUPER_ADMIN_EMAIL is not an email address.');
  if (!fullName.success) throw new SuperAdminProblem('SUPER_ADMIN_FULL_NAME must be 1 to 120 characters.');
  const normalizedEmail = normalizeEmail(email.data);
  const refusal = new PasswordPolicy().check(details.password, { fullName: fullName.data, email: normalizedEmail, stationNames: [] });
  if (refusal) throw new SuperAdminProblem(`SUPER_ADMIN_PASSWORD is not acceptable: ${refusal}`);
  const passwordHash = await new PasswordHasher().hashNewPassword(details.password);

  return withSetupClient(setupUrl, async (client) => {
    const user = await client.query(
      `INSERT INTO app.portal_users (email, password_hash, full_name, platform_role) VALUES ($1, $2, $3, 'SUPER_ADMIN')
       ON CONFLICT (email) DO UPDATE SET password_hash = excluded.password_hash, full_name = excluded.full_name,
                                         platform_role = 'SUPER_ADMIN', status = 'ACTIVE', password_changed_at = now()
       RETURNING id`,
      [normalizedEmail, passwordHash, fullName.data],
    );
    const portalUserId = user.rows[0].id as string;
    return enrol(client, portalUserId, normalizedEmail, encryptionSecret, 'super_admin_enrolled', secret);
  });
}

/** A new second-factor secret for an existing super admin, whose sessions all end. */
export async function resetSuperAdminTwoFactor(setupUrl: string, email: string, encryptionSecret: string): Promise<SuperAdminEnrolment> {
  const normalizedEmail = normalizeEmail(email);
  return withSetupClient(setupUrl, async (client) => {
    const user = await client.query(`SELECT id FROM app.portal_users WHERE email = $1 AND platform_role = 'SUPER_ADMIN' FOR UPDATE`, [normalizedEmail]);
    if (user.rowCount === 0) throw new SuperAdminProblem('No super admin has that email.');
    const portalUserId = user.rows[0].id as string;
    await client.query(
      `UPDATE app.portal_sessions SET revoked_at = now(), revocation_reason = 'TWO_FACTOR_RESET'
        WHERE portal_user_id = $1 AND revoked_at IS NULL`,
      [portalUserId],
    );
    return enrol(client, portalUserId, normalizedEmail, encryptionSecret, 'two_factor_reset', randomBytes(TWO_FACTOR_SECRET_BYTES));
  });
}

async function enrol(
  client: pg.Client,
  portalUserId: string,
  email: string,
  encryptionSecret: string,
  action: string,
  secret: Uint8Array,
): Promise<SuperAdminEnrolment> {
  await client.query(
    `UPDATE app.portal_users
        SET two_factor_secret_ciphertext = $2, two_factor_enrolled_at = now(), two_factor_last_used_time_step = NULL
      WHERE id = $1`,
    [portalUserId, new TwoFactorSecretBox(encryptionSecret).seal(portalUserId, secret)],
  );
  await client.query(
    `INSERT INTO app.audit_events (actor_portal_user_id, action, entity_type, entity_id, request_id) VALUES (NULL, $1, 'portal_user', $2, 'operator-command')`,
    [action, portalUserId],
  );
  return { portalUserId, enrolmentAddress: twoFactorEnrolmentAddress(email, secret), secretBase32: encodeBase32(secret) };
}

async function withSetupClient<Result>(setupUrl: string, work: (client: pg.Client) => Promise<Result>): Promise<Result> {
  const client = new pg.Client({ connectionString: setupUrl, application_name: 'lookup-create-super-admin', ssl: setupConnectionTls() });
  await client.connect();
  try {
    await client.query('BEGIN');
    // The tables belong to the schema owner. A managed database's admin user (Render) is no superuser: it may only
    // switch to the owner (granted by create-database-roles), so it writes as the owner, for this transaction only.
    await client.query('SET LOCAL ROLE lookup_schema_owner');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (problem) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw problem;
  } finally {
    await client.end();
  }
}

/**
 * Why the command failed, for the operator running it in their own terminal (the private side, like a log line):
 * the kind of error, its code and its message, with any password in an address hidden, and cut to one short line.
 */
export function describeForOperator(problem: unknown): string {
  if (!(problem instanceof Error)) return 'an unknown error';
  const code = (problem as { code?: unknown }).code;
  const message = problem.message.replace(/\/\/[^\s/@]*@/g, '//…@').replace(/\s+/g, ' ').slice(0, 300);
  return `${problem.name}${typeof code === 'string' ? ` ${code}` : ''}: ${message}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const environmentFile = new URL('../.env', import.meta.url);
  try {
    process.loadEnvFile(environmentFile);
  } catch {
    // Real environment variables are used when there is no .env file (deploys).
  }
  const isReset = process.argv.includes('--reset-two-factor');
  const unknown = process.argv.slice(2).filter((argument) => argument !== '--reset-two-factor');
  const run = async () => {
    if (unknown.length > 0) throw new SuperAdminProblem('The only option is --reset-two-factor; details come from the environment.');
    const encryptionSecret = process.env.TWO_FACTOR_ENCRYPTION_SECRET ?? '';
    if (!/^[A-Za-z0-9_-]{43,}$/.test(encryptionSecret) || encryptionSecret.includes('CHANGE_ME')) {
      throw new SuperAdminProblem('TWO_FACTOR_ENCRYPTION_SECRET must be set to a random value first.');
    }
    const { setupUrl } = loadDatabaseSetupConfig();
    const email = process.env.SUPER_ADMIN_EMAIL ?? '';
    return isReset
      ? resetSuperAdminTwoFactor(setupUrl, email, encryptionSecret)
      : createSuperAdmin(setupUrl, { email, fullName: process.env.SUPER_ADMIN_FULL_NAME ?? '', password: process.env.SUPER_ADMIN_PASSWORD ?? '' }, encryptionSecret);
  };
  run()
    .then((enrolment) => {
      console.log(isReset ? 'A new second factor is ready, and every session of this super admin has ended.' : 'The super admin is ready.');
      console.log('Add it to the authenticator app now; it is shown only this once:');
      console.log(enrolment.enrolmentAddress);
      console.log(`Secret, to type in instead: ${enrolment.secretBase32}`);
    })
    .catch((problem: unknown) => {
      console.error(problem instanceof SuperAdminProblem ? problem.message : `Could not enrol the super admin: ${describeForOperator(problem)}`);
      process.exit(1);
    });
}
