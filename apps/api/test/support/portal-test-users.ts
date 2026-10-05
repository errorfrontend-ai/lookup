import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type supertest from 'supertest';
import type { PasswordHasher } from '../../src/features/authentication/password-hasher.js';

export const PORTAL_ORIGIN = 'http://localhost:5180';

export interface PortalTestUser {
  userId: string;
  email: string;
  password: string;
  stationId: string;
}

/**
 * Creates a station and an ACTIVE portal user who owns it, with a real argon2id hash of the given
 * password (made by the application's own hasher). Everything it creates is tracked for cleanUp().
 */
export class PortalTestUsers {
  private readonly createdUserIds: string[] = [];
  private readonly createdStationIds: string[] = [];

  constructor(
    private readonly setupClient: pg.Client,
    private readonly passwordHasher: PasswordHasher,
  ) {}

  async create(options: { password?: string; fullName?: string; role?: 'OWNER' | 'MANAGER' | 'ANALYST' } = {}): Promise<PortalTestUser> {
    const runTag = randomUUID().slice(0, 8);
    const password = options.password ?? `quiet river ${runTag} morning tea`;
    const userId = randomUUID();
    const stationId = randomUUID();
    const email = `portal-${runTag}@example.test`;
    await this.setupClient.query(
      `INSERT INTO app.stations (id, name, frequency_label, status) VALUES ($1, $2, '98.1 FM', 'ACTIVE')`,
      [stationId, `Test Station ${runTag}`],
    );
    await this.setupClient.query(
      `INSERT INTO app.portal_users (id, email, password_hash, full_name) VALUES ($1, $2, $3, $4)`,
      [userId, email, await this.passwordHasher.hashNewPassword(password), options.fullName ?? 'Pat Tester'],
    );
    await this.setupClient.query(`INSERT INTO app.station_memberships (station_id, portal_user_id, role) VALUES ($1, $2, $3)`, [
      stationId,
      userId,
      options.role ?? 'OWNER',
    ]);
    this.createdUserIds.push(userId);
    this.createdStationIds.push(stationId);
    return { userId, email, password, stationId };
  }

  async cleanUp(): Promise<void> {
    await this.setupClient.query('DELETE FROM app.station_memberships WHERE station_id = ANY($1)', [this.createdStationIds]);
    await this.setupClient.query('DELETE FROM app.portal_users WHERE id = ANY($1)', [this.createdUserIds]);
    await this.setupClient.query('DELETE FROM app.audit_events WHERE station_id = ANY($1)', [this.createdStationIds]);
    await this.setupClient.query('DELETE FROM app.stations WHERE id = ANY($1)', [this.createdStationIds]);
  }
}

/** Cookies a response set, by name. A cookie being cleared (empty value) is reported as ''. */
export function cookiesSetBy(response: supertest.Response): Record<string, string> {
  const setCookieHeaders = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
  return Object.fromEntries(
    setCookieHeaders.map((header) => {
      const [nameAndValue] = header.split(';');
      const separatorIndex = (nameAndValue as string).indexOf('=');
      return [(nameAndValue as string).slice(0, separatorIndex), (nameAndValue as string).slice(separatorIndex + 1)];
    }),
  );
}

/** The full Set-Cookie line for one cookie, to check its attributes. */
export function setCookieLine(response: supertest.Response, cookieName: string): string | undefined {
  return ([] as string[]).concat(response.headers['set-cookie'] ?? []).find((header) => header.startsWith(`${cookieName}=`));
}

export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}
