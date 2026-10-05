import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseSetupClient } from './support/database-clients.js';

/**
 * Facts about the migrated database read from the system catalogue: names, owners, roles, row-level
 * security, constraints and indexes. Each test names the requirement it proves (docs/requirements-checklist.md).
 */
const OUR_SCHEMAS = ['app', 'fingerprints', 'recognition'];
const LOGIN_ROLES = ['lookup_api', 'lookup_admin_api', 'lookup_fingerprint_worker'];
const SCHEMA_OWNER = 'lookup_schema_owner';
const STATION_OWNED_TABLES = ['action_cards', 'ads', 'campaign_time_windows', 'campaigns', 'clients', 'station_memberships'];
/** Tables with no row-level security, each for a stated reason. */
const TABLES_WITHOUT_ROW_LEVEL_SECURITY: Record<string, string> = {
  'app.listener_installs': 'global (no station); reached only through SECURITY DEFINER recognition functions',
  'app.migrations': 'TypeORM bookkeeping; no service role has any grant on it',
  'fingerprints.audio_assets': 'global, shared across stations; no grant to either API role',
  'fingerprints.hashes_version_1': 'global, shared across stations; no grant to either API role',
};

describe('database catalogue', () => {
  let client: pg.Client;
  const rows = async <Row>(sql: string, parameters: unknown[] = []) => (await client.query(sql, parameters)).rows as Row[];

  beforeAll(async () => {
    client = databaseSetupClient();
    await client.connect();
  });
  afterAll(async () => client.end());

  describe('names', () => {
    it('S1-NAMING-01, S1-NAMING-02, S1-MIGRATIONS-06: schemas app, fingerprints and recognition exist, owned by the schema owner; fp and recog do not', async () => {
      const schemas = await rows<{ nspname: string; owner: string }>(
        `SELECT nspname, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = ANY($1)`,
        [[...OUR_SCHEMAS, 'fp', 'recog']],
      );
      expect(schemas.map((schema) => schema.nspname).sort()).toEqual([...OUR_SCHEMAS].sort());
      for (const schema of schemas) expect(schema.owner).toBe(SCHEMA_OWNER);
    });

    it('S1-NAMING-03: exactly the four Look Up roles exist; the earlier names do not', async () => {
      const roles = await rows<{ rolname: string }>(
        `SELECT rolname FROM pg_roles WHERE rolname LIKE 'lookup\\_%' OR rolname IN ('app_api', 'app_admin', 'app_fp', 'lookup_owner') ORDER BY rolname`,
      );
      expect(roles.map((role) => role.rolname)).toEqual(['lookup_admin_api', 'lookup_api', 'lookup_fingerprint_worker', 'lookup_schema_owner']);
    });

    it('S1-NAMING-05, S1-MIGRATIONS-10: the slice tables exist under their domain names; the blueprint names do not', async () => {
      const tables = await rows<{ table_name: string }>(
        `SELECT relnamespace::regnamespace || '.' || relname AS table_name FROM pg_class
          WHERE relnamespace = ANY($1::regnamespace[]) AND relkind IN ('r', 'p') AND NOT relispartition`,
        [OUR_SCHEMAS],
      );
      const tableNames = tables.map((table) => table.table_name);
      for (const expected of [
        'app.stations', 'app.portal_users', 'app.station_memberships', 'app.refresh_tokens', 'app.clients', 'app.action_cards',
        'app.ads', 'app.campaigns', 'app.campaign_time_windows', 'fingerprints.audio_assets', 'fingerprints.hashes_version_1',
        'app.listener_installs', 'app.recognition_events', 'app.audit_events',
      ]) {
        expect(tableNames).toContain(expected);
      }
      for (const blueprintName of ['tenants', 'media_items', 'actionable_payloads', 'campaign_schedules', 'recognition_logs', 'fingerprints']) {
        expect(tableNames.some((name) => name.endsWith(`.${blueprintName}`))).toBe(false);
      }
    });

    it('S1-NAMING-06: no column is named with a reserved SQL word', async () => {
      const offenders = await rows<{ column_name: string }>(
        `SELECT attrelid::regclass || '.' || attname AS column_name
           FROM pg_attribute JOIN pg_class ON pg_class.oid = attrelid
          WHERE relnamespace = ANY($1::regnamespace[]) AND attnum > 0 AND NOT attisdropped
            AND attname IN (SELECT word FROM pg_get_keywords() WHERE catcode = 'R')`,
        [OUR_SCHEMAS],
      );
      expect(offenders).toEqual([]);
    });

    it('S1-NAMING-07: every constraint has a readable name ending in its kind (no generated _pkey, _fkey or PK_ names)', async () => {
      const offenders = await rows<{ constraint_name: string }>(
        `SELECT conrelid::regclass || ': ' || conname AS constraint_name FROM pg_constraint
          WHERE connamespace = ANY($1::regnamespace[])
            AND conname !~ '_(primary_key|foreign_key|unique|check|exclusion)$'`,
        [OUR_SCHEMAS],
      );
      expect(offenders).toEqual([]);
    });
  });

  describe('roles', () => {
    it('S1-ROLES-02, S1-ROLES-05, S1-ROLES-06, S1-ROLES-07, S1-ROLES-04: the owner cannot sign in; service roles can, with no superuser, no BYPASSRLS, no role or database creation', async () => {
      const roles = await rows<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>(
        `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname LIKE 'lookup\\_%'`,
      );
      for (const role of roles) {
        expect(role, role.rolname).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
        expect(role.rolcanlogin, role.rolname).toBe(role.rolname !== SCHEMA_OWNER);
      }
      expect(roles).toHaveLength(4);
    });

    it.each([
      ['S1-ROLES-09, S1-ROLES-10', 'lookup_api', ['search_path=app', 'statement_timeout=5s', 'lock_timeout=3s', 'idle_in_transaction_session_timeout=15s']],
      ['S1-ROLES-09, S1-ROLES-11', 'lookup_admin_api', ['search_path=app', 'statement_timeout=15s', 'lock_timeout=5s', 'idle_in_transaction_session_timeout=30s']],
      ['S1-ROLES-09, S1-ROLES-12', 'lookup_fingerprint_worker', ['search_path=fingerprints, app', 'statement_timeout=60s', 'lock_timeout=10s', 'idle_in_transaction_session_timeout=60s']],
    ])('%s: %s has a fixed search path and server-side time limits', async (_requirements, roleName, expectedSettings) => {
      const [role] = await rows<{ rolconfig: string[] }>(`SELECT rolconfig FROM pg_roles WHERE rolname = $1`, [roleName]);
      expect([...(role?.rolconfig ?? [])].sort()).toEqual([...expectedSettings].sort());
    });

    it('S1-ROLES-02, S1-MIGRATIONS-01, S1-MIGRATIONS-03: the schema owner owns every table, index, sequence and function (apart from extension members, which Postgres gives to the installing superuser)', async () => {
      const otherOwners = await rows<{ object_name: string; owner: string }>(
        `SELECT relnamespace::regnamespace || '.' || relname AS object_name, pg_get_userbyid(relowner) AS owner
           FROM pg_class WHERE relnamespace = ANY($1::regnamespace[]) AND relowner <> $2::regrole
         UNION ALL
         SELECT proc.oid::regprocedure::text, pg_get_userbyid(proowner)
           FROM pg_proc AS proc
          WHERE pronamespace = ANY($1::regnamespace[]) AND proowner <> $2::regrole
            AND NOT EXISTS (SELECT 1 FROM pg_depend WHERE objid = proc.oid AND deptype = 'e')`,
        [OUR_SCHEMAS, SCHEMA_OWNER],
      );
      expect(otherOwners).toEqual([]);
    });

    it('S1-ROLES-05: service roles own nothing at all', async () => {
      const owned = await rows<{ object_name: string }>(
        `SELECT relname AS object_name FROM pg_class WHERE relowner = ANY($1::regrole[])
         UNION ALL SELECT proname FROM pg_proc WHERE proowner = ANY($1::regrole[])
         UNION ALL SELECT nspname FROM pg_namespace WHERE nspowner = ANY($1::regrole[])
         UNION ALL SELECT typname FROM pg_type WHERE typowner = ANY($1::regrole[])`,
        [LOGIN_ROLES],
      );
      expect(owned).toEqual([]);
    });

    it('S1-MIGRATIONS-02: no service role can create anything in any schema or in the database', async () => {
      const grants = await rows<{ role_name: string; target: string }>(
        `SELECT role_name, 'schema ' || nspname AS target
           FROM unnest($1::text[]) AS role_name, pg_namespace
          WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' AND has_schema_privilege(role_name, pg_namespace.oid, 'CREATE')
         UNION ALL
         SELECT role_name, 'database' FROM unnest($1::text[]) AS role_name WHERE has_database_privilege(role_name, current_database(), 'CREATE')`,
        [LOGIN_ROLES],
      );
      expect(grants).toEqual([]);
    });

    it('S1-ROLES-05: every station table has an explicit full-access policy for the super-admin role', async () => {
      for (const tableName of [...STATION_OWNED_TABLES, 'stations', 'portal_users', 'audit_events', 'recognition_events']) {
        const policies = await rows<{ polname: string; roles: string[] }>(
          `SELECT polname, ARRAY(SELECT rolname::text FROM pg_roles WHERE oid = ANY(polroles)) AS roles FROM pg_policy WHERE polrelid = $1::regclass`,
          [`app.${tableName}`],
        );
        expect(policies.find((policy) => policy.polname === `${tableName}_admin_full_access`)?.roles, tableName).toEqual(['lookup_admin_api']);
      }
    });
  });

  describe('extensions and ids', () => {
    it('S1-MIGRATIONS-07, S1-MIGRATIONS-08, S1-MIGRATIONS-09: citext and btree_gist are installed, uuid-ossp is not, and ids default to gen_random_uuid()', async () => {
      const extensions = (await rows<{ extname: string }>(`SELECT extname FROM pg_extension`)).map((extension) => extension.extname);
      expect(extensions).toEqual(expect.arrayContaining(['citext', 'btree_gist']));
      expect(extensions).not.toContain('uuid-ossp');
      const idDefaults = await rows<{ table_name: string; column_default: string }>(
        `SELECT table_schema || '.' || table_name AS table_name, column_default FROM information_schema.columns
          WHERE column_name = 'id' AND table_schema = ANY($1) AND table_name NOT IN ('migrations', 'recognition_events', 'audit_events')
            AND table_name NOT LIKE 'recognition\\_events\\_%'`,
        [OUR_SCHEMAS],
      );
      expect(idDefaults.length).toBeGreaterThan(5);
      for (const column of idDefaults) expect(column.column_default, column.table_name).toBe('gen_random_uuid()');
    });
  });

  describe('row-level security', () => {
    it('S1-ISOLATION-04: row-level security is on for every table except the listed global ones, and every table with a station has a station policy', async () => {
      const tables = await rows<{ table_name: string; relrowsecurity: boolean; has_station: boolean; station_policy_count: number }>(
        `SELECT relnamespace::regnamespace || '.' || relname AS table_name, relrowsecurity,
                EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = pg_class.oid AND attname = 'station_id' AND NOT attisdropped) AS has_station,
                (SELECT count(*)::int FROM pg_policy WHERE polrelid = pg_class.oid
                   AND (pg_get_expr(polqual, polrelid) LIKE '%current_station_id()%' OR pg_get_expr(polwithcheck, polrelid) LIKE '%current_station_id()%')) AS station_policy_count
           FROM pg_class WHERE relnamespace = ANY($1::regnamespace[]) AND relkind IN ('r', 'p') AND NOT relispartition`,
        [OUR_SCHEMAS],
      );
      for (const table of tables) {
        expect(table.relrowsecurity, table.table_name).toBe(!(table.table_name in TABLES_WITHOUT_ROW_LEVEL_SECURITY));
        if (table.has_station) expect(table.station_policy_count, table.table_name).toBeGreaterThan(0);
      }
    });

    it('S1-ISOLATION-15: every station-owned table has a mandatory station_id', async () => {
      for (const tableName of STATION_OWNED_TABLES) {
        const [column] = await rows<{ attnotnull: boolean }>(
          `SELECT attnotnull FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'station_id' AND NOT attisdropped`,
          [`app.${tableName}`],
        );
        expect(column?.attnotnull, tableName).toBe(true);
      }
    });

    it('S1-PRIVILEGES-11: the API roles hold no privilege of any kind on the fingerprints schema or its tables', async () => {
      const grants = await rows<{ grant_description: string }>(
        `SELECT role_name || ' ' || privilege || ' on ' || target AS grant_description
           FROM unnest(ARRAY['lookup_api', 'lookup_admin_api']) AS role_name,
                unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS privilege,
                unnest(ARRAY['fingerprints.audio_assets', 'fingerprints.hashes_version_1']) AS target
          WHERE has_table_privilege(role_name, target, privilege)
         UNION ALL
         SELECT role_name || ' USAGE on schema fingerprints' FROM unnest(ARRAY['lookup_api', 'lookup_admin_api']) AS role_name
          WHERE has_schema_privilege(role_name, 'fingerprints', 'USAGE')`,
      );
      expect(grants).toEqual([]);
    });
  });

  describe('indexes and partitions', () => {
    it('every foreign key has an index led by its first column, so changing a referenced row never scans the referencing table', async () => {
      const unindexed = await rows<{ foreign_key: string }>(
        `SELECT conrelid::regclass || ': ' || conname AS foreign_key FROM pg_constraint AS constraint_entry
          WHERE contype = 'f' AND connamespace = ANY($1::regnamespace[])
            AND NOT EXISTS (SELECT 1 FROM pg_index WHERE indrelid = constraint_entry.conrelid AND indkey[0] = constraint_entry.conkey[1])`,
        [OUR_SCHEMAS],
      );
      expect(unindexed).toEqual([]);
    });

    it('S1-SCALING-06: recognition idempotency keys live in a small unpartitioned table keyed by install and idempotency key', async () => {
      const [table] = await rows<{ relkind: string; key_columns: string }>(
        `SELECT relkind::text, pg_get_constraintdef(constraint_entry.oid) AS key_columns
           FROM pg_class JOIN pg_constraint AS constraint_entry ON constraint_entry.conrelid = pg_class.oid AND contype = 'p'
          WHERE pg_class.oid = 'app.recognition_idempotency_keys'::regclass`,
      );
      expect(table).toEqual({ relkind: 'r', key_columns: 'PRIMARY KEY (listener_install_id, idempotency_key)' });
    });

    it('S1-SCALING-07: recognition events have a block-range index on arrival time and a station and capture-time index', async () => {
      const indexes = (await rows<{ definition: string }>(
        `SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid = 'app.recognition_events'::regclass`,
      )).map((index) => index.definition);
      expect(indexes).toContainEqual(expect.stringMatching(/USING brin \(received_at\)/));
      expect(indexes).toContainEqual(expect.stringMatching(/USING btree \(station_id, captured_at\)/));
    });

    it('a partition created later gets readable index and constraint names derived from its parent', async () => {
      await client.query('BEGIN');
      try {
        await client.query('SELECT app.create_recognition_event_partitions(9)');
        const partitionIndexes = await rows<{ index_name: string; partition_name: string }>(
          `SELECT indexrelid::regclass::text AS index_name, indrelid::regclass::text AS partition_name
             FROM pg_index JOIN pg_inherits ON pg_inherits.inhrelid = pg_index.indrelid
            WHERE pg_inherits.inhparent = 'app.recognition_events'::regclass`,
        );
        expect(partitionIndexes.length).toBeGreaterThan(0);
        for (const index of partitionIndexes) {
          expect(index.index_name.startsWith(`${index.partition_name}_`), index.index_name).toBe(true);
          expect(index.index_name).toMatch(/_(primary_key|index)$/);
        }
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });
});
