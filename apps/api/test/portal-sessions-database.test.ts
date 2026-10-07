import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asLookupApi, databaseSetupClient, lookupApiClient } from './support/database-clients.js';

/**
 * The sign-in and session functions, called exactly as the API calls them (as lookup_api). The
 * password hashes here are well-formed strings; the database only compares them, so real argon2
 * hashing is exercised in the HTTP tests instead.
 */
const STORED_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$c3RvcmVkLWhhc2gtZm9yLXRoZS10ZXN0LXVzZXI';
const STORED_HASH_SETTINGS = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$';
const WRONG_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$d3JvbmctaGFzaC1mb3ItdGhlLXRlc3QtdXNlcg';
const REPLACEMENT_HASH = '$argon2id$v=19$m=19456,t=2,p=1$bmV3c2FsdG5ld3NhbHQ$cmVwbGFjZW1lbnQtaGFzaC1uZXctcGFyYW1ldGVycw';

describe('sign-in and session functions', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await setupClient.connect();
    await apiClient.connect();
  });
  afterEach(async () => {
    await setupClient.query('DELETE FROM app.portal_users WHERE id = ANY($1)', [createdUserIds.splice(0)]);
  });
  afterAll(async () => {
    await apiClient.end();
    await setupClient.end();
  });

  async function createUser(options: { status?: 'ACTIVE' | 'DISABLED' } = {}) {
    const userId = randomUUID();
    const email = `Session.Test.${userId.slice(0, 8)}@Example.test`;
    await setupClient.query(
      `INSERT INTO app.portal_users (id, email, password_hash, full_name, status) VALUES ($1, $2, $3, 'Session Test', $4)`,
      [userId, email, STORED_HASH, options.status ?? 'ACTIVE'],
    );
    createdUserIds.push(userId);
    return { userId, email };
  }

  const newTokenHash = () => randomBytes(32);

  async function signIn(email: string, computedHash: string, replacementHash: string | null = null) {
    const tokenHash = newTokenHash();
    const result = await apiClient.query(
      'SELECT * FROM app.sign_in_portal_user($1, $2, $3, $4, $5)',
      [email, computedHash, tokenHash, replacementHash, `request-${randomUUID()}`],
    );
    return { ...result.rows[0], tokenHash } as {
      outcome: string; portal_user_id: string | null; portal_session_id: string | null; refresh_token_expires_at: Date | null; tokenHash: Buffer;
    };
  }

  async function rotate(presentedTokenHash: Buffer) {
    const newHash = newTokenHash();
    const result = await apiClient.query('SELECT * FROM app.rotate_portal_refresh_token($1, $2, $3)', [
      presentedTokenHash, newHash, `request-${randomUUID()}`,
    ]);
    return { ...result.rows[0], tokenHash: newHash } as { outcome: string; portal_session_id: string | null; tokenHash: Buffer };
  }

  async function activeSessionOwner(portalSessionId: string): Promise<string | null> {
    return (await apiClient.query('SELECT app.find_active_portal_session($1) AS owner', [portalSessionId])).rows[0].owner;
  }

  async function auditActions(userId: string): Promise<string[]> {
    const result = await setupClient.query(
      'SELECT action FROM app.audit_events WHERE actor_portal_user_id = $1 ORDER BY id', [userId],
    );
    return result.rows.map((row) => row.action);
  }

  describe('privileges', () => {
    it('the API role cannot read sessions or refresh tokens directly', async () => {
      await expect(apiClient.query('SELECT 1 FROM app.portal_sessions LIMIT 1')).rejects.toThrow(/permission denied/);
      await expect(apiClient.query('SELECT 1 FROM app.refresh_tokens LIMIT 1')).rejects.toThrow(/permission denied/);
    });

    it('only lookup_api may call the sign-in functions; the internal helpers are callable by nobody', async () => {
      const result = await setupClient.query(`
        SELECT stored_function.proname AS function_name,
               has_function_privilege('lookup_api', stored_function.oid, 'EXECUTE') AS api,
               has_function_privilege('lookup_admin_api', stored_function.oid, 'EXECUTE') AS admin_api,
               has_function_privilege('lookup_fingerprint_worker', stored_function.oid, 'EXECUTE') AS fingerprint_worker
          FROM pg_proc AS stored_function JOIN pg_namespace AS function_schema ON function_schema.oid = stored_function.pronamespace
         WHERE function_schema.nspname = 'app'
           AND stored_function.proname IN ('find_password_hash_settings', 'sign_in_portal_user', 'rotate_portal_refresh_token',
             'end_portal_session', 'find_active_portal_session', 'change_portal_user_password', 'delete_expired_portal_sessions',
             'issue_portal_session', 'is_sign_in_backstop_active')
         ORDER BY 1`);
      const internalHelpers = new Set(['issue_portal_session', 'is_sign_in_backstop_active']);
      expect(result.rows).toHaveLength(9);
      for (const row of result.rows) {
        expect({ name: row.function_name, api: row.api }).toEqual({ name: row.function_name, api: !internalHelpers.has(row.function_name) });
        expect(row.admin_api).toBe(false);
        expect(row.fingerprint_worker).toBe(false);
      }
    });

    it('every SECURITY DEFINER function pins its search path with pg_catalog first and pg_temp last', async () => {
      const result = await setupClient.query(`
        SELECT function_schema.nspname || '.' || stored_function.proname AS function_name, stored_function.proconfig AS settings
          FROM pg_proc AS stored_function JOIN pg_namespace AS function_schema ON function_schema.oid = stored_function.pronamespace
         WHERE function_schema.nspname IN ('app', 'fingerprints', 'recognition') AND stored_function.prosecdef`);
      expect(result.rows.length).toBeGreaterThanOrEqual(8);
      for (const row of result.rows) {
        const searchPath = (row.settings as string[] | null)?.find((setting) => setting.startsWith('search_path='));
        expect({ name: row.function_name, searchPath }).toEqual({
          name: row.function_name,
          searchPath: expect.stringMatching(/^search_path="?pg_catalog.*pg_temp"?$/),
        });
      }
    });

    it('stored hashes must be argon2id in the standard format', async () => {
      await expect(
        setupClient.query(`INSERT INTO app.portal_users (email, password_hash, full_name) VALUES ($1, 'plain text', 'X')`, [
          `bad-${randomUUID()}@example.test`,
        ]),
      ).rejects.toThrow(/portal_users_password_hash_check/);
    });
  });

  describe('hash settings', () => {
    it('returns the algorithm, parameters and salt, never the hash itself; email matches without regard to case', async () => {
      const { email } = await createUser();
      const settings = (await apiClient.query('SELECT app.find_password_hash_settings($1) AS settings', [email.toLowerCase()])).rows[0]
        .settings;
      expect(settings).toBe(STORED_HASH_SETTINGS);
      expect(STORED_HASH.startsWith(settings)).toBe(true);
      expect(settings.length).toBeLessThan(STORED_HASH.length);
    });

    it('returns nothing for an unknown email or a disabled account', async () => {
      const { email } = await createUser({ status: 'DISABLED' });
      for (const lookedUpEmail of [email, `nobody-${randomUUID()}@example.test`]) {
        const settings = (await apiClient.query('SELECT app.find_password_hash_settings($1) AS settings', [lookedUpEmail])).rows[0].settings;
        expect(settings).toBeNull();
      }
    });
  });

  describe('signing in', () => {
    it('a wrong hash is refused, counted and audited', async () => {
      const { userId, email } = await createUser();
      expect((await signIn(email, WRONG_HASH)).outcome).toBe('INVALID_CREDENTIALS');
      const counters = (await setupClient.query('SELECT consecutive_failed_sign_in_count AS failures FROM app.portal_users WHERE id = $1', [userId])).rows[0];
      expect(counters.failures).toBe(1);
      expect(await auditActions(userId)).toEqual(['sign_in_failed']);
    });

    it('the right hash opens a session with a refresh token, resets the counter and is audited', async () => {
      const { userId, email } = await createUser();
      await signIn(email, WRONG_HASH);
      const signedIn = await signIn(email.toUpperCase(), STORED_HASH);
      expect(signedIn.outcome).toBe('SIGNED_IN');
      expect(signedIn.portal_user_id).toBe(userId);
      expect(await activeSessionOwner(signedIn.portal_session_id as string)).toBe(userId);
      const expiresInMilliseconds = (signedIn.refresh_token_expires_at as Date).getTime() - Date.now();
      expect(expiresInMilliseconds).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
      expect(expiresInMilliseconds).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);
      const counters = (await setupClient.query('SELECT consecutive_failed_sign_in_count AS failures FROM app.portal_users WHERE id = $1', [userId])).rows[0];
      expect(counters.failures).toBe(0);
      expect(await auditActions(userId)).toEqual(['sign_in_failed', 'signed_in']);
    });

    it('a disabled account and an unknown email both give the same refusal', async () => {
      const { email } = await createUser({ status: 'DISABLED' });
      expect((await signIn(email, STORED_HASH)).outcome).toBe('INVALID_CREDENTIALS');
      expect((await signIn(`nobody-${randomUUID()}@example.test`, STORED_HASH)).outcome).toBe('INVALID_CREDENTIALS');
    });

    it('applies a re-hash with new parameters only after a successful comparison', async () => {
      const { userId, email } = await createUser();
      await signIn(email, WRONG_HASH, REPLACEMENT_HASH);
      expect((await setupClient.query('SELECT password_hash FROM app.portal_users WHERE id = $1', [userId])).rows[0].password_hash).toBe(STORED_HASH);
      await signIn(email, STORED_HASH, REPLACEMENT_HASH);
      expect((await setupClient.query('SELECT password_hash FROM app.portal_users WHERE id = $1', [userId])).rows[0].password_hash).toBe(REPLACEMENT_HASH);
    });

    it('after 20 straight failures an account gets at most one attempt a minute, even with the right password', async () => {
      const { userId, email } = await createUser();
      await setupClient.query(
        `UPDATE app.portal_users SET consecutive_failed_sign_in_count = 20, last_failed_sign_in_at = now() WHERE id = $1`, [userId],
      );
      expect((await signIn(email, STORED_HASH)).outcome).toBe('THROTTLED');
      await setupClient.query(`UPDATE app.portal_users SET last_failed_sign_in_at = now() - interval '61 seconds' WHERE id = $1`, [userId]);
      expect((await signIn(email, STORED_HASH)).outcome).toBe('SIGNED_IN');
    });

    it('keeps at most 10 live sessions per user, ending the oldest', async () => {
      const { userId, email } = await createUser();
      const sessions = [];
      for (let signInNumber = 0; signInNumber < 11; signInNumber++) sessions.push(await signIn(email, STORED_HASH));
      expect(await activeSessionOwner(sessions[0]?.portal_session_id as string)).toBeNull();
      for (const session of sessions.slice(1)) expect(await activeSessionOwner(session.portal_session_id as string)).toBe(userId);
      const oldest = (await setupClient.query('SELECT revocation_reason FROM app.portal_sessions WHERE id = $1', [sessions[0]?.portal_session_id])).rows[0];
      expect(oldest.revocation_reason).toBe('SESSION_LIMIT_REACHED');
      expect(await auditActions(userId)).toContain('sessions_revoked_by_limit');
    });
  });

  describe('refresh token rotation', () => {
    it('a fresh token rotates, and the new token works too', async () => {
      const { email } = await createUser();
      const signedIn = await signIn(email, STORED_HASH);
      const first = await rotate(signedIn.tokenHash);
      expect(first.outcome).toBe('ROTATED');
      expect(first.portal_session_id).toBe(signedIn.portal_session_id);
      expect((await rotate(first.tokenHash)).outcome).toBe('ROTATED');
    });

    it('within 30 seconds a used token may branch three times in all (lost responses, two tabs); a fourth use ends the session', async () => {
      const { userId, email } = await createUser();
      const signedIn = await signIn(email, STORED_HASH);
      for (let branch = 1; branch <= 3; branch++) expect((await rotate(signedIn.tokenHash)).outcome).toBe('ROTATED');
      expect((await rotate(signedIn.tokenHash)).outcome).toBe('REUSE_DETECTED');
      expect(await activeSessionOwner(signedIn.portal_session_id as string)).toBeNull();
      expect(await auditActions(userId)).toContain('refresh_token_reused');
    });

    it('a used token presented after 31 seconds revokes the whole session, and every token in it dies', async () => {
      const { email } = await createUser();
      const signedIn = await signIn(email, STORED_HASH);
      const rotated = await rotate(signedIn.tokenHash);
      await setupClient.query(`UPDATE app.refresh_tokens SET used_at = now() - interval '31 seconds' WHERE token_hash = $1`, [signedIn.tokenHash]);
      expect((await rotate(signedIn.tokenHash)).outcome).toBe('REUSE_DETECTED');
      expect((await rotate(rotated.tokenHash)).outcome).toBe('INVALID');
      const session = (await setupClient.query('SELECT revocation_reason FROM app.portal_sessions WHERE id = $1', [signedIn.portal_session_id])).rows[0];
      expect(session.revocation_reason).toBe('REFRESH_TOKEN_REUSED');
    });

    it('an unknown, expired or disabled-user token is invalid', async () => {
      const { userId, email } = await createUser();
      expect((await rotate(newTokenHash())).outcome).toBe('INVALID');
      const expiring = await signIn(email, STORED_HASH);
      await setupClient.query(`UPDATE app.refresh_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [expiring.tokenHash]);
      expect((await rotate(expiring.tokenHash)).outcome).toBe('INVALID');
      const beforeDisabling = await signIn(email, STORED_HASH);
      await setupClient.query(`UPDATE app.portal_users SET status = 'DISABLED' WHERE id = $1`, [userId]);
      expect((await rotate(beforeDisabling.tokenHash)).outcome).toBe('INVALID');
      expect(await activeSessionOwner(beforeDisabling.portal_session_id as string)).toBeNull();
    });
  });

  describe('signing out', () => {
    it('ends the session by its refresh token, is audited once, and is safe to repeat', async () => {
      const { userId, email } = await createUser();
      const signedIn = await signIn(email, STORED_HASH);
      for (let attempt = 0; attempt < 2; attempt++) {
        await apiClient.query('SELECT app.end_portal_session(NULL, $1, $2)', [signedIn.tokenHash, `request-${randomUUID()}`]);
      }
      expect(await activeSessionOwner(signedIn.portal_session_id as string)).toBeNull();
      expect((await rotate(signedIn.tokenHash)).outcome).toBe('INVALID');
      expect((await auditActions(userId)).filter((action) => action === 'signed_out')).toHaveLength(1);
    });

    it('ends the session by its id', async () => {
      const { email } = await createUser();
      const signedIn = await signIn(email, STORED_HASH);
      await apiClient.query('SELECT app.end_portal_session($1, NULL, $2)', [signedIn.portal_session_id, `request-${randomUUID()}`]);
      expect(await activeSessionOwner(signedIn.portal_session_id as string)).toBeNull();
    });
  });

  describe('changing the password', () => {
    async function changePassword(portalSessionId: string, currentHash: string) {
      const result = await apiClient.query('SELECT * FROM app.change_portal_user_password($1, $2, $3, $4, $5)', [
        portalSessionId, currentHash, REPLACEMENT_HASH, newTokenHash(), `request-${randomUUID()}`,
      ]);
      return result.rows[0] as { outcome: string; portal_session_id: string | null };
    }

    it('refuses a wrong current password and counts it', async () => {
      const { userId, email } = await createUser();
      const signedIn = await signIn(email, STORED_HASH);
      expect((await changePassword(signedIn.portal_session_id as string, WRONG_HASH)).outcome).toBe('INVALID_CREDENTIALS');
      expect(await auditActions(userId)).toContain('password_change_failed');
      // Counted like a wrong password at sign-in, so guessing through this route also meets the backstop.
      const counted = (await setupClient.query('SELECT consecutive_failed_sign_in_count, last_failed_sign_in_at FROM app.portal_users WHERE id = $1', [userId])).rows[0];
      expect(counted.consecutive_failed_sign_in_count).toBe(1);
      expect(counted.last_failed_sign_in_at).not.toBeNull();
    });

    it('ends every session of the user and opens a fresh one for the caller', async () => {
      const { userId, email } = await createUser();
      const firstDevice = await signIn(email, STORED_HASH);
      const secondDevice = await signIn(email, STORED_HASH);
      const changed = await changePassword(secondDevice.portal_session_id as string, STORED_HASH);
      expect(changed.outcome).toBe('PASSWORD_CHANGED');
      expect(await activeSessionOwner(firstDevice.portal_session_id as string)).toBeNull();
      expect(await activeSessionOwner(secondDevice.portal_session_id as string)).toBeNull();
      expect(await activeSessionOwner(changed.portal_session_id as string)).toBe(userId);
      const stored = (await setupClient.query('SELECT password_hash, password_changed_at FROM app.portal_users WHERE id = $1', [userId])).rows[0];
      expect(stored.password_hash).toBe(REPLACEMENT_HASH);
      expect(stored.password_changed_at).not.toBeNull();
      expect(await auditActions(userId)).toContain('password_changed');
    });

    it('needs a live session', async () => {
      expect((await changePassword(randomUUID(), STORED_HASH)).outcome).toBe('INVALID_SESSION');
    });
  });
});

describe('ad status guard', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  const ids = { station: randomUUID(), client: randomUUID(), ad: randomUUID() };

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await setupClient.connect();
    await apiClient.connect();
    await setupClient.query(`INSERT INTO app.stations (id, name, frequency_label, status) VALUES ($1, 'Guard FM', '90.0 FM', 'ACTIVE')`, [ids.station]);
    await setupClient.query(`INSERT INTO app.clients (id, station_id, name) VALUES ($1, $2, 'Guard client')`, [ids.client, ids.station]);
    await setupClient.query(`INSERT INTO app.ads (id, station_id, client_id, title) VALUES ($1, $2, $3, 'Guard ad')`, [ids.ad, ids.station, ids.client]);
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.ads WHERE station_id = $1', [ids.station]);
    await setupClient.query('DELETE FROM app.clients WHERE station_id = $1', [ids.station]);
    await setupClient.query('DELETE FROM app.stations WHERE id = $1', [ids.station]);
    await apiClient.end();
    await setupClient.end();
  });

  const setStatusAsApi = (status: string) =>
    asLookupApi(apiClient, { stationId: ids.station }, (client) => client.query('UPDATE app.ads SET status = $2 WHERE id = $1', [ids.ad, status]));
  const setStatusAsSetup = (status: string) => setupClient.query('UPDATE app.ads SET status = $2 WHERE id = $1', [ids.ad, status]);

  it('the API may move an ad from awaiting upload to processing or failed', async () => {
    expect((await setStatusAsApi('PROCESSING')).rowCount).toBe(1);
    expect((await setStatusAsApi('FAILED')).rowCount).toBe(1);
  });

  it('the API may never mark an ad READY or NEEDS_REVIEW — only the ingest worker does', async () => {
    await expect(setStatusAsApi('READY')).rejects.toThrow(/cannot change from AWAITING_UPLOAD to READY/);
    await setStatusAsSetup('PROCESSING');
    await expect(setStatusAsApi('READY')).rejects.toThrow(/cannot change from PROCESSING to READY/);
    await expect(setStatusAsApi('NEEDS_REVIEW')).rejects.toThrow(/cannot change/);
  });

  it('a failed upload may start again', async () => {
    await setStatusAsSetup('FAILED');
    expect((await setStatusAsApi('AWAITING_UPLOAD')).rowCount).toBe(1);
  });
});
