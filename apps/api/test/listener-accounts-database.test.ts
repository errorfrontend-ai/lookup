import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseSetupClient, lookupApiClient } from './support/database-clients.js';

/**
 * The listener accounts in the database (migration ListenerAccounts; ADR-005, ADR-002): what the API's login can and
 * cannot do with the accounts, independent of API code, and what each function guarantees. A leaked or misused API
 * login must not be able to read an email, change an age or link an install to somebody's account.
 */
describe('listener accounts in the database', () => {
  let setupClient: pg.Client;
  let apiClient: pg.Client;
  const installIds: string[] = [];
  const accountIds: string[] = [];

  const newInstall = async () => {
    const id = randomUUID();
    installIds.push(id);
    await setupClient.query(`INSERT INTO app.listener_installs (id, install_id_hash, platform, app_version) VALUES ($1, $2, 'ANDROID', '1.0.0')`, [id, randomBytes(32)]);
    return id;
  };
  const insertAccount = async (changes: { emailHash?: Buffer; gender?: string; birthYear?: number } = {}) => {
    const id = randomUUID();
    accountIds.push(id);
    await setupClient.query(
      `INSERT INTO app.listener_accounts (id, email_hash, email_sealed, gender, birth_year, consent_text_version) VALUES ($1, $2, $3, $4, $5, 'listener-consent-2026-10')`,
      [id, changes.emailHash ?? randomBytes(32), randomBytes(40), changes.gender ?? 'FEMALE', changes.birthYear ?? 1990],
    );
    return id;
  };
  const expectRefused = async (sql: string, parameters: unknown[] = [], reason = /permission denied/) => {
    await apiClient.query('BEGIN');
    try {
      await expect(apiClient.query(sql, parameters)).rejects.toThrow(reason);
    } finally {
      await apiClient.query('ROLLBACK');
    }
  };
  const asApi = async <Result>(work: () => Promise<Result>): Promise<Result> => {
    await apiClient.query('BEGIN');
    try {
      return await work();
    } finally {
      await apiClient.query('ROLLBACK');
    }
  };

  beforeAll(async () => {
    setupClient = databaseSetupClient();
    apiClient = lookupApiClient();
    await setupClient.connect();
    await apiClient.connect();
  });
  afterAll(async () => {
    await setupClient.query('DELETE FROM app.audit_events WHERE entity_id = ANY($1)', [accountIds]);
    await setupClient.query('DELETE FROM app.listener_installs WHERE id = ANY($1)', [installIds]);
    await setupClient.query('DELETE FROM app.listener_accounts WHERE id = ANY($1)', [accountIds]);
    await apiClient.end();
    await setupClient.end();
  });

  describe('the table', () => {
    it('LA-DATABASE-01: has row-level security on, no policy, and no privilege of any kind for the API roles', async () => {
      const table = (await setupClient.query(`SELECT relrowsecurity, (SELECT count(*)::int FROM pg_policy WHERE polrelid = 'app.listener_accounts'::regclass) AS policies FROM pg_class WHERE oid = 'app.listener_accounts'::regclass`)).rows[0];
      expect(table).toEqual({ relrowsecurity: true, policies: 0 });
      const grants = await setupClient.query(
        `SELECT role_name || ' ' || privilege AS grant_description
           FROM unnest(ARRAY['lookup_api', 'lookup_admin_api', 'lookup_fingerprint_worker']) AS role_name,
                unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS privilege
          WHERE has_table_privilege(role_name, 'app.listener_accounts', privilege)`,
      );
      expect(grants.rows).toEqual([]);
      const columnGrants = await setupClient.query(
        `SELECT role_name || ' ' || privilege || ' ' || attname AS grant_description
           FROM pg_attribute, unnest(ARRAY['lookup_api', 'lookup_admin_api']) AS role_name, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) AS privilege
          WHERE attrelid = 'app.listener_accounts'::regclass AND attnum > 0 AND NOT attisdropped
            AND has_column_privilege(role_name, attrelid, attnum, privilege)`,
      );
      expect(columnGrants.rows).toEqual([]);
    });

    it.each([
      ['read', 'SELECT * FROM app.listener_accounts'],
      ['read the email hash alone', 'SELECT email_hash FROM app.listener_accounts'],
      ['count', 'SELECT count(*) FROM app.listener_accounts'],
      ['insert', `INSERT INTO app.listener_accounts (email_hash, email_sealed, gender, birth_year, consent_text_version) VALUES ('\\x00', '\\x00', 'MALE', 1990, 'x')`],
      ['change an age', 'UPDATE app.listener_accounts SET birth_year = 1950'],
      ['erase', 'DELETE FROM app.listener_accounts'],
      ['empty', 'TRUNCATE app.listener_accounts'],
    ])('LA-DATABASE-01: as the API role, to %s the accounts is refused', async (_what, sql) => {
      await expectRefused(sql);
    });

    it('LA-DATABASE-01: refuses a gender that is not offered, a birth year outside 1900–2100, an email hash of the wrong length and a sealed email that cannot be one', async () => {
      const insert = (changes: { gender?: string; birthYear?: number; emailHash?: Buffer; sealed?: Buffer }) =>
        setupClient.query(
          `INSERT INTO app.listener_accounts (id, email_hash, email_sealed, gender, birth_year, consent_text_version) VALUES ($1, $2, $3, $4, $5, 'x')`,
          [randomUUID(), changes.emailHash ?? randomBytes(32), changes.sealed ?? randomBytes(40), changes.gender ?? 'MALE', changes.birthYear ?? 1990],
        );
      await expect(insert({ gender: 'UNKNOWN' })).rejects.toThrow(/listener_accounts_gender_check/);
      await expect(insert({ birthYear: 1899 })).rejects.toThrow(/listener_accounts_birth_year_check/);
      await expect(insert({ birthYear: 2101 })).rejects.toThrow(/listener_accounts_birth_year_check/);
      await expect(insert({ emailHash: randomBytes(31) })).rejects.toThrow(/listener_accounts_email_hash_length_check/);
      await expect(insert({ sealed: randomBytes(10) })).rejects.toThrow(/listener_accounts_email_sealed_length_check/);
      const hash = randomBytes(32);
      accountIds.push(await insertAccount({ emailHash: hash }));
      await expect(insert({ emailHash: hash })).rejects.toThrow(/listener_accounts_email_hash_unique/);
    });
  });

  describe('the link from an install', () => {
    it('LA-DATABASE-02: the API role can read an install’s account id (the guard needs it) but cannot write it by update or by insert', async () => {
      const installId = await newInstall();
      const accountId = await insertAccount();
      const readable = await asApi(() => apiClient.query('SELECT listener_account_id FROM app.listener_installs WHERE id = $1', [installId]));
      expect(readable.rows).toEqual([{ listener_account_id: null }]);
      await expectRefused('UPDATE app.listener_installs SET listener_account_id = $2 WHERE id = $1', [installId, accountId]);
      await expectRefused(
        `INSERT INTO app.listener_installs (install_id_hash, platform, app_version, listener_account_id) VALUES ($1, 'ANDROID', '1.0.0', $2)`,
        [randomBytes(32), accountId],
      );
    });

    it('LA-DATABASE-02: the registration’s own insert and its update on conflict still work for the API role', async () => {
      const hash = randomBytes(32);
      const first = await apiClient.query(
        `INSERT INTO app.listener_installs (install_id_hash, platform, app_version, last_seen_at) VALUES ($1, 'ANDROID', '1.0.0', now())
         ON CONFLICT (install_id_hash) DO UPDATE SET app_version = EXCLUDED.app_version, last_seen_at = now() RETURNING id, status`,
        [hash],
      );
      installIds.push(first.rows[0].id as string);
      const again = await apiClient.query(
        `INSERT INTO app.listener_installs (install_id_hash, platform, app_version, last_seen_at) VALUES ($1, 'ANDROID', '1.0.1', now())
         ON CONFLICT (install_id_hash) DO UPDATE SET app_version = EXCLUDED.app_version, last_seen_at = now() RETURNING id, status`,
        [hash],
      );
      expect(again.rows[0]).toEqual(first.rows[0]);
    });

    it('LA-DATABASE-02: the foreign key is indexed, and erasing an account unlinks its installs', async () => {
      const index = await setupClient.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'listener_installs_listener_account_id_index'`);
      expect(index.rows).toHaveLength(1);
      const installId = await newInstall();
      const accountId = await insertAccount();
      await setupClient.query('UPDATE app.listener_installs SET listener_account_id = $2 WHERE id = $1', [installId, accountId]);
      await setupClient.query('DELETE FROM app.listener_accounts WHERE id = $1', [accountId]);
      expect((await setupClient.query('SELECT listener_account_id FROM app.listener_installs WHERE id = $1', [installId])).rows[0].listener_account_id).toBeNull();
    });
  });

  describe('the functions', () => {
    const API_FUNCTIONS: Array<[string, string]> = [
      ['app.link_listener_install_to_existing_account(uuid, bytea)', 'text'],
      ['app.create_listener_account_and_link_install(uuid, uuid, bytea, bytea, text, smallint, text, text)', 'text'],
      ['app.unlink_listener_install_from_account(uuid)', 'text'],
      ['app.delete_listener_account_of_install(uuid, text)', 'text'],
      ['app.describe_listener_account_of_install(uuid)', 'TABLE(listener_account_id uuid, email_sealed bytea)'],
      ['recognition.find_received_at_of_own_recognition(uuid, uuid)', 'timestamp with time zone'],
      // Who is listening (LA-STATS): counts only, for the current station.
      ['app.read_listener_mix_for_station(integer)', 'TABLE(first_day text, last_day text, known_listeners integer, not_known_yet_listeners integer, genders jsonb, age_bands jsonb)'],
      ['app.read_listener_mix_for_ad(uuid, integer)', 'TABLE(first_day text, last_day text, known_listeners integer, not_known_yet_listeners integer, genders jsonb, age_bands jsonb)'],
    ];
    const describeFunction = async (signature: string) =>
      (
        await setupClient.query(
          `SELECT prosecdef AS is_security_definer, proconfig AS settings, pg_get_function_result(oid) AS result, pg_get_userbyid(proowner) AS owner,
                  array_remove(ARRAY[CASE WHEN has_function_privilege('lookup_api', oid, 'EXECUTE') THEN 'lookup_api' END,
                                     CASE WHEN has_function_privilege('lookup_admin_api', oid, 'EXECUTE') THEN 'lookup_admin_api' END,
                                     CASE WHEN has_function_privilege('lookup_fingerprint_worker', oid, 'EXECUTE') THEN 'lookup_fingerprint_worker' END,
                                     CASE WHEN has_function_privilege('public', oid, 'EXECUTE') THEN 'public' END], NULL) AS callers
             FROM pg_proc WHERE oid = $1::regprocedure`,
          [signature],
        )
      ).rows[0] as { is_security_definer: boolean; settings: string[]; result: string; owner: string; callers: string[] };

    it.each(API_FUNCTIONS)('LA-DATABASE-03: %s is a definer function owned by the schema owner, with its search path pinned, run only by the API role, returning what it documents', async (signature, result) => {
      expect(await describeFunction(signature)).toEqual({
        is_security_definer: true,
        settings: [expect.stringMatching(/^search_path=pg_catalog, .*pg_temp$/)],
        result,
        owner: 'lookup_schema_owner',
        callers: ['lookup_api'],
      });
    });

    it('linking to an existing account: NO_ACCOUNT, LINKED, ALREADY_LINKED, LINKED_TO_ANOTHER_ACCOUNT and NO_INSTALL', async () => {
      const emailHash = randomBytes(32);
      const installId = await newInstall();
      const call = (install: string, hash: Buffer) => apiClient.query('SELECT app.link_listener_install_to_existing_account($1, $2) AS outcome', [install, hash]);
      expect((await call(installId, emailHash)).rows[0].outcome).toBe('NO_ACCOUNT');
      const accountId = await insertAccount({ emailHash });
      expect((await call(installId, emailHash)).rows[0].outcome).toBe('LINKED');
      expect((await setupClient.query('SELECT listener_account_id FROM app.listener_installs WHERE id = $1', [installId])).rows[0].listener_account_id).toBe(accountId);
      expect((await setupClient.query('SELECT last_signed_in_at IS NOT NULL AS has_signed_in FROM app.listener_accounts WHERE id = $1', [accountId])).rows[0].has_signed_in).toBe(true);
      expect((await call(installId, emailHash)).rows[0].outcome).toBe('ALREADY_LINKED');
      const otherHash = randomBytes(32);
      await insertAccount({ emailHash: otherHash });
      expect((await call(installId, otherHash)).rows[0].outcome).toBe('LINKED_TO_ANOTHER_ACCOUNT');
      expect((await call(randomUUID(), emailHash)).rows[0].outcome).toBe('NO_INSTALL');
    });

    it('creating: CREATED stores what was given and writes an audit row without it; the same email again links; an install with another account is refused and nothing is stored', async () => {
      const call = (accountId: string, install: string, hash: Buffer, gender = 'MALE', birthYear = 1985) =>
        apiClient.query(`SELECT app.create_listener_account_and_link_install($1, $2, $3, $4, $5, $6::smallint, 'listener-consent-2026-10', 'request-1') AS outcome`, [accountId, install, hash, randomBytes(40), gender, birthYear]);
      const emailHash = randomBytes(32);
      const firstInstall = await newInstall();
      const accountId = randomUUID();
      accountIds.push(accountId);
      expect((await call(accountId, firstInstall, emailHash)).rows[0].outcome).toBe('CREATED');
      expect((await setupClient.query('SELECT gender, birth_year, consent_text_version FROM app.listener_accounts WHERE id = $1', [accountId])).rows[0]).toEqual({
        gender: 'MALE',
        birth_year: 1985,
        consent_text_version: 'listener-consent-2026-10',
      });
      const audit = await setupClient.query('SELECT action, entity_type, changes, request_id FROM app.audit_events WHERE entity_id = $1', [accountId]);
      expect(audit.rows).toEqual([{ action: 'listener_account_created', entity_type: 'listener_account', changes: null, request_id: 'request-1' }]);

      const secondInstall = await newInstall();
      const second = randomUUID();
      expect((await call(second, secondInstall, emailHash, 'FEMALE', 2000)).rows[0].outcome).toBe('LINKED_EXISTING');
      expect((await setupClient.query('SELECT listener_account_id FROM app.listener_installs WHERE id = $1', [secondInstall])).rows[0].listener_account_id).toBe(accountId);
      expect((await setupClient.query('SELECT count(*)::int AS accounts FROM app.listener_accounts WHERE id = $1', [second])).rows[0].accounts).toBe(0);
      expect((await call(randomUUID(), secondInstall, emailHash)).rows[0].outcome).toBe('ALREADY_LINKED');

      const someoneElsesPhone = await newInstall();
      const mine = randomUUID();
      accountIds.push(mine);
      await call(mine, someoneElsesPhone, randomBytes(32));
      const refusedId = randomUUID();
      expect((await call(refusedId, someoneElsesPhone, randomBytes(32))).rows[0].outcome).toBe('LINKED_TO_ANOTHER_ACCOUNT');
      expect((await setupClient.query('SELECT count(*)::int AS accounts FROM app.listener_accounts WHERE id = $1', [refusedId])).rows[0].accounts).toBe(0);
      expect((await call(randomUUID(), randomUUID(), randomBytes(32))).rows[0].outcome).toBe('NO_INSTALL');
    });

    it('unlinking and deleting', async () => {
      const installId = await newInstall();
      const accountId = await insertAccount();
      await setupClient.query('UPDATE app.listener_installs SET listener_account_id = $2 WHERE id = $1', [installId, accountId]);
      expect((await apiClient.query('SELECT app.unlink_listener_install_from_account($1) AS outcome', [installId])).rows[0].outcome).toBe('UNLINKED');
      expect((await apiClient.query('SELECT app.unlink_listener_install_from_account($1) AS outcome', [installId])).rows[0].outcome).toBe('NOT_LINKED');
      expect((await apiClient.query('SELECT app.delete_listener_account_of_install($1, $2) AS outcome', [installId, 'request-2'])).rows[0].outcome).toBe('NO_ACCOUNT');
      await setupClient.query('UPDATE app.listener_installs SET listener_account_id = $2 WHERE id = $1', [installId, accountId]);
      expect((await apiClient.query('SELECT app.delete_listener_account_of_install($1, $2) AS outcome', [installId, 'request-2'])).rows[0].outcome).toBe('DELETED');
      expect((await setupClient.query('SELECT count(*)::int AS accounts FROM app.listener_accounts WHERE id = $1', [accountId])).rows[0].accounts).toBe(0);
    });

    it('describing an install’s account returns the sealed email only for the install’s own account', async () => {
      const installId = await newInstall();
      const otherInstall = await newInstall();
      const accountId = await insertAccount();
      await setupClient.query('UPDATE app.listener_installs SET listener_account_id = $2 WHERE id = $1', [installId, accountId]);
      const own = await apiClient.query('SELECT * FROM app.describe_listener_account_of_install($1)', [installId]);
      expect(own.rows).toEqual([{ listener_account_id: accountId, email_sealed: expect.any(Buffer) }]);
      expect((await apiClient.query('SELECT * FROM app.describe_listener_account_of_install($1)', [otherInstall])).rows).toEqual([]);
    });
  });
});
